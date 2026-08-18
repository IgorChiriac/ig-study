"""Card generation and grading.

Two calls, two models, and they are **different API generations** -- the same
request shape does not work for both:

  * `claude-sonnet-5` writes cards. Thinking is on by default, so `max_tokens`
    has to cover thinking *plus* the JSON or the answer truncates mid-object.
    `output_config.effort` is supported here.
  * `claude-haiku-4-5` grades. `effort` **returns a 400 on this model** -- it
    is not a hint that gets ignored. Thinking stays unset.

Both use structured output, so what comes back is validated JSON rather than
prose that needs parsing. Prompt caching is deliberately absent: the minimum
cacheable prefix on Haiku 4.5 is 4096 tokens and a grading prompt is a few
hundred, so a cache_control marker there would silently do nothing.
"""

from __future__ import annotations

from urllib.parse import urlparse

from anthropic import AsyncAnthropic
from fastapi import HTTPException
from pydantic import BaseModel, Field

from app import usage as usage_meter
from app.config import settings

CARD_MODEL = "claude-sonnet-5"
GRADE_MODEL = "claude-haiku-4-5"

_client: AsyncAnthropic | None = None


class Card(BaseModel):
    q: str = Field(description="The question. Tests understanding, not recall of wording.")
    a: str = Field(description="The answer, 1-3 sentences, precise.")


class Cards(BaseModel):
    cards: list[Card]


class Grade(BaseModel):
    score: int = Field(ge=0, le=5, description="0-5 on understanding, not wording.")
    verdict: str = Field(description="One or two sentences, direct and specific.")
    missing: str = Field(description="What the answer left out. Empty if nothing.")
    correction: str = Field(description="The correction. Empty if the answer was right.")


def _reject_truncated(response: object, what: str) -> None:
    """Refuse output that was cut off mid-generation.

    `max_tokens` caps thinking *plus* response text, and Sonnet 5 thinks by
    default, so a generous-looking budget can still run out partway through the
    JSON. What comes back then is not an error -- it is a half-written object
    whose tail the model fills with junk or the word "placeholder". Silently
    saving those as study cards is far worse than failing.
    """
    if getattr(response, "stop_reason", None) == "max_tokens":
        raise HTTPException(
            502,
            f"{what} ran out of room before finishing. Ask for fewer cards, "
            "or point at a shorter page.",
        )


def client() -> AsyncAnthropic:
    global _client
    if not settings().anthropic_api_key:
        raise HTTPException(503, "ANTHROPIC_API_KEY is not configured")
    if _client is None:
        _client = AsyncAnthropic(api_key=settings().anthropic_api_key)
    return _client


CARD_PROMPT = """Course: {course} · Module: {module} · Lecture: {title}

The student's notes:
---
{note}
---

Write {n} question/answer cards testing *understanding*, not recall of wording.

- Every question must be answerable from these notes alone.
- Prefer "why" and "when would you" over "what is".
- If the notes contain a formula or number, at least one card must require
  applying it to a new case, not restating it.
- Answers: 1-3 sentences, precise.
- Nothing about the video's structure or the instructor."""


GRADE_PROMPT = """Question:          {question}
Reference answer:  {reference}
Student's answer:  {student}

Grade 0-5 on understanding, not wording:
  5 complete and precise
  4 correct, minor imprecision
  3 right idea with a real gap
  2 partially right, core misunderstanding
  1 mostly wrong but on topic
  0 wrong or blank

Be direct and specific. If the method was right and the arithmetic wrong,
say exactly that. Don't soften a 2 into a 3."""


async def generate_cards(
    uid: str, course: str, module: str, title: str, note: str, count: int
) -> Cards:
    """Draft cards from a note. The student approves them before they are saved."""
    if not note.strip():
        raise HTTPException(400, "Write a note first -- cards are generated from it")

    response = await client().messages.parse(
        model=CARD_MODEL,
        max_tokens=8192,
        output_format=Cards,
        output_config={"effort": "medium"},
        messages=[
            {
                "role": "user",
                "content": CARD_PROMPT.format(
                    course=course, module=module or "-", title=title, note=note, n=count
                ),
            }
        ],
    )
    await usage_meter.record_claude(uid, CARD_MODEL, response.usage)
    _reject_truncated(response, "Card generation")
    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(502, "Card generation returned no parsable output")
    return parsed


