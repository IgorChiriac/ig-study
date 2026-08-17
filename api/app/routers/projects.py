"""Project and scan endpoints."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from google.cloud import firestore
from pydantic import BaseModel, ConfigDict, Field

from app import scan as scanner
from app import store
from app import usage as usage_meter
from app.auth import current_uid

router = APIRouter(prefix="/projects", tags=["projects"])


class ScanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    drive_folder_id: str | None = Field(default=None, alias="driveFolderId")
    name: str | None = None


class ScanResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(alias="projectId")
    lectures: int
    modules: int
    added: int
    updated: int
    orphaned: int
    orphaned_ids: list[str] = Field(alias="orphanedIds")
    missing_duration: int = Field(alias="missingDuration")


@router.post("/{project_id}/scan", response_model=ScanResponse)
async def scan_project(
    project_id: str,
    body: ScanRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> ScanResponse:
    """Walk the project's Drive folder and write what it finds.

    Re-scanning is safe and expected: notes, seen flags and resume positions
    are left untouched, and a lecture that disappeared from Drive is reported
    as an orphan rather than deleted.
    """
    existing = await store.get_project(uid, project_id)
    folder_id = body.drive_folder_id or (existing or {}).get("driveFolderId")
    if not folder_id:
        raise HTTPException(400, "No driveFolderId on the project or in the request")

    lectures = await scanner.scan_course(folder_id)
    if not lectures:
        raise HTTPException(404, "No video files found under that folder")

    result = await store.apply_scan(uid, project_id, lectures)

    project_fields: dict[str, Any] = {
        "driveFolderId": folder_id,
        "lastScanAt": firestore.SERVER_TIMESTAMP,
    }
    if body.name:
        project_fields["name"] = body.name
    elif not existing:
        project_fields["name"] = project_id
    if not existing:
        project_fields["source"] = "drive"
        project_fields["orderIdx"] = store.new_project_order()
    await store.upsert_project(uid, project_id, project_fields)
    await usage_meter.record_scan(uid, len(lectures))

    return ScanResponse(
        projectId=project_id,
        lectures=len(lectures),
        modules=len({lecture.module for lecture in lectures}),
        added=len(result.added),
        updated=len(result.updated),
        orphaned=len(result.orphaned),
        orphanedIds=result.orphaned,
        missingDuration=sum(1 for lecture in lectures if lecture.duration_s is None),
    )
