"""YouTube courses via the Data API.

A YouTube course needs no streaming proxy at all. The browser plays from
YouTube directly through the IFrame Player API, so there is no Drive-style
Range proxy, no egress on our bill, and no `.mp4` route to get wrong.

`decisions.md` 2 rejected Drive's iframe player because it exposed no
`currentTime`, no resume and no seeking. That objection does not carry over:
YouTube's IFrame API exposes all three, which is why embedding is the right
call here and was the wrong one there.

What we do need is metadata -- the ordered video list and per-video durations
-- and that is what this module fetches. Ordering comes from the playlist
position rather than from parsing names, so none of the numeric-prefix
guesswork the Drive scan needs applies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

import httpx
from fastapi import HTTPException

from app.config import settings

API = "https://www.googleapis.com/youtube/v3"
_UNAVAILABLE_TITLES = {"deleted video", "private video", "[deleted video]", "[private video]"}
_ISO_DURATION = re.compile(
    r"^P(?:(?P<days>\d+)D)?T?(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?$"
)

_client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=15.0))


@dataclass(slots=True)
class YouTubeVideo:
    video_id: str
    title: str
    position: int
    duration_s: float | None


@dataclass(slots=True)
class Playlist:
    playlist_id: str
    title: str
    item_count: int
    channel_title: str


async def close() -> None:
    await _client.aclose()


def parse_duration(value: str) -> float | None:
    """ISO 8601 duration to seconds.

    `videos.list` returns `PT12M34S`. Live streams and a few oddities return
    `P0D`, which parses to zero -- treated as unknown rather than as a
    zero-length video.
    """
    match = _ISO_DURATION.match(value or "")
    if not match:
        return None
    parts = {name: int(raw) for name, raw in match.groupdict(default="0").items()}
    total = parts["days"] * 86400 + parts["hours"] * 3600 + parts["minutes"] * 60 + parts["seconds"]
    return float(total) or None


def extract_playlist_id(text: str) -> str | None:
    """Pull a playlist id out of a URL, or accept a bare id.

    A YouTube *course* surfaces as a playlist, so a course URL carries the
    same `list=` parameter any playlist URL does.
    """
    text = text.strip()
    if re.fullmatch(r"(?:PL|UU|FL|OL|LL)[\w-]{10,}", text):
        return text
    match = re.search(r"[?&]list=([\w-]+)", text)
    return match.group(1) if match else None


def extract_handle(text: str) -> str | None:
    """Pull `@handle` out of a channel or courses URL."""
    match = re.search(r"youtube\.com/@([\w.-]+)", text.strip())
    if match:
        return match.group(1)
    if text.strip().startswith("@"):
        return text.strip()[1:]
    return None


async def _get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    key = settings().youtube_api_key
    if not key:
        raise HTTPException(503, "YOUTUBE_API_KEY is not configured")
    response = await _client.get(f"{API}/{path}", params={**params, "key": key})
    if response.status_code == 403:
        raise HTTPException(429, "YouTube API quota exceeded or key rejected")
    if response.status_code != 200:
        raise HTTPException(response.status_code, f"YouTube API error: {response.text[:300]}")
    return dict(response.json())


async def get_playlist(playlist_id: str) -> Playlist:
    payload = await _get("playlists", {"part": "snippet,contentDetails", "id": playlist_id})
    items = payload.get("items") or []
    if not items:
        raise HTTPException(404, "No such playlist, or it is private")
    entry = items[0]
    return Playlist(
        playlist_id=entry["id"],
        title=entry["snippet"]["title"],
        item_count=int(entry.get("contentDetails", {}).get("itemCount", 0)),
        channel_title=entry["snippet"].get("channelTitle", ""),
    )


async def channel_playlists(handle: str) -> list[Playlist]:
    """Every playlist on a channel, so a course can be picked from a handle.

    The `/courses` tab is not addressable through the Data API -- courses are
    backed by playlists, so listing playlists is what reaches them.
    """
    channel = await _get("channels", {"part": "id", "forHandle": handle})
    items = channel.get("items") or []
    if not items:
        raise HTTPException(404, f"No channel for @{handle}")
    channel_id = items[0]["id"]

    playlists: list[Playlist] = []
    page: str | None = None
    while True:
        params: dict[str, Any] = {
            "part": "snippet,contentDetails",
            "channelId": channel_id,
            "maxResults": 50,
        }
        if page:
            params["pageToken"] = page
        payload = await _get("playlists", params)
        for entry in payload.get("items", []):
            playlists.append(
                Playlist(
                    playlist_id=entry["id"],
                    title=entry["snippet"]["title"],
                    item_count=int(entry.get("contentDetails", {}).get("itemCount", 0)),
                    channel_title=entry["snippet"].get("channelTitle", ""),
                )
            )
        page = payload.get("nextPageToken")
        if not page:
            return playlists


async def playlist_videos(playlist_id: str) -> list[YouTubeVideo]:
    """Ordered videos in a playlist, with durations.

    Two calls per 50 videos: `playlistItems` for order and identity, then
    `videos` for durations, which `playlistItems` does not carry. Deleted and
    private entries are dropped -- they stay in a playlist forever and would
    otherwise become lectures that can never be watched.
    """
    entries: list[tuple[str, str, int]] = []
    page: str | None = None
    while True:
        params: dict[str, Any] = {
            "part": "snippet,contentDetails,status",
            "playlistId": playlist_id,
            "maxResults": 50,
        }
        if page:
            params["pageToken"] = page
        payload = await _get("playlistItems", params)
        for entry in payload.get("items", []):
            snippet = entry.get("snippet") or {}
            video_id = (entry.get("contentDetails") or {}).get("videoId")
            title = snippet.get("title", "")
            if not video_id or title.strip().lower() in _UNAVAILABLE_TITLES:
                continue
            entries.append((video_id, title, int(snippet.get("position", len(entries)))))
        page = payload.get("nextPageToken")
        if not page:
            break

    if not entries:
        raise HTTPException(404, "That playlist has no watchable videos")

    durations: dict[str, float | None] = {}
    ids = [video_id for video_id, _, _ in entries]
    for start in range(0, len(ids), 50):
        chunk = ids[start : start + 50]
        payload = await _get("videos", {"part": "contentDetails", "id": ",".join(chunk)})
        for entry in payload.get("items", []):
            iso = (entry.get("contentDetails") or {}).get("duration", "")
            durations[entry["id"]] = parse_duration(iso)

    return [
        YouTubeVideo(
            video_id=video_id,
            title=title,
            position=position,
            duration_s=durations.get(video_id),
        )
        for video_id, title, position in sorted(entries, key=lambda item: item[2])
    ]


_SEQUENCE_HINT = re.compile(
    r"(?:class|part|lesson|episode|video|ep|no|#)\s*\.?\s*(\d{1,3})\b", re.IGNORECASE
)


def sequence_number(title: str) -> int | None:
    """A lesson number stated in the title, if there is one.

    Matches `Class 3`, `Part 2`, `Lesson 10`, `#4`. Deliberately not any bare
    number: titles are full of years, percentages and dollar amounts, and
    treating those as an ordering would be worse than having no ordering.
    """
    match = _SEQUENCE_HINT.search(title or "")
    return int(match.group(1)) if match else None


def looks_reversed(videos: list[YouTubeVideo]) -> bool:
    """Whether the playlist runs newest-first against its own lesson numbers.

    Playlist position is usually the order to watch in, but a channel that
    simply appends each new upload ends up with the course backwards -- and
    that is not a rare edge case, it is what Patrick Boyle's Applied Portfolio
    Management playlist actually does. Where the titles number themselves,
    their direction is better evidence than the position, so this reports a
    disagreement for a human to confirm rather than silently reordering.
    """
    numbered = [
        (video.position, sequence_number(video.title))
        for video in videos
        if sequence_number(video.title) is not None
    ]
    if len(numbered) < 3:
        return False

    descending = sum(
        1
        for (_, first), (_, second) in pairwise(numbered)
        if first is not None and second is not None and second < first
    )
    return descending > (len(numbered) - 1) / 2