BLANK_GRADE = Grade(
    score=0,
    verdict="Nothing to grade — the answer was left blank.",
    missing="",
    correction="",
)


async def grade_answer(uid: str, question: str, reference: str, student: str) -> Grade:
    """Score a free-text answer on understanding.

    Answering in your own words and being judged on understanding rather than
    string matching is the entire reason this isn't just Anki, so the prompt
    is explicit that a 2 does not get rounded up to a 3.

    A blank answer is a zero by definition, so it short-circuits: the model
    cannot tell you anything the rubric does not already say, and grading is
    the recurring cost in this app rather than a one-off.
    """
    if not student.strip():
        return BLANK_GRADE

    response = await client().messages.parse(
        model=GRADE_MODEL,
        max_tokens=1024,
        output_format=Grade,
        messages=[
            {
                "role": "user",
                "content": GRADE_PROMPT.format(
                    question=question, reference=reference, student=student or "(blank)"
                ),
            }
        ],
    )
    await usage_meter.record_claude(uid, GRADE_MODEL, response.usage)
    _reject_truncated(response, "Grading")
    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(502, "Grading returned no parsable output")
    return parsed


DOC_PROMPT = """You are making study cards for someone working through: {course}

Read these pages:
{urls}
{focus}
Write {n} question/answer cards testing *understanding* of what those pages say.

- Ground every card in what you actually read. If the pages do not cover
  something, do not write a card about it.
- Prefer "why" and "when would you" over "what is".
- Where the pages give a limit, a formula or a number, at least one card must
  require applying it to a new case rather than restating it.
- Answers: 1-3 sentences, precise.
- Nothing about the page's navigation, layout or publication date."""


def _domains(urls: list[str]) -> list[str]:
    """Hosts the fetch is confined to.

    Scoped to the hosts actually supplied, so following a link inside the same
    documentation site is allowed and wandering off it is not. That keeps the
    cards on topic as much as it keeps the fetching bounded.
    """
    hosts: list[str] = []
    for url in urls:
        host = urlparse(url).hostname
        if host and host not in hosts:
            hosts.append(host)
    return hosts


async def generate_cards_from_docs(
    uid: str,
    course: str,
    urls: list[str],
    count: int,
    focus: str = "",
) -> Cards:
    """Draft cards from reference documentation.

    Uses the server-side web_fetch tool, so the pages are retrieved and
    extracted by Anthropic rather than by us -- no scraper to maintain, and no
    trouble with documentation sites that render through JavaScript. The tool
    only fetches URLs already in the conversation, which the prompt supplies.

    This costs meaningfully more than generating from a note: a single
    documentation page ran to roughly 27k input tokens in testing, against a
    few hundred for a note. The usage page meters it per model.
    """
    if not urls:
        raise HTTPException(400, "Add at least one documentation link first")

    prompt = DOC_PROMPT.format(
        course=course,
        urls="\n".join(f"- {url}" for url in urls),
        focus=f"\nFocus on: {focus}\n" if focus.strip() else "",
        n=count,
    )

    # The budget has to cover thinking as well as the JSON, and a fetched page
    # makes the model think a lot more than a note does -- 8k truncated mid
    # object. Above roughly this size the SDK refuses a non-streaming call on
    # the grounds it might run past ten minutes, so the timeout is raised to
    # say that is expected. These take well under a minute in practice.
    response = await client().with_options(timeout=600.0).messages.parse(
        model=CARD_MODEL,
        max_tokens=16000,
        output_format=Cards,
        output_config={"effort": "medium"},
        tools=[
            {
                "type": "web_fetch_20260209",
                "name": "web_fetch",
                "max_uses": max(3, len(urls) + 2),
                "allowed_domains": _domains(urls),
                "max_content_tokens": 60000,
            }
        ],
        messages=[{"role": "user", "content": prompt}],
    )

    await usage_meter.record_claude(uid, CARD_MODEL, response.usage)
    _reject_truncated(response, "Reading those pages")
    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(
            502,
            "Could not read those pages well enough to write cards. "
            "A deep link to a specific topic works better than an index page.",
        )
    return parsed
