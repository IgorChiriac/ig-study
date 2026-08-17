"""Card generation, the due queue, and grading."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import cards_store, claude, store
from app.auth import current_uid
from app.scheduler import review as apply_sm2

router = APIRouter(tags=["cards"])


class GenerateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    count: int = Field(default=5, ge=1, le=12)


class DraftCard(BaseModel):
    q: str
    a: str


class SaveRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    cards: list[DraftCard]


class AnswerRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    text: str = ""


class AnswerResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    score: int
    verdict: str
    missing: str
    correction: str
    reference: str
    next_due: str = Field(alias="nextDue")
    interval_days: int = Field(alias="intervalDays")
    is_leech: bool = Field(alias="isLeech")


@router.post("/lectures/{lecture_id}/cards:generate", response_model=list[DraftCard])
async def generate(
    lecture_id: str,
    body: GenerateRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> list[DraftCard]:
    """Draft cards from the lecture's note. Nothing is saved yet.

    The drafts come back for approval rather than going straight to Firestore,
    because a card you didn't agree with is one you'll fight for weeks.
    """
    snapshot = await store.lectures_ref(uid, body.project_id).document(lecture_id).get()
    if not snapshot.exists:
        raise HTTPException(404, "No such lecture")
    lecture = snapshot.to_dict() or {}

    project = await store.get_project(uid, body.project_id)
    drafted = await claude.generate_cards(
        course=str((project or {}).get("name", body.project_id)),
        module=str(lecture.get("module", "")),
        title=str(lecture.get("title", "")),
        note=str(lecture.get("note", "")),
        count=body.count,
    )
    return [DraftCard(q=card.q, a=card.a) for card in drafted.cards]


@router.post("/lectures/{lecture_id}/cards")
async def save(
    lecture_id: str,
    body: SaveRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, int | list[str]]:
    """Save approved cards. They become due immediately."""
    snapshot = await store.lectures_ref(uid, body.project_id).document(lecture_id).get()
    if not snapshot.exists:
        raise HTTPException(404, "No such lecture")
    module = str((snapshot.to_dict() or {}).get("module", ""))

    ids = await cards_store.add_cards(
        uid,
        body.project_id,
        lecture_id,
        module,
        [(card.q, card.a) for card in body.cards],
    )
    return {"saved": len(ids), "ids": ids}


@router.get("/cards/due")
async def due(uid: Annotated[str, Depends(current_uid)]) -> dict[str, object]:
    """What's ready today, already capped."""
    queue, counts = await cards_store.due_queue(uid)
    return {"cards": [card.as_dict() for card in queue], **counts}


@router.post("/cards/{card_id}/answer", response_model=AnswerResponse)
async def answer(
    card_id: str,
    body: AnswerRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> AnswerResponse:
    """Grade a free-text answer and schedule the card.

    The score drives SM-2; the prose goes on screen. Grading happens before
    scheduling so a model failure never advances the card.
    """
    card = await cards_store.get_card(uid, body.project_id, card_id)
    if card is None:
        raise HTTPException(404, "No such card")

    grade = await claude.grade_answer(card.question, card.answer, body.text)
    state, next_due = apply_sm2(card.state, grade.score, cards_store.today_local())
    await cards_store.record_review(uid, card, state, next_due, grade.score)

    return AnswerResponse(
        score=grade.score,
        verdict=grade.verdict,
        missing=grade.missing,
        correction=grade.correction,
        reference=card.answer,
        nextDue=next_due.isoformat(),
        intervalDays=state.interval,
        isLeech=state.is_leech,
    )
