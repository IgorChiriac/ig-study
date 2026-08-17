#!/usr/bin/env python3
"""
One-time: obtain a Google Drive refresh token.

You run this ONCE, ever. It opens a browser, you consent, and it prints a
refresh token that never expires (unless you revoke it or leave it unused
for six months). Put that token in .env and forget this script exists.

Why a refresh token and not the one Firebase gives you: Firebase's popup
sign-in returns a Google *access* token valid ~1 hour and no refresh token.
That is fine for a click and useless for a proxy that must keep serving byte
ranges through a long study session, or for a background folder scan.

Prerequisites (see spike/README.md for the click-by-click):
  1. A Google Cloud project with the Drive API enabled
  2. An OAuth 2.0 Client ID of type "Desktop app"
  3. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET exported, or in .env

Usage:
    python get_refresh_token.py
"""

from __future__ import annotations

import http.server
import os
import secrets
import sys
import time
import urllib.parse
import webbrowser

import httpx

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional
    pass

PORT = int(os.environ.get("OAUTH_CALLBACK_PORT", "8765"))
REDIRECT_HOST = os.environ.get("OAUTH_CALLBACK_HOST", "localhost")
REDIRECT_URI = f"http://{REDIRECT_HOST}:{PORT}/callback"
SCOPE = "https://www.googleapis.com/auth/drive.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CONSENT_TIMEOUT_S = 300

_received: dict[str, str | None] = {}

_PAGE = b"""<!doctype html><meta charset="utf-8">
<style>body{font:16px/1.6 system-ui;margin:12vh auto;max-width:32rem;padding:0 1rem}</style>
<h2>Consent received.</h2>
<p>Close this tab and go back to your terminal.</p>"""


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_error(404)
            return
        params = urllib.parse.parse_qs(parsed.query)
        _received["code"] = params.get("code", [None])[0]
        _received["state"] = params.get("state", [None])[0]
        _received["error"] = params.get("error", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(_PAGE)))
        self.end_headers()
        self.wfile.write(_PAGE)

    def log_message(self, *args):  # silence the default access log
        pass


def _callback_received() -> bool:
    """Whether the OAuth redirect itself has arrived.

    The browser may send other requests first — a favicon probe, a speculative
    connection — and `_Handler` 404s those without touching `_received`. Serving
    exactly one request would consume such a probe and look like a failed
    consent, which is expensive here: re-running needs a revoke at
    myaccount.google.com/permissions first. So the caller serves requests until
    this returns True.
    """
    return bool(_received.get("code") or _received.get("error"))


def main() -> int:
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n"
            "Copy .env.example to .env and fill them in, or export them.",
            file=sys.stderr,
        )
        return 1

    state = secrets.token_urlsafe(24)
    auth_url = f"{AUTH_URL}?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": SCOPE,
            # These two are the whole point — without them Google returns an
            # access token only, and you are back where Firebase left you.
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
    )

    try:
        server = http.server.HTTPServer((REDIRECT_HOST, PORT), _Handler)
    except OSError as exc:
        print(
            f"Cannot listen on {REDIRECT_HOST}:{PORT} ({exc}).\n"
            f"Set OAUTH_CALLBACK_PORT to a free port, then register\n"
            f"    http://{REDIRECT_HOST}:<that port>/callback\n"
            f"as an authorized redirect URI on the OAuth client.",
            file=sys.stderr,
        )
        return 1

    server.timeout = CONSENT_TIMEOUT_S
    print(f"Redirect URI in use: {REDIRECT_URI}")
    print("It must be registered on the OAuth client if that client is type 'Web application'.\n")
    print(f"Opening your browser. If nothing happens, visit:\n\n{auth_url}\n")
    webbrowser.open(auth_url)

    deadline = time.monotonic() + CONSENT_TIMEOUT_S
    while not _callback_received():
        if time.monotonic() > deadline:
            print(
                f"No callback within {CONSENT_TIMEOUT_S}s — did the browser open?",
                file=sys.stderr,
            )
            server.server_close()
            return 1
        server.handle_request()
    server.server_close()

    if _received.get("error"):
        print(f"Authorization failed: {_received['error']}", file=sys.stderr)
        return 1
    if _received.get("state") != state:
        print("State mismatch — aborting.", file=sys.stderr)
        return 1
    code = _received.get("code")
    if not code:
        print("No authorization code received.", file=sys.stderr)
        return 1

    resp = httpx.post(
        TOKEN_URL,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": REDIRECT_URI,
            "grant_type": "authorization_code",
        },
        timeout=30.0,
    )
    if resp.status_code != 200:
        print(f"Token exchange failed ({resp.status_code}):\n{resp.text}", file=sys.stderr)
        return 1

    payload = resp.json()
    refresh_token = payload.get("refresh_token")
    if not refresh_token:
        print(
            "No refresh_token in the response. This happens when you have already\n"
            "granted consent for this client. Revoke it at\n"
            "  https://myaccount.google.com/permissions\n"
            "and run this again.",
            file=sys.stderr,
        )
        return 1

    print("\n" + "=" * 62)
    print("Add this to your .env — it does not expire:\n")
    print(f"DRIVE_REFRESH_TOKEN={refresh_token}")
    print("=" * 62 + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
