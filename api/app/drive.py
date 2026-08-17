"""Google Drive access.

Drive is the worst of the storage options on pure streaming mechanics: it is
the only one that cannot produce a self-authenticating URL, because
`files.get?alt=media` accepts an Authorization header and nothing else. That
is the entire reason this proxy exists.

Two behaviours here are load-bearing and must not be "cleaned up":

  * `open_range` returns the upstream response with its status code intact.
    WebKit opens playback with a ~2 byte range request purely to check the
    server understands ranges, and it must be answered 206. Answer 200 and
    the iPhone renders nothing, with no useful error.

  * Nothing is ever buffered. The caller streams `aiter_bytes` and closes the
    response. Reading a body into memory works on a 5 MB test clip and falls
    over on a 400 MB lecture.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException

from app.config import settings

TOKEN_URL = "https://oauth2.googleapis.com/token"
FILES_URL = "https://www.googleapis.com/drive/v3/files"
FOLDER_MIME = "application/vnd.google-apps.folder"
CHUNK = 256 * 1024

_LIST_FIELDS = "nextPageToken,files(id,name,size,mimeType,videoMediaMetadata(durationMillis))"
_RETRYABLE = {403, 429, 500, 502, 503, 504}
_MAX_RETRIES = 4

_client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=15.0))
_token: dict[str, Any] = {"value": None, "expires_at": 0.0}
_token_lock = asyncio.Lock()


@dataclass(slots=True)
class DriveEntry:
    """One file or folder as the scan cares about it."""

    id: str
    name: str
    mime_type: str
    size_bytes: int | None
    duration_s: float | None

    @property
    def is_folder(self) -> bool:
        return self.mime_type == FOLDER_MIME

    @property
    def is_video(self) -> bool:
        return self.mime_type.startswith("video/")


async def close() -> None:
    await _client.aclose()


async def access_token(*, force_refresh: bool = False) -> str:
    """Return a valid Drive access token.

    The lock keeps two overlapping range requests from both refreshing when
    the token expires mid-session. Harmless for one user, but it is two lines.
    """
    if not force_refresh and _token["value"] and time.time() < float(_token["expires_at"]) - 60:
        return str(_token["value"])

    async with _token_lock:
        if not force_refresh and _token["value"] and time.time() < float(_token["expires_at"]) - 60:
            return str(_token["value"])

        config = settings()
        resp = await _client.post(
            TOKEN_URL,
            data={
                "client_id": config.google_client_id,
                "client_secret": config.google_client_secret,
                "refresh_token": config.drive_refresh_token,
                "grant_type": "refresh_token",
            },
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Drive token refresh failed: {resp.text[:300]}")
        payload = resp.json()
        _token["value"] = payload["access_token"]
        _token["expires_at"] = time.time() + payload.get("expires_in", 3600)
        return str(_token["value"])


def _to_entry(raw: dict[str, Any]) -> DriveEntry:
    """Normalise one Drive file resource.

    Drive returns `size` as a *string* because int64 does not survive JSON,
    and omits `videoMediaMetadata` entirely until it has finished processing
    a freshly uploaded file. Both are silent surprises if assumed away.
    """
    size = raw.get("size")
    millis = (raw.get("videoMediaMetadata") or {}).get("durationMillis")
    return DriveEntry(
        id=raw["id"],
        name=raw["name"],
        mime_type=raw.get("mimeType", ""),
        size_bytes=int(size) if size is not None else None,
        duration_s=round(int(millis) / 1000, 3) if millis is not None else None,
    )


async def _get_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    """GET a Drive JSON endpoint, refreshing once on 401 and backing off on 403/429."""
    for attempt in range(_MAX_RETRIES):
        token = await access_token(force_refresh=attempt == 1)
        resp = await _client.get(url, params=params, headers={"Authorization": f"Bearer {token}"})
        if resp.status_code == 200:
            return dict(resp.json())
        if resp.status_code == 401 and attempt == 0:
            continue
        if resp.status_code in _RETRYABLE and attempt < _MAX_RETRIES - 1:
            await asyncio.sleep(2**attempt)
            continue
        raise HTTPException(resp.status_code, f"Drive error: {resp.text[:300]}")
    raise HTTPException(502, "Drive unavailable after retries")


async def list_children(folder_id: str) -> list[DriveEntry]:
    """Every non-trashed direct child of a folder.

    Paginates. The default page is 100 items, so without the pageToken loop
    the first genuinely large course would silently truncate.
    """
    entries: list[DriveEntry] = []
    page_token: str | None = None
    while True:
        params: dict[str, Any] = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": _LIST_FIELDS,
            "pageSize": 200,
            "orderBy": "name",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        payload = await _get_json(FILES_URL, params)
        entries.extend(_to_entry(raw) for raw in payload.get("files", []))
        page_token = payload.get("nextPageToken")
        if not page_token:
            return entries


async def get_metadata(file_id: str) -> DriveEntry:
    payload = await _get_json(
        f"{FILES_URL}/{file_id}",
        {
            "fields": "id,name,size,mimeType,videoMediaMetadata(durationMillis)",
            "supportsAllDrives": "true",
        },
    )
    return _to_entry(payload)


async def open_range(file_id: str, range_header: str) -> httpx.Response:
    """Open a streaming response for a byte range, status code untouched.

    The caller owns the returned response and must close it. A 401 forces one
    token refresh and retry, because otherwise a revoked or clock-skewed token
    surfaces to the user as a video that simply stops.
    """
    for attempt in range(_MAX_RETRIES):
        token = await access_token(force_refresh=attempt == 1)
        upstream = await _client.send(
            _client.build_request(
                "GET",
                f"{FILES_URL}/{file_id}",
                params={"alt": "media", "supportsAllDrives": "true"},
                headers={"Authorization": f"Bearer {token}", "Range": range_header},
            ),
            stream=True,
        )
        if upstream.status_code < 400:
            return upstream

        body = await upstream.aread()
        await upstream.aclose()
        if upstream.status_code == 401 and attempt == 0:
            continue
        if upstream.status_code in _RETRYABLE and attempt < _MAX_RETRIES - 1:
            await asyncio.sleep(2**attempt)
            continue
        raise HTTPException(upstream.status_code, body.decode("utf-8", "replace")[:300])
    raise HTTPException(502, "Drive unavailable after retries")
