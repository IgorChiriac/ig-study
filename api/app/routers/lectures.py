"""The video path.

Three things in here are load-bearing. Each of them costs an afternoon to
rediscover, and none produces an error message that points at the cause:

  1. The route ends in `.mp4`. WebKit requires a matching video extension in
     the URL path on top of a correct Content-Type, and Chrome on iPhone *is*
     WebKit. Renaming this to `/stream` breaks the phone and nothing else.

  2. Drive's status code is passed straight through. Playback opens with a
     roughly two byte range request purely to check the server understands
     ranges; it must be answered 206. Hardcode 200 and iOS renders nothing.

  3. The body is streamed, never buffered.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app import drive, store, usage
from app.auth import current_uid, sign_stream_token, stream_token_uid, verify_stream_token

router = APIRouter(prefix="/lectures", tags=["lectures"])

_STREAM_CACHE_CONTROL = "private, max-age=3600"


class StreamUrl(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    path: str
    url: str
    expires_at: int = Field(alias="expiresAt")


@router.get("/{lecture_id}/stream-url", response_model=StreamUrl)
async def stream_url(
    lecture_id: str,
    request: Request,
    uid: Annotated[str, Depends(current_uid)],
) -> StreamUrl:
    """Mint a short-lived URL the video element can use.

    Ownership is checked here, once, rather than on every range request: the
    stream token that comes out is already scoped to this one lecture.
    """
    project_id = await store.find_lecture_project(uid, lecture_id)
    if project_id is None:
        raise HTTPException(404, "No such lecture for this user")

    token, expires_at = sign_stream_token(lecture_id, uid)
    path = f"/lectures/{lecture_id}/stream.mp4?t={token}"
    return StreamUrl(
        path=path,
        url=str(request.base_url).rstrip("/") + path,
        expiresAt=expires_at,
    )


@router.api_route("/{lecture_id}/stream.mp4", methods=["GET", "HEAD"])
async def stream_video(
    request: Request,
    lecture_id: Annotated[str, Depends(verify_stream_token)],
) -> Response:
    """Proxy a byte range from Drive.

    The lecture id *is* the Drive file id -- documents are keyed on it because
    Drive preserves that id across renames and moves -- so serving a seek costs
    no metadata lookup and no Firestore read.

    HEAD is declared explicitly. Starlette's plain Route folds HEAD into any
    GET route, but FastAPI's APIRoute does not, so without listing it here a
    HEAD request gets a 405 and the short-circuit below never runs.
    """
    if request.method == "HEAD":
        return Response(
            status_code=200,
            headers={
                "accept-ranges": "bytes",
                "content-type": "video/mp4",
                "cache-control": _STREAM_CACHE_CONTROL,
            },
        )

    range_header = request.headers.get("range", "bytes=0-")
    upstream = await drive.open_range(lecture_id, range_header)

    headers = {
        key: upstream.headers[key]
        for key in ("content-range", "content-length")
        if key in upstream.headers
    }
    headers["accept-ranges"] = "bytes"
    headers["content-type"] = "video/mp4"
    headers["cache-control"] = _STREAM_CACHE_CONTROL

    owner = stream_token_uid(request.query_params.get("t", ""))

    async def body():
        sent = 0
        try:
            async for chunk in upstream.aiter_bytes(drive.CHUNK):
                sent += len(chunk)
                yield chunk
        finally:
            await upstream.aclose()
            await usage.record_stream(owner, sent)

    return StreamingResponse(body(), status_code=upstream.status_code, headers=headers)
