"""Firestore writes that belong to the server.

Almost all of this app's Firestore traffic goes client to Firestore directly,
authorised by security rules. Scan is the exception: it needs the Drive
credential, so it has to run here, and once it is here it may as well write
the result. These writes go through the Admin SDK and therefore *bypass* the
security rules entirely -- which is why every path is built from a uid the
caller proved, never from anything in a request body.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from google.cloud import firestore

from app.config import settings

_BATCH_LIMIT = 400

_USER_OWNED_DEFAULTS: dict[str, Any] = {
    "seen": False,
    "note": "",
    "positionS": 0,
}

_client: firestore.AsyncClient | None = None


def client() -> firestore.AsyncClient:
    global _client
    if _client is None:
        _client = firestore.AsyncClient(project=settings().firebase_project_id)
    return _client


@dataclass(slots=True)
class Lecture:
    """One video, as a scan discovered it, from either source."""

    module: str
    title: str
    order_idx: int
    duration_s: float | None
    source: str = "drive"
    drive_file_id: str | None = None
    youtube_video_id: str | None = None
    size_bytes: int | None = None

    @property
    def key(self) -> str:
        """The document id: whichever platform's own stable identifier applies.

        Drive preserves `fileId` across renames and moves; a YouTube video id
        never changes either. Keying on the platform id rather than a path
        hash is what stops a reorganised folder or a retitled video orphaning
        the note attached to it.
        """
        return self.drive_file_id or self.youtube_video_id or ""

    def to_scan_fields(self) -> dict[str, Any]:
        fields: dict[str, Any] = {
            "source": self.source,
            "module": self.module,
            "title": self.title,
            "orderIdx": self.order_idx,
            "durationS": self.duration_s,
        }
        if self.drive_file_id:
            fields["driveFileId"] = self.drive_file_id
            fields["sizeBytes"] = self.size_bytes
        if self.youtube_video_id:
            fields["youtubeVideoId"] = self.youtube_video_id
        return fields


@dataclass(slots=True)
class ScanResult:
    added: list[str]
    updated: list[str]
    orphaned: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "added": len(self.added),
            "updated": len(self.updated),
            "orphaned": len(self.orphaned),
            "orphanedIds": self.orphaned,
        }


def project_ref(uid: str, project_id: str) -> Any:
    return client().collection("users").document(uid).collection("projects").document(project_id)


def lectures_ref(uid: str, project_id: str) -> Any:
    return project_ref(uid, project_id).collection("lectures")


async def get_project(uid: str, project_id: str) -> dict[str, Any] | None:
    snapshot = await project_ref(uid, project_id).get()
    return snapshot.to_dict() if snapshot.exists else None


async def upsert_project(uid: str, project_id: str, fields: dict[str, Any]) -> None:
    await project_ref(uid, project_id).set(fields, merge=True)


async def apply_scan(uid: str, project_id: str, lectures: list[Lecture]) -> ScanResult:
    """Write scanned lectures, preserving everything the user owns.

    Matching is on the Drive file id, which is also the document id, because
    Drive preserves that id across renames and moves. Keying on a path hash
    instead would orphan every note the first time a folder is reorganised.

    A lecture that has vanished from Drive is *reported*, never deleted -- the
    note attached to it is the expensive part, not the row.
    """
    collection = lectures_ref(uid, project_id)
    existing: set[str] = set()
    async for snapshot in collection.select([]).stream():
        existing.add(snapshot.id)

    scanned = {lecture.key for lecture in lectures}
    added = sorted(scanned - existing)
    updated = sorted(scanned & existing)
    orphaned = sorted(existing - scanned)

    pending = 0
    batch = client().batch()
    for lecture in lectures:
        fields = lecture.to_scan_fields()
        fields["updatedAt"] = firestore.SERVER_TIMESTAMP
        if lecture.key not in existing:
            fields.update(_USER_OWNED_DEFAULTS)
        batch.set(collection.document(lecture.key), fields, merge=True)
        pending += 1
        if pending >= _BATCH_LIMIT:
            await batch.commit()
            batch = client().batch()
            pending = 0
    if pending:
        await batch.commit()

    return ScanResult(added=added, updated=updated, orphaned=orphaned)


async def find_lecture_project(uid: str, lecture_id: str) -> str | None:
    """Which of the user's projects contains this lecture, if any.

    A collection group query would be tidier, but it needs its own declared
    index and this runs once per playback rather than once per seek.
    """
    async for project in client().collection("users").document(uid).collection("projects").stream():
        snapshot = await lectures_ref(uid, project.id).document(lecture_id).get()
        if snapshot.exists:
            return str(project.id)
    return None
