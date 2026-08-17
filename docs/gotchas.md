# Gotchas

Sharp edges, collected. Each of these costs an afternoon if you meet it cold, and none of them produce an error message that points at the cause.

---

## Video

### Chrome on iPhone is not Chrome

Apple requires every iOS browser to use WebKit. Despite the EU's DMA supposedly opening this up, no browser has actually shipped a non-WebKit engine on iOS — the Blink work exists only as prototypes. So Chrome on the phone is a Chrome-shaped interface over Safari's video stack.

**Consequence:** "we only support Chrome" does not let you skip any of the WebKit rules below. Two engines are always in play in this project.

### The URL must end in a video extension

WebKit requires a matching file extension in the URL path, on top of a correct `Content-Type`. Chrome on desktop doesn't care.

```
/lectures/42/stream.mp4     ✅
/lectures/42/stream         ❌ iPhone renders nothing, no useful error
```

This is the most common cause of "works on my laptop, black box on my phone", and the least guessable. Check it first, always.

### WebKit probes with a tiny range and demands 206

Playback opens with a request for roughly the first two bytes, purely to check the server understands ranges:

```
Range: bytes=0-1   →   must be answered   206 Partial Content
                                          Content-Range: bytes 0-1/734003200
```

Answer `200 OK` and Safari refuses to render the video at all — even though the file is perfect and plays locally. Pass the upstream status code straight through rather than hardcoding 200.

### `playsinline` or iOS hijacks the video

Without it, every play goes fullscreen on iPhone. Kills any side-by-side player-and-notes layout instantly.

```html
<video controls playsinline src="…/stream.mp4"></video>
```

### H.265 splits your two engines

WebKit plays HEVC happily. Desktop Chrome's support is hardware-dependent. So an H.265 file works on the phone and fails on the laptop — the confusing direction, because you'll assume the phone is the fragile one.

**H.264 + AAC works everywhere.** Verify on ingest:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name \
        -of default=nw=1:nk=1 file.mp4      # want: h264
```

### faststart, or the file won't start on cellular

Without the moov atom at the front of the file, the player must fetch the end before it can begin. Tolerable on wifi, painful on mobile data.

```bash
ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4
```

Cheap (`-c copy`, no re-encode) and worth doing over the whole course as a batch before upload.

### Never buffer a video response

`stream=True` plus an async generator. Reading a response body into memory works fine on a 5 MB test clip and falls over on a real 400 MB lecture. This is the single easiest way to turn a working proxy into an OOM.

---

## Auth

### `<video src>` can't send an Authorization header

Not to Drive, and not to your own API either — the problem recurses. The stream URL therefore carries a short-lived JWT in the query string:

```
GET /lectures/42/stream-url  →  { "url": "/lectures/42/stream.mp4?t=eyJ…" }
```

Don't "clean this up" into a header. There's no way to set one on a video element.

### Firebase sign-in gives no Google refresh token

The popup flow returns a Google *access* token valid ~1 hour, and no refresh token. There's no server-side renewal path from it.

Hence the separate one-time offline-consent flow in `spike/get_refresh_token.py`. See decision 5.

### No refresh token on re-consent

Google only returns `refresh_token` on the *first* consent for a client. Run the script twice and the second run comes back without one.

Fix: revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then re-run. (`prompt=consent` in the auth URL is meant to force it, and mostly does — revoking is the reliable answer.)

---

## Data

### Sort naturally, not lexicographically

`10. Advanced` sorts before `9. Basics` under a plain string sort. Course listings are full of this, and it makes the whole app feel broken in a way users can't quite articulate.

Store an explicit `orderIdx` at scan time — `module_index * 1000 + lecture_index` — and sort on that.

### Key on Drive's file ID, never a path hash

Drive preserves `fileId` across renames and moves. Path hashes don't, so reorganising a folder silently orphans every note in it.

### Firestore needs the composite index declared

`where('due','<=',now).orderBy('due')` requires a composite index. It works in the emulator and fails in production with a link to create it. Put it in `firestore.indexes.json` before deploying rather than discovering it live.

---

## Infrastructure

### Cloud Run needs the timeout raised

Default request timeout will cut long streams. Set 3600 s, and concurrency to 4 — one viewer, but a seek can briefly overlap the stream it's replacing.

### `--host 0.0.0.0` for anything you'll test on the phone

Bound to localhost, the dev server is invisible from the LAN, and the failure looks like a network problem rather than a flag you forgot.

### Cloud Functions vs Cloud Run

Cloud Run. Functions supports Python but is a poor fit for long-lived streaming responses. Both need the Blaze plan — usage stays inside the free allotment, Google just wants a card on file.
