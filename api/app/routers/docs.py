"""Cards from reference documentation.

The documentation links themselves are user data and are written client-side
straight to Firestore, like notes and seen flags. Only generation comes through
here, because that is the part needing the Anthropic key.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from google.cloud import firestore
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from app import cards_store, claude, library, store
from app.auth import current_uid

router = APIRouter(prefix="/docs", tags=["docs"])

MAX_URLS = 5


class DraftCard(BaseModel):
    q: str
    a: str


class DiscoverRequest(BaseModel):
    url: HttpUrl


class DeduplicateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")


class IngestRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    url: HttpUrl
    label: str = ""


class GenerateFromDocs(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    doc_id: str = Field(alias="docId")
    count: int = Field(default=10, ge=1, le=20)
    focus: str = ""


class SaveDocCards(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    doc_id: str = Field(alias="docId")
    label: str
    cards: list[DraftCard]


def _docs_ref(uid: str, project_id: str):
    return store.project_ref(uid, project_id).collection("docs")


@router.post("/discover")
async def discover(
    body: DiscoverRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, Any]:
    """List the pages a contents page links to, so ingesting can be aimed."""
    chapters = await library.discover(uid, str(body.url))
    return {"chapters": [{"title": c.title, "url": c.url} for c in chapters]}


async def _find_stored(uid: str, project_id: str, url: str) -> tuple[str, str, str] | None:
    """Locate an earlier ingest of this page. Returns (projectId, docId, label).

    Two questions at once, because the answers differ. Already in *this* course
    means the entry exists and adding it again should change nothing -- which
    is what let the same chapter appear twice in the list under two anchor
    texts. Already in *another* course means the text can be copied across
    rather than fetched and paid for a second time.

    Scanned rather than queried: the stored `url` is whatever the link said, so
    matching needs the normalised form, and a course holds tens of documents.
    """
    key = library.url_key(url)
    fallback: tuple[str, str, str] | None = None
    async for project in (
        store.client().collection("users").document(uid).collection("projects").stream()
    ):
        async for snapshot in _docs_ref(uid, project.id).stream():
            document = snapshot.to_dict() or {}
            if library.url_key(str(document.get("url", ""))) != key:
                continue
            found = (project.id, snapshot.id, str(document.get("label", "")))
            if project.id == project_id:
                return found
            fallback = fallback or found
    return fallback


async def _stored_text(uid: str, project_id: str, doc_id: str) -> str:
    body = (
        await _docs_ref(uid, project_id).document(doc_id).collection("parts").document("body").get()
    )
    return str((body.to_dict() or {}).get("text", "")) if body.exists else ""


@router.post("/deduplicate")
async def deduplicate(
    body: DeduplicateRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, Any]:
    """Drop entries that repeat a page already in the course.

    For the ones added before ingest checked. The earliest entry of each page
    is kept, so any cards already generated stay attached to a document that
    still exists.
    """
    if await store.get_project(uid, body.project_id) is None:
        raise HTTPException(404, "No such course")

    seen: dict[str, str] = {}
    removed: list[str] = []
    docs_ref = _docs_ref(uid, body.project_id)
    async for snapshot in docs_ref.order_by("ingestedAt").stream():
        key = library.url_key(str((snapshot.to_dict() or {}).get("url", "")))
        if key in seen:
            removed.append(snapshot.id)
            continue
        seen[key] = snapshot.id

    for doc_id in removed:
        await docs_ref.document(doc_id).collection("parts").document("body").delete()
        await docs_ref.document(doc_id).delete()
    return {"removed": len(removed), "kept": len(seen)}


@router.post("/ingest")
async def ingest(
    body: IngestRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, Any]:
    """Fetch a page once and store its text against the course.

    Written server-side for the same reason a Drive scan is: it needs a
    credential the browser must never hold. Cards are generated from what this
    stores, so the page is never fetched again.
    """
    if await store.get_project(uid, body.project_id) is None:
        raise HTTPException(404, "No such course")

    found = await _find_stored(uid, body.project_id, str(body.url))
    if found is not None and found[0] == body.project_id:
        _, doc_id, label = found
        text = await _stored_text(uid, body.project_id, doc_id)
        return {
            "docId": doc_id,
            "label": label,
            "chars": len(text),
            "approxTokens": len(text) // library.CHARS_PER_TOKEN,
            "outcome": "already-added",
        }

    if found is not None:
        other_project, doc_id, label = found
        text = await _stored_text(uid, other_project, doc_id)
        result = library.Ingested(url=str(body.url), title=label, text=text)
    else:
        result = await library.ingest(uid, str(body.url))

    reference = _docs_ref(uid, body.project_id).document()

    # Metadata and body are separate documents. The client subscribes to the
    # list, and a page's text runs to tens of kilobytes -- keeping it in the
    # listed document would stream every chapter's full text to the browser on
    # every snapshot, for a screen that only ever shows titles.
    await reference.set(
        {
            "url": result.url,
            "label": body.label or result.title,
            "chars": len(result.text),
            "approxTokens": result.approx_tokens,
            "cardCount": 0,
            "ingestedAt": firestore.SERVER_TIMESTAMP,
        }
    )
    await reference.collection("parts").document("body").set({"text": result.text})
    return {
        "docId": reference.id,
        "label": body.label or result.title,
        "chars": len(result.text),
        "approxTokens": result.approx_tokens,
        "outcome": "copied" if found is not None else "fetched",
    }


@router.post("/cards:generate", response_model=list[DraftCard])
async def generate(
    body: GenerateFromDocs,
    uid: Annotated[str, Depends(current_uid)],
) -> list[DraftCard]:
    """Draft cards from already-ingested text. Nothing is fetched, nothing saved.

    Questions already held for this document are passed along so a second batch
    covers new ground instead of paying to rewrite the first one.
    """
    project = await store.get_project(uid, body.project_id)
    if project is None:
        raise HTTPException(404, "No such course")

    reference = _docs_ref(uid, body.project_id).document(body.doc_id)
    snapshot = await reference.get()
    if not snapshot.exists:
        raise HTTPException(404, "No such document")
    document = snapshot.to_dict() or {}

    body_snapshot = await reference.collection("parts").document("body").get()
    stored = (body_snapshot.to_dict() or {}).get("text", "") if body_snapshot.exists else ""

    existing: list[str] = []
    query = cards_store.cards_ref(uid, body.project_id).where("docId", "==", body.doc_id)
    async for card in query.stream():
        question = (card.to_dict() or {}).get("q")
        if question:
            existing.append(str(question))

    drafted = await claude.generate_cards_from_text(
        uid,
        course=str(project.get("name", body.project_id)),
        title=str(document.get("label", "")),
        text=str(stored),
        count=body.count,
        focus=body.focus,
        avoid=existing,
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
