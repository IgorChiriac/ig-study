"""Ingesting reference documentation once, so cards are cheap thereafter.

The first version of this fetched the page on every generation. For a single
page that is merely wasteful; for something like the DynamoDB developer guide,
where the point is to work through two hundred pages and come back repeatedly,
it is the whole cost of the feature paid over and over on text that never
changed.

So fetching and generating are separated. An **ingest** pays once to pull a
page's text out of the `web_fetch` tool result and store it. Every generation
after that reads stored text: no fetch, no per-run variance in how much of the
page came back, and the text is stable enough to sit behind a prompt-cache
breakpoint, which a tool result cannot.

The extraction relies on `web_fetch_tool_result.content.content.source.data`,
which is where the tool puts the document it retrieved.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app import usage as usage_meter
from app.claude import CARD_MODEL, client

MAX_STORED_CHARS = 700_000
CHARS_PER_TOKEN = 4


@dataclass(slots=True)
class Ingested:
    url: str
    title: str
    text: str

    @property
    def approx_tokens(self) -> int:
        return len(self.text) // CHARS_PER_TOKEN


class ChapterLink(BaseModel):
    title: str = Field(description="The chapter or section title, as written.")
    url: str = Field(description="Absolute URL of the page.")


class Chapters(BaseModel):
    chapters: list[ChapterLink]


def url_key(url: str) -> str:
    """A URL reduced to what identifies the page.

    A fragment picks a heading within a page already fetched whole, and a
    trailing slash is the same path written differently. Comparing raw URLs
    treats those as separate pages, which is how the same chapter got ingested
    twice under two different anchor texts.
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{(parsed.hostname or '').lower()}{path}{query}"


def domains_for(urls: list[str]) -> list[str]:
    hosts: list[str] = []
    for url in urls:
        host = urlparse(url).hostname
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def _fetched_text(response: Any) -> str:
    """Pull the retrieved document out of a web_fetch result.

    Returns the first document found. Empty when the fetch failed -- the tool
    reports failures as an error object in the same position rather than
    raising, so an empty string here means "could not read the page", not
    "the page was empty".
    """
    for block in getattr(response, "content", []):
        if getattr(block, "type", "") != "web_fetch_tool_result":
            continue
        result = getattr(block, "content", None)
        document = getattr(result, "content", None)
        source = getattr(document, "source", None)
        data = getattr(source, "data", None)
        if isinstance(data, str) and data.strip():
            return data
    return ""


def _title_from(text: str, url: str) -> str:
    """A readable name, preferring the page's own metadata over the URL."""
    for line in text.splitlines()[:20]:
        lowered = line.lower()
        for key in ("title:", "meta-title:", "# "):
            if lowered.startswith(key):
                candidate = line[len(key) :].strip().strip("\"'")
                if candidate:
                    return candidate[:120]
    stem = urlparse(url).path.rstrip("/").split("/")[-1]
    return stem.replace(".html", "").replace("-", " ").replace("_", " ")[:120] or url


async def ingest(uid: str, url: str) -> Ingested:
    """Fetch one page and return its text. Paid once per page.

    The model is asked to fetch and say nothing, so this is billed for
    retrieval rather than for reasoning over what came back -- a fetch-only
    call ran to about a third of the tokens a generation does.
    """
    response = (
        await client()
        .with_options(timeout=600.0)
        .messages.create(
            model=CARD_MODEL,
            max_tokens=256,
            tools=[
                {
                    "type": "web_fetch_20260209",
                    "name": "web_fetch",
                    "max_uses": 2,
                    "allowed_domains": domains_for([url]),
                    "max_content_tokens": 100_000,
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": f"Fetch {url}. Do not summarise it. Reply with only the word DONE.",
                }
            ],
        )
    )
    await usage_meter.record_claude(uid, CARD_MODEL, response.usage)

    text = _fetched_text(response)
    if not text:
        raise HTTPException(
            502,
            "Could not read that page. Check the link opens publicly, and prefer a "
            "specific topic page over a landing page.",
        )
    if len(text) > MAX_STORED_CHARS:
        text = text[:MAX_STORED_CHARS]

    return Ingested(url=url, title=_title_from(text, url), text=text)


async def discover(uid: str, url: str, limit: int = 40) -> list[ChapterLink]:
    """List the pages a contents page links to, so ingesting can be aimed.

    Bounded hard, because this is not cheap and is not always worth it. A run
    against the DynamoDB developer guide cost about seven times an ingest and
    came back with inline links from the body prose rather than the guide's
    chapters -- AWS renders its contents tree in a JavaScript sidebar, which
    the fetch does not see. It earns its keep on sites whose contents page is
    real HTML; where it does not, pasting chapter URLs is both cheaper and
    better, and the UI says so.
    """
    response = (
        await client()
        .with_options(timeout=600.0)
        .messages.parse(
            model=CARD_MODEL,
            max_tokens=8000,
            output_format=Chapters,
            output_config={"effort": "low"},
            tools=[
                {
                    "type": "web_fetch_20260209",
                    "name": "web_fetch",
                    "max_uses": 2,
                    "allowed_domains": domains_for([url]),
                    "max_content_tokens": 100_000,
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Fetch {url} and list the documentation pages it links to, in the order "
                        f"they are presented. At most {limit}. Give each one's absolute URL and "
                        "the title as written. Skip navigation, search, legal and feedback links, "
                        "and skip anything on a different site."
                    ),
                }
            ],
        )
    )
    await usage_meter.record_claude(uid, CARD_MODEL, response.usage)

    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(502, "Could not read a chapter list from that page")

    # The model reports a link once per anchor, so a page linked from two
    # places in the prose comes back twice under two different titles. Keeping
    # the first occurrence preserves the guide's own ordering.
    host = urlparse(url).hostname
    seen: set[str] = set()
    chapters: list[ChapterLink] = []
    for chapter in parsed.chapters:
        if urlparse(chapter.url).hostname != host:
            continue
        key = url_key(chapter.url)
        if key in seen:
            continue
        seen.add(key)
        chapters.append(chapter)
    return chapters[:limit]
