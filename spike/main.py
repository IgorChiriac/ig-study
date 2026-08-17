"""
Step 0 spike: prove a Google Drive file streams and *seeks* through a Python
proxy, in desktop Chrome and in Chrome on the iPhone.

This is the only step that can invalidate the rest of the plan, so it is
deliberately the cheapest one to run. It is throwaway code — the real
endpoint lives in the API later — but the three things it gets right are
exactly the three that will otherwise cost you an afternoon each:

  1. The route ends in `.mp4`.  WebKit requires a video file extension in the
     URL. Chrome on desktop does not care; Chrome on iPhone is WebKit and
     silently refuses to render, with no useful error.

  2. Drive's 206 status is passed straight through.  WebKit opens with a
     request for roughly the first two bytes purely to check the server
     understands ranges. Answer 200 and it will not play the video at all.

  3. The response is streamed, never buffered.  `stream=True` plus an async
     generator keeps memory flat no matter how large the file is.

Every upstream request is logged so you can watch the probe happen.

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import contextlib
import os
import socket
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
REFRESH_TOKEN = os.environ.get("DRIVE_REFRESH_TOKEN", "")
FILE_ID = os.environ.get("DRIVE_FILE_ID", "")

TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_FILE = "https://www.googleapis.com/drive/v3/files/{file_id}"
CHUNK = 256 * 1024  # 256 KiB — big enough to be efficient, small enough to stay responsive

# connect timeout only; a stream has no meaningful total deadline
_client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=15.0))
_token: dict[str, object] = {"value": None, "expires_at": 0.0}


async def drive_token() -> str:
    """Return a valid Drive access token, refreshing it when it is close to expiry."""
    if _token["value"] and time.time() < float(_token["expires_at"]) - 60:
        return str(_token["value"])

    resp = await _client.post(
        TOKEN_URL,
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "refresh_token": REFRESH_TOKEN,
            "grant_type": "refresh_token",
        },
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"Drive token refresh failed: {resp.text[:300]}")

    payload = resp.json()
    _token["value"] = payload["access_token"]
    _token["expires_at"] = time.time() + payload.get("expires_in", 3600)
    print("  [auth] refreshed Drive access token")
    return str(_token["value"])


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    missing = [
        name
        for name, val in (
            ("GOOGLE_CLIENT_ID", CLIENT_ID),
            ("GOOGLE_CLIENT_SECRET", CLIENT_SECRET),
            ("DRIVE_REFRESH_TOKEN", REFRESH_TOKEN),
            ("DRIVE_FILE_ID", FILE_ID),
        )
        if not val
    ]
    if missing:
        print(f"\n  !! Missing env vars: {', '.join(missing)}")
        print("     Copy .env.example to .env and fill it in.\n")
    else:
        print(f"\n  Test page:  http://{_lan_ip()}:8000/")
        print("  Open that URL on your iPhone too — same wifi, no HTTPS needed.\n")
    yield
    await _client.aclose()


app = FastAPI(title="ig-study step 0 spike", lifespan=lifespan)


def _lan_ip() -> str:
    """Best-effort local network address, so you can reach this from the phone."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets sent; just picks the outbound interface
        ip = s.getsockname()[0]
        s.close()
        return str(ip)
    except OSError:
        return "localhost"


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "index.html"))


@app.get("/meta")
async def meta() -> JSONResponse:
    """File metadata, so the test page can show what it is actually playing."""
    resp = await _client.get(
        DRIVE_FILE.format(file_id=FILE_ID),
        params={"fields": "id,name,size,mimeType,videoMediaMetadata"},
        headers={"Authorization": f"Bearer {await drive_token()}"},
    )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, resp.text[:300])
    return JSONResponse(resp.json())


# The `.mp4` extension is load-bearing. See gotcha 1 in the module docstring.
@app.get("/video.mp4")
async def video(request: Request) -> StreamingResponse:
    range_header = request.headers.get("range", "bytes=0-")

    upstream = await _client.send(
        _client.build_request(
            "GET",
            DRIVE_FILE.format(file_id=FILE_ID),
            params={"alt": "media"},
            headers={
                "Authorization": f"Bearer {await drive_token()}",
                "Range": range_header,
            },
        ),
        stream=True,
    )

    if upstream.status_code >= 400:
        body = await upstream.aread()
        await upstream.aclose()
        raise HTTPException(upstream.status_code, body.decode("utf-8", "replace")[:300])

    headers = {
        key: upstream.headers[key]
        for key in ("content-range", "content-length")
        if key in upstream.headers
    }
    headers["accept-ranges"] = "bytes"
    headers["content-type"] = "video/mp4"
    headers["cache-control"] = "no-store"

    # This log line is the point of the spike. On the iPhone you should see a
    # tiny opening range (something like `bytes=0-1`) answered with 206.
    ua = request.headers.get("user-agent", "")
    engine = "WebKit" if ("iPhone" in ua or "iPad" in ua) else "Blink"
    print(
        f"  [{engine:<6}] {range_header:<24} -> {upstream.status_code} "
        f"{headers.get('content-range', '(no content-range)')}"
    )

    async def body_iter():
        try:
            async for chunk in upstream.aiter_bytes(CHUNK):
                yield chunk
        finally:
            await upstream.aclose()

    # Passing upstream.status_code through is what satisfies gotcha 2.
    return StreamingResponse(body_iter(), status_code=upstream.status_code, headers=headers)
