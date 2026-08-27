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

### iPhone has no element fullscreen — only `<video>` has

`Element.requestFullscreen` and `webkitRequestFullscreen` are **both undefined**
on iPhone. Not prefixed, not partial — absent. (iPad has them; iPhone does not.)
The only thing that can go fullscreen there is a video element, via the
non-standard `HTMLVideoElement.webkitEnterFullscreen()`.

So a "fullscreen the player and the notes together" control cannot exist on the
phone. Feature-detect and branch, rather than calling `requestFullscreen()` and
getting a button that silently does nothing:

```ts
if (supportsElementFullscreen()) stage.requestFullscreen();
else video.webkitEnterFullscreen();      // iPhone: native player, no notes
```

Two further traps on the WebKit path:

- **`webkitEnterFullscreen()` is a no-op before metadata loads** (`readyState < 1`),
  which is exactly when someone taps the button on a cold page. Wait for
  `loadedmetadata` and call it once.
- **It does not set `document.fullscreenElement`**, and fires
  `webkitbeginfullscreen` / `webkitendfullscreen` on the video rather than
  `fullscreenchange` on the document. Any "am I fullscreen?" state derived the
  standard way stays `false` throughout.

The YouTube iframe is cross-origin, so none of this is reachable for it — its own
control is the only way in on a phone. Disable the app's button there instead of
offering one that does nothing.

### Autoplaying the next video is blocked, and the block is a rejected promise

Auto-advance crosses a route change and an async stream-URL fetch, which breaks
the user-gesture chain. Blink usually allows the resulting `play()` anyway;
WebKit usually doesn't.

`video.play()` returns a promise that **rejects** — it does not throw, and there
is no event. Ignore it and the page shows a loaded, paused, silent video with no
indication anything went wrong:

```ts
void video.play().catch(() => setAutoplayBlocked(true));   // offer a tap
```

Treat the rejection as the normal outcome on the phone, not an error. The
cross-origin YouTube iframe gives you no signal at all, so there the player just
sits showing its own play button.

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

Hence the separate one-time offline-consent flow in `tools/get_refresh_token.py`. See decision 5.

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

### The index you need is the collection-group one, not a composite

`where('due','<=',now).orderBy('due')` does **not** need a composite index — an inequality plus an `orderBy` on the *same* field is served by Firestore's automatic single-field index. Declaring one is a no-op, and this doc previously claimed otherwise.

What does need declaring: cards live at `users/{uid}/projects/{projectId}/cards`, so "12 due today" across every course is a **collection group** query — and those require an explicit index even for a single field. It's a `fieldOverrides` entry in `firestore.indexes.json`:

```json
{ "collectionGroup": "cards", "fieldPath": "due",
  "indexes": [
    { "order": "ASCENDING",  "queryScope": "COLLECTION" },
    { "order": "DESCENDING", "queryScope": "COLLECTION" },
    { "order": "ASCENDING",  "queryScope": "COLLECTION_GROUP" }
  ] }
```

Keep the two COLLECTION entries — a `fieldOverride` replaces *all* index config for that field, so omitting them silently drops the defaults.

A real composite index becomes necessary the moment a second field joins the query (`where('suspended','==',false).orderBy('due')`). That one does fail in production with a creation link, which is the failure mode this entry originally described.

---

## Claude API

### The two models take different request shapes

`claude-sonnet-5` and `claude-haiku-4-5` are different API generations. A request body that works on one can 400 on the other, and the errors don't say "wrong generation".

| | `claude-sonnet-5` | `claude-haiku-4-5` |
|---|---|---|
| `output_config={"effort": …}` | Supported, defaults to `high` | **400 — the parameter errors on this model** |
| Thinking | On by default; `budget_tokens` is a 400 | Old `budget_tokens` form; leave unset for grading |
| `temperature` / `top_p` / `top_k` | 400 at non-default values | Accepted |
| Assistant prefills | 400 | Accepted |

`effort` on the grading call is the one most likely to bite — it reads like a harmless optimisation hint and is a hard error.

### Never append a date suffix to a model ID

`claude-sonnet-5` and `claude-haiku-4-5` are complete as written. A constructed ID like `claude-sonnet-5-20260401` 404s. (`claude-haiku-4-5-20251001` happens to resolve — prefer the alias anyway.)

### Prompt caching below the minimum fails silently

The minimum cacheable prefix is **4096 tokens on Haiku 4.5**, **1024 on Sonnet 5**. Below that, a `cache_control` marker returns no error and no cache — `cache_creation_input_tokens` is just `0`. A grading prompt is a few hundred tokens, so caching it does nothing at all. Verify any cache you think you have by reading `usage.cache_read_input_tokens`.

### `max_tokens` caps thinking plus text

It's not an output-length budget. Sonnet 5 thinks by default, so a `max_tokens` sized tightly around the expected JSON can truncate the answer mid-object. Size the card call at ~4–8K.

---

## Infrastructure

### Cloud Run needs the timeout raised

Default request timeout will cut long streams. Set 3600 s, and concurrency to 4 — one viewer, but a seek can briefly overlap the stream it's replacing.

### `--host 0.0.0.0` for anything you'll test on the phone

Bound to localhost, the dev server is invisible from the LAN, and the failure looks like a network problem rather than a flag you forgot.

### Cloud Functions vs Cloud Run

Cloud Run. Functions supports Python but is a poor fit for long-lived streaming responses. Both need the Blaze plan — usage stays inside the free allotment, Google just wants a card on file.
