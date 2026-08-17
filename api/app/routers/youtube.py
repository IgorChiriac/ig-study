"""YouTube course resolution and scanning.

No streaming endpoint here on purpose. YouTube videos play in the browser
through the IFrame Player API, so nothing proxies bytes -- there is no egress
on our bill and no Range semantics to get wrong.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from google.cloud import firestore
from pydantic import BaseModel, ConfigDict, Field

from app import store, youtube
from app import usage as usage_meter
from app.auth import current_uid
from app.ordering import order_idx
from app.store import Lecture

router = APIRouter(prefix="/youtube", tags=["youtube"])


class PlaylistOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    playlist_id: str = Field(alias="playlistId")
    title: str
    item_count: int = Field(alias="itemCount")
    channel_title: str = Field(alias="channelTitle")


class Resolved(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: str
    playlists: list[PlaylistOut]


class YouTubeScanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    playlist_id: str = Field(alias="playlistId")
    name: str | None = None
    reverse: bool = False


class PreviewVideo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    video_id: str = Field(alias="videoId")
    title: str
    duration_s: float | None = Field(alias="durationS")


class PlaylistPreview(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    playlist_id: str = Field(alias="playlistId")
    title: str
    channel_title: str = Field(alias="channelTitle")
    videos: list[PreviewVideo]
    skipped: int
    total_duration_s: float = Field(alias="totalDurationS")
    looks_reversed: bool = Field(alias="looksReversed")


@router.get("/resolve", response_model=Resolved)
async def resolve(
    uid: Annotated[str, Depends(current_uid)],
    url: str = Query(min_length=2),
) -> Resolved:
    """Turn whatever the user pasted into something scannable.

    A playlist URL or bare id resolves to that one playlist. A channel or
    `/courses` URL resolves to every playlist on the channel, because the
    courses tab itself is not addressable through the Data API -- courses are
    backed by playlists.
    """
    playlist_id = youtube.extract_playlist_id(url)
    if playlist_id:
        found = await youtube.get_playlist(playlist_id)
        return Resolved(
            kind="playlist",
            playlists=[
                PlaylistOut(
                    playlistId=found.playlist_id,
                    title=found.title,
                    itemCount=found.item_count,
                    channelTitle=found.channel_title,
                )
            ],
        )

    handle = youtube.extract_handle(url)
    if not handle:
        raise HTTPException(
            400,
            "Paste a playlist URL, a bare playlist id, or a channel URL like "
            "youtube.com/@PBoyle/courses",
        )

    playlists = await youtube.channel_playlists(handle)
    return Resolved(
        kind="channel",
        playlists=[
            PlaylistOut(
                playlistId=entry.playlist_id,
                title=entry.title,
                itemCount=entry.item_count,
                channelTitle=entry.channel_title,
            )
            for entry in playlists
            if entry.item_count > 0
        ],
    )


@router.get("/preview/{playlist_id}", response_model=PlaylistPreview)
async def preview(
    playlist_id: str,
    uid: Annotated[str, Depends(current_uid)],
    reverse: bool = Query(default=False),
) -> PlaylistPreview:
    """The watch order a scan would write, without writing it.

    Reports `looksReversed` when the titles number themselves and those
    numbers run against the playlist position -- a channel that appends each
    new upload ends up with its own course backwards, which is common enough
    to be worth surfacing before 40 lectures land in the wrong order.
    """
    playlist = await youtube.get_playlist(playlist_id)
    videos = await youtube.playlist_videos(playlist_id)
    flagged = youtube.looks_reversed(videos)
    ordered = list(reversed(videos)) if reverse else videos

    return PlaylistPreview(
        playlistId=playlist.playlist_id,
        title=playlist.title,
        channelTitle=playlist.channel_title,
        videos=[
            PreviewVideo(videoId=v.video_id, title=v.title, durationS=v.duration_s) for v in ordered
        ],
        skipped=max(0, playlist.item_count - len(videos)),
        totalDurationS=sum(v.duration_s or 0 for v in videos),
        looksReversed=flagged,
    )


@router.post("/scan/{project_id}")
async def scan_playlist(
    project_id: str,
    body: YouTubeScanRequest,
    uid: Annotated[str, Depends(current_uid)],
) -> dict[str, Any]:
    """Write a playlist's videos as lectures.

    Order comes from the playlist position, so none of the numeric-prefix
    parsing the Drive scan needs applies here -- a playlist is already
    authored in the order it should be watched.
    """
    playlist = await youtube.get_playlist(body.playlist_id)
    videos = await youtube.playlist_videos(body.playlist_id)
    if body.reverse:
        videos = list(reversed(videos))

    lectures = [
        Lecture(
            source="youtube",
            youtube_video_id=video.video_id,
            module="",
            title=video.title,
            order_idx=order_idx(0, index),
            duration_s=video.duration_s,
        )
        for index, video in enumerate(videos)
    ]

    existing = await store.get_project(uid, project_id)
    result = await store.apply_scan(uid, project_id, lectures)

    project_fields: dict[str, Any] = {
        "source": "youtube",
        "name": body.name or playlist.title,
        "youtubePlaylistId": playlist.playlist_id,
        "channelTitle": playlist.channel_title,
        "reversed": body.reverse,
        "lastScanAt": firestore.SERVER_TIMESTAMP,
    }
    if not existing:
        project_fields["orderIdx"] = store.new_project_order()
    await store.upsert_project(uid, project_id, project_fields)
    await usage_meter.record_scan(uid, len(lectures))

    return {
        "projectId": project_id,
        "name": body.name or playlist.title,
        "lectures": len(lectures),
        "added": len(result.added),
        "updated": len(result.updated),
        "orphaned": len(result.orphaned),
        "skipped": max(0, playlist.item_count - len(videos)),
    }
