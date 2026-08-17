# Step 0 — the spike

**Purpose:** prove that a Google Drive video streams *and seeks* through a Python proxy, on both engines you'll actually use.

This is the only step that can invalidate the rest of the plan, and it's the cheapest one to run. Do it before writing anything else. Budget 1–2 hours, most of which is Google Cloud console clicking.

---

## Setup

### 1. Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (or reuse the one Firebase created — a Firebase project *is* a GCP project).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill in the required fields. Add yourself as a **Test user** — you don't need to publish or get verified for personal use.
4. **APIs & Services → Credentials** → *Create credentials* → **OAuth client ID** → application type **Desktop app**.
5. Copy the client ID and secret.

> Desktop app, not Web app. Desktop clients permit the `http://localhost` redirect this script uses without registering redirect URIs.

### 2. Environment

```bash
cd spike
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then fill in the two client values
```

### 3. Refresh token

```bash
python get_refresh_token.py
```

Browser opens, you consent, the token prints. Paste it into `.env` as `DRIVE_REFRESH_TOKEN`.

You do this **once, ever**. It doesn't expire.

> No `refresh_token` in the response? You've already consented for this client. Revoke it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-run.

### 4. A test video

Pick one real course video — ideally a longer one, since short files hide seek problems.

```bash
ffmpeg -i "5. Calculating Read and Write Capacity Units (RCUWCU).mp4" \
       -c copy -movflags +faststart test.mp4
```

Upload `test.mp4` to Drive, open it, and take the ID from the URL:

```
https://drive.google.com/file/d/1AbC...XyZ/view
                               ^^^^^^^^^^^^ this is DRIVE_FILE_ID
```

Also confirm the codec is H.264 + AAC — the one combination both engines agree on:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name \
        -of default=nw=1:nk=1 test.mp4     # want: h264
```

---

## Run

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` matters — it's what lets the phone reach it. The startup banner prints your LAN URL.

- **Desktop:** open `http://localhost:8000`
- **iPhone:** same wifi, open the printed LAN URL (e.g. `http://192.168.1.42:8000`) in Chrome

No HTTPS needed for either.

---

## What to do

1. Press play.
2. Click through the percentage buttons.
3. Hit **Hammer: 10 random seeks**.
4. Repeat all of it on the iPhone.
5. Watch the uvicorn terminal the whole time.

The terminal is the real instrument. You're looking for lines like:

```
  [WebKit] bytes=0-1                 -> 206 bytes 0-1/734003200
  [WebKit] bytes=0-                  -> 206 bytes 0-734003199/734003200
  [WebKit] bytes=41943040-           -> 206 bytes 41943040-734003199/734003200
```

That first tiny range is WebKit checking whether you understand HTTP ranges. **It must be answered with 206.** Answer 200 and iOS refuses to render the video at all, with no useful error anywhere.

---

## Verdict

| Result | Meaning | Do this |
|---|---|---|
| Plays and seeks on both, worst seek < 1.5 s | ✅ | Build **path A**. The plan stands unchanged. |
| Plays on both, seeks 1.5–4 s | ⚠️ | Usable. Try `CHUNK = 1 MiB` and re-test; if it's still sluggish, weigh the iframe fallback. |
| Desktop fine, iPhone won't render | ❌ | Almost always one of three things — see below. |
| Neither works | ❌ | Not a WebKit issue. Check the uvicorn log for a 401/403 from Drive. |

### iPhone won't render — check in this order

1. **Is the URL ending in `.mp4`?** WebKit requires a video extension in the path. This is the most common cause and the least guessable.
2. **Is the probe answered with 206?** Look for the `bytes=0-1` line. If it says 200, the status isn't being passed through.
3. **Is it H.264 + AAC?** `ffprobe` it. H.265 will play on the phone and fail on your laptop, which is the *other* confusing direction.

Error code 4 (`SRC_NOT_SUPPORTED`) in the page's log means one of the three above.

---

## After it passes

Delete this directory, or keep it as a reference. The real streaming endpoint in `api/` reuses the same three ideas — extension in the route, status passthrough, streamed body — with the file ID coming from Firestore instead of an env var.
