"""Read-only Drive browsing, so a folder can be picked without leaving the app."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app import drive, scan
from app.auth import current_uid

router = APIRouter(prefix="/drive", tags=["drive"])


class FolderEntry(BaseModel):
    id: str
    name: str


class PreviewLecture(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    module: str
    title: str
    order_idx: int = Field(alias="orderIdx")
    duration_s: float | None = Field(alias="durationS")
    size_bytes: int | None = Field(alias="sizeBytes")


class FolderPreview(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    modules: list[str]
    lectures: list[PreviewLecture]
    missing_duration: int = Field(alias="missingDuration")


@router.get("/folders", response_model=list[FolderEntry])
async def list_folders(
    uid: Annotated[str, Depends(current_uid)],
    parent: str = Query(default="root"),
) -> list[FolderEntry]:
    """Subfolders of a Drive folder. `root` is My Drive."""
    entries = await drive.list_children(parent)
    return [FolderEntry(id=entry.id, name=entry.name) for entry in entries if entry.is_folder]


@router.get("/folders/{folder_id}/preview", response_model=FolderPreview)
async def preview_folder(
    folder_id: str,
    uid: Annotated[str, Depends(current_uid)],
) -> FolderPreview:
    """Exactly what a scan would write, without writing anything.

    Worth running once before the first real scan: it is where you find out
    that a folder has no numeric prefix, or that Drive has not finished
    processing an upload and is still withholding its duration.
    """
    lectures = await scan.scan_course(folder_id)
    lectures.sort(key=lambda lecture: lecture.order_idx)
    return FolderPreview(
        modules=sorted({lecture.module for lecture in lectures}),
        lectures=[
            PreviewLecture(
                id=lecture.drive_file_id,
                module=lecture.module,
                title=lecture.title,
                orderIdx=lecture.order_idx,
                durationS=lecture.duration_s,
                sizeBytes=lecture.size_bytes,
            )
            for lecture in lectures
        ],
        missingDuration=sum(1 for lecture in lectures if lecture.duration_s is None),
    )
