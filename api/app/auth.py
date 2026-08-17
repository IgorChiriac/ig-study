"""Two credentials, two jobs.

The Firebase ID token answers *who are you* and gates the JSON API. The stream
token answers *may this URL fetch these bytes* and gates the video route only.

They are deliberately not the same thing. A `<video src>` cannot send an
Authorization header, so whatever guards the video route travels in the query
string — and a query string lands in browser history, referrer headers and
Cloud Run request logs. Putting a full-privilege Firebase ID token there would
hand the whole account to anything that reads a log line. The stream token is
scoped to one lecture and expires in an hour instead.
"""

from __future__ import annotations

import asyncio
import time

import firebase_admin
import jwt
from fastapi import Depends, HTTPException, Query, Request
from firebase_admin import auth as firebase_auth

from app.config import settings

_STREAM_AUDIENCE = "ig-study/stream"
_app_lock = asyncio.Lock()
_app: firebase_admin.App | None = None


async def _firebase_app() -> firebase_admin.App:
    """Initialise the Admin SDK once, lazily, under a lock."""
    global _app
    if _app is not None:
        return _app
    async with _app_lock:
        if _app is None:
            _app = firebase_admin.initialize_app(
                options={"projectId": settings().firebase_project_id}
            )
    return _app


async def current_uid(request: Request) -> str:
    """Verify the caller's Firebase ID token and return their uid.

    Runs the verification off the event loop: it is RSA work plus an
    occasional key fetch, and the Admin SDK is synchronous.
    """
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")

    await _firebase_app()
    try:
        claims = await asyncio.to_thread(firebase_auth.verify_id_token, header[7:])
    except Exception as exc:
        raise HTTPException(401, "Invalid or expired ID token") from exc

    uid = claims.get("uid") or claims.get("sub")
    if not uid:
        raise HTTPException(401, "Token carries no uid")
    return str(uid)


def sign_stream_token(lecture_id: str, uid: str) -> tuple[str, int]:
    """Mint a token that unlocks exactly one lecture.

    Returns the token and its absolute expiry. The lecture is a claim rather
    than an implicit scope so that a leaked URL exposes one video instead of
    the whole library. The uid rides along so the byte accounting on the
    stream route knows whose egress it is -- the video request carries no
    Firebase token to read it from.
    """
    expires_at = int(time.time()) + settings().stream_token_ttl_s
    token = jwt.encode(
        {"lid": lecture_id, "uid": uid, "aud": _STREAM_AUDIENCE, "exp": expires_at},
        settings().stream_jwt_secret,
        algorithm="HS256",
    )
    return token, expires_at


async def verify_stream_token(lecture_id: str, t: str = Query(default="")) -> str:
    """Dependency for the video route. Returns the lecture id it unlocks."""
    if not t:
        raise HTTPException(401, "Missing stream token")
    try:
        claims = jwt.decode(
            t,
            settings().stream_jwt_secret,
            algorithms=["HS256"],
            audience=_STREAM_AUDIENCE,
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(401, "Stream token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(401, "Invalid stream token") from exc

    if claims.get("lid") != lecture_id:
        raise HTTPException(403, "Stream token is for a different lecture")
    return lecture_id


def stream_token_uid(t: str) -> str:
    """The uid inside an already-verified stream token, or empty if absent.

    Tokens minted before the uid claim existed stay valid until they expire,
    so this never raises -- unattributed bytes are better than a broken video.
    """
    try:
        claims = jwt.decode(
            t,
            settings().stream_jwt_secret,
            algorithms=["HS256"],
            audience=_STREAM_AUDIENCE,
        )
    except jwt.InvalidTokenError:
        return ""
    return str(claims.get("uid", ""))


CurrentUid = Depends(current_uid)
