"""Coverage analysis: what the documentation covers that the course does not."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from google.cloud import firestore
from pydantic import BaseModel, ConfigDict, Field

from app import gaps, store
from app.auth import current_uid

router = APIRouter(prefix="/gaps", tags=["gaps"])


class AnalyseRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    topic_target: int = Field(default=40, ge=10, le=80, alias="topicTarget")


async def _lecture_titles(uid: str, project_id: str) -> list[str]:
    titles: list[tuple[int, str]] = []
    async for snapshot in store.lectures_ref(uid, project_id).stream():
        data = snapshot.to_dict() or {}
        titles.append((int(data.get("orderIdx", 0)), str(data.get("title", ""))))
    return [title for _, title in sorted(titles) if title]


async def _documents(uid: str, project_id: str) -> list[tuple[str, str]]:
    """Every stored document's label and body, for the cached corpus."""
    documents: list[tuple[str, str]] = []
    docs_ref = store.project_ref(uid, project_id).collection("docs")
    async for snapshot in docs_ref.stream():
        data = snapshot.to_dict() or {}
        body = await docs_ref.document(snapshot.id).collection("parts").document("body").get()
        text = (body.to_dict() or {}).get("text", "") if body.exists else ""
        if text:
            documents.append((str(data.get("label", snapshot.id)), str(text)))
    return documents


@router.post("/{project_id}/analyse")
async def analyse(
    project_id: str,
    body: AnalyseRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, Any]:
    """Compare stored documentation against the course, and save the result.

    Saved rather than returned-and-forgotten: this is the expensive call in the
    app, and the answer only changes when the documents or the lectures do.
    """
    if await store.get_project(uid, project_id) is None:
        raise HTTPException(404, "No such course")

    lectures = await _lecture_titles(uid, project_id)
    documents = await _documents(uid, project_id)
    result = await gaps.analyse(uid, lectures, documents, body.topic_target)

    payload = gaps.as_dict(result)
    await (
        store.project_ref(uid, project_id)
        .collection("analysis")
        .document("gaps")
        .set(
            {
                **payload,
                "lectureCount": len(lectures),
                "documentCount": len(documents),
                "ranAt": firestore.SERVER_TIMESTAMP,
            }
        )
    )
    return {
        **payload,
        "lectureCount": len(lectures),
        "documentCount": len(documents),
    }
