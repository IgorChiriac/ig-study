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

from anthropic import AsyncAnthropic
from fastapi import HTTPException
from pydantic import BaseModel, Field

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


async def generate_cards(course: str, module: str, title: str, note: str, count: int) -> Cards:
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
    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(502, "Card generation returned no parsable output")
    return parsed


async def grade_answer(question: str, reference: str, student: str) -> Grade:
    """Score a free-text answer on understanding.

    Answering in your own words and being judged on understanding rather than
    string matching is the entire reason this isn't just Anki, so the prompt
    is explicit that a 2 does not get rounded up to a 3.
    """
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
    parsed = response.parsed_output
    if parsed is None:
        raise HTTPException(502, "Grading returned no parsable output")
    return parsed
