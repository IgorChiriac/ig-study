"""What the course teaches, against what the documentation says exists.

The point of the app is not to make cards; it is to pass. Cards test what you
already know you should know. This asks the question cards cannot: what does
the reference material cover that the course never mentions?

That is why this runs against both sources at once rather than per chapter. A
topic is only missing if it appears in *no* lecture, which cannot be decided
from one chapter in isolation -- so the whole corpus goes in a single call,
which is what a 1M context window is actually for.

The corpus sits behind a one-hour cache breakpoint. It is expensive to write
once (a 1h write bills at twice the input rate) and nearly free to read after,
so any further analysis in the same sitting -- staleness, exam generation --
rides on the same cached prefix. The consequence worth knowing: batch that work
into one session, because an hour later the write is paid again.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app import usage as usage_meter
from app.claude import CARD_MODEL, _reject_truncated, client

Coverage = Literal["covered", "partial", "missing"]
Importance = Literal["core", "useful", "edge"]


class Topic(BaseModel):
    topic: str = Field(description="The concept, named as the documentation names it.")
    source_section: str = Field(description="Which document it comes from.")
    coverage: Coverage = Field(
        description=(
            "covered: a lecture teaches it. partial: a lecture touches it but the "
            "documentation goes materially further. missing: no lecture addresses it."
        )
    )
    lectures: list[str] = Field(description="Titles of lectures that address it. Empty if none.")
    importance: Importance = Field(
        description="core: needed to work with the service. useful: worth knowing. edge: niche."
    )
    why: str = Field(description="One sentence. For a gap, what specifically is absent.")


class GapMap(BaseModel):
    summary: str = Field(description="Two or three sentences on the shape of the gaps.")
    topics: list[Topic]


PROMPT = """You are comparing a video course against the official documentation for the \
same subject, for someone preparing to be examined on it.

The lectures in the course, in order:
{lectures}

Identify the distinct technical topics the documentation covers, and for each one decide \
whether the course teaches it.

- Judge by what a lecture is *about*, not by whether a word appears in its title.
- "partial" is the important verdict and the easiest to get wrong: use it when a lecture \
  introduces a topic but the documentation carries materially more that an exam could \
  reach — limits, edge cases, or a second mechanism.
- Mark "missing" only when no lecture addresses the topic at all.
- Judge importance by how central the topic is to using the service competently, not by \
  how much documentation it happens to have.
- Cover the documentation's substance rather than every heading. Aim for the {n} topics \
  that matter most, weighted toward anything the course leaves out.

Be concrete in `why`. "Not covered in the course" is useless; "the course never mentions \
that a partition caps at 3,000 read units regardless of table capacity" is the point."""


def _corpus(documents: list[tuple[str, str]]) -> str:
    return "\n\n".join(
        f"===== DOCUMENT: {title} =====\n{text}" for title, text in documents if text.strip()
    )


async def analyse(
    uid: str,
    lectures: list[str],
    documents: list[tuple[str, str]],
    topic_target: int = 40,
) -> GapMap:
    """Compare the lecture list against the ingested documentation."""
    if not documents:
        raise HTTPException(400, "Store some documentation first — there is nothing to compare")
    if not lectures:
        raise HTTPException(400, "This course has no lectures to compare against")

    corpus = _corpus(documents)
    if not corpus.strip():
        raise HTTPException(400, "The stored documents are empty")

    response = (
        await client()
        .with_options(timeout=900.0)
        .messages.parse(
            model=CARD_MODEL,
            max_tokens=32000,
            output_format=GapMap,
            output_config={"effort": "high"},
            system=[
                {
                    "type": "text",
                    "text": f"Reference documentation for this subject.\n\n{corpus}",
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": PROMPT.format(
                        lectures="\n".join(f"- {title}" for title in lectures),
                        n=topic_target,
                    ),
                }
            ],
        )
    )

    await usage_meter.record_claude(uid, CARD_MODEL, response.usage)
    _reject_truncated(response, "Gap analysis")
    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(502, "Gap analysis returned no parsable output")
    return parsed


def as_dict(result: GapMap) -> dict[str, Any]:
    return {
        "summary": result.summary,
        "topics": [
            {
                "topic": topic.topic,
                "sourceSection": topic.source_section,
                "coverage": topic.coverage,
                "lectures": topic.lectures,
                "importance": topic.importance,
                "why": topic.why,
            }
            for topic in result.topics
        ],
    }
