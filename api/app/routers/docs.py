"""Cards from reference documentation.

The documentation links themselves are user data and are written client-side
straight to Firestore, like notes and seen flags. Only generation comes through
here, because that is the part needing the Anthropic key.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from app import cards_store, claude, store
from app.auth import current_uid

router = APIRouter(prefix="/docs", tags=["docs"])

MAX_URLS = 5


class DraftCard(BaseModel):
    q: str
    a: str


class GenerateFromDocs(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    urls: list[HttpUrl] = Field(min_length=1, max_length=MAX_URLS)
    count: int = Field(default=5, ge=1, le=12)
    focus: str = ""


class SaveDocCards(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    doc_id: str = Field(alias="docId")
    label: str
    cards: list[DraftCard]


@router.post("/cards:generate", response_model=list[DraftCard])
async def generate(
    body: GenerateFromDocs,
    uid: Annotated[str, Depends(current_uid)],
) -> list[DraftCard]:
    """Read the pages and draft cards. Nothing is saved yet."""
    project = await store.get_project(uid, body.project_id)
    if project is None:
        raise HTTPException(404, "No such course")

    drafted = await claude.generate_cards_from_docs(
        uid,
        course=str(project.get("name", body.project_id)),
        urls=[str(url) for url in body.urls],
        count=body.count,
        focus=body.focus,
    )
    return [DraftCard(q=card.q, a=card.a) for card in drafted.cards]


@router.post("/cards")
async def save(
    body: SaveDocCards,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, int]:
    """Save approved doc cards into the same queue as lecture cards.

    They carry the doc's label as their module, so the stats screen ranks a
    documentation source alongside the course's own modules.
    """
    ids = await cards_store.add_cards(
        uid,
        body.project_id,
        "",
        body.label,
        [(card.q, card.a) for card in body.cards],
        doc_id=body.doc_id,
    )
    return {"saved": len(ids)}
