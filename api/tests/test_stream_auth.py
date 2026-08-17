"""The stream token is the only thing standing in front of the video bytes.

It travels in a query string, so it lands in browser history, referrer headers
and Cloud Run request logs. These tests pin the two properties that make that
acceptable: it expires, and it unlocks exactly one lecture.
"""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi import HTTPException

from app import auth
from app.config import settings


@pytest.fixture(autouse=True)
def _secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STREAM_JWT_SECRET", "test-signing-key-long-enough-for-hs256")
    monkeypatch.setenv("STREAM_TOKEN_TTL_S", "3600")
    settings.cache_clear()
    yield
    settings.cache_clear()


async def test_round_trip_unlocks_its_own_lecture() -> None:
    token, expires_at = auth.sign_stream_token("drive-file-abc", "user-123")
    assert await auth.verify_stream_token("drive-file-abc", token) == "drive-file-abc"
    assert expires_at > time.time()


async def test_token_for_one_lecture_does_not_unlock_another() -> None:
    token, _ = auth.sign_stream_token("drive-file-abc", "user-123")
    with pytest.raises(HTTPException) as caught:
        await auth.verify_stream_token("drive-file-xyz", token)
    assert caught.value.status_code == 403


async def test_missing_token_is_rejected() -> None:
    with pytest.raises(HTTPException) as caught:
        await auth.verify_stream_token("drive-file-abc", "")
    assert caught.value.status_code == 401


async def test_expired_token_is_rejected() -> None:
    stale = jwt.encode(
        {"lid": "drive-file-abc", "aud": auth._STREAM_AUDIENCE, "exp": int(time.time()) - 5},
        settings().stream_jwt_secret,
        algorithm="HS256",
    )
    with pytest.raises(HTTPException) as caught:
        await auth.verify_stream_token("drive-file-abc", stale)
    assert caught.value.status_code == 401


async def test_token_signed_with_another_key_is_rejected() -> None:
    forged = jwt.encode(
        {"lid": "drive-file-abc", "aud": auth._STREAM_AUDIENCE, "exp": int(time.time()) + 600},
        "not-the-signing-key",
        algorithm="HS256",
    )
    with pytest.raises(HTTPException) as caught:
        await auth.verify_stream_token("drive-file-abc", forged)
    assert caught.value.status_code == 401


async def test_firebase_id_token_is_not_accepted_as_a_stream_token() -> None:
    """Different secret, different audience — a leaked stream URL is not an identity."""
    shaped_like_firebase = jwt.encode(
        {"sub": "user-123", "aud": "ig-study", "exp": int(time.time()) + 600},
        settings().stream_jwt_secret,
        algorithm="HS256",
    )
    with pytest.raises(HTTPException) as caught:
        await auth.verify_stream_token("drive-file-abc", shaped_like_firebase)
    assert caught.value.status_code == 401


async def test_token_carries_the_uid_for_byte_accounting() -> None:
    """The video request has no Firebase token, so egress is attributed here."""
    token, _ = auth.sign_stream_token("drive-file-abc", "user-123")
    assert auth.stream_token_uid(token) == "user-123"


async def test_uid_lookup_on_a_forged_token_returns_empty_not_a_crash() -> None:
    forged = jwt.encode(
        {"lid": "drive-file-abc", "uid": "attacker", "aud": auth._STREAM_AUDIENCE},
        "not-the-signing-key",
        algorithm="HS256",
    )
    assert auth.stream_token_uid(forged) == ""
