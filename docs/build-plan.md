# ig-study — build plan

**Locked.** Google Drive storage · FastAPI streaming proxy · Firebase UI · Claude-powered cards and quiz.

> Why these choices and what was rejected: [`decisions.md`](decisions.md). The sharp edges, collected: [`gotchas.md`](gotchas.md).

---

## Architecture

```
┌──────────────────────────┐
│  React SPA               │   Firebase Hosting
│  desktop + mobile        │
└───┬──────────────────┬───┘
    │ Firebase ID tok  │ <video src="…/stream.mp4?t=jwt">
    ▼                  ▼
┌──────────────┐   ┌──────────────────────┐
│  Firestore   │   │  FastAPI on Cloud Run│
│  notes/cards │   │  ├ /scan             │
│  direct RW   │   │  ├ /stream.mp4  ◄────┼── proxies Range → Drive
│  from client │   │  └ /cards, /answer   │
└──────────────┘   └───────┬──────────┬───┘
                           ▼          ▼
                    ┌───────────┐ ┌──────────┐
                    │ Drive API │ │ Anthropic│
                    └───────────┘ └──────────┘
```

**Split of responsibility.** The SPA talks to Firestore *directly* for notes, seen flags and card state — that's what Firestore is good at, it gives you offline caching and live updates for free, and security rules handle authorisation without a round trip. The Python API exists for the three things the browser can't do: hold the Drive credentials, hold the Anthropic key, and stream video bytes.

That means most of the app never touches your server, so Cloud Run stays scaled to zero except while you're watching a video or generating cards.

---

## 1. Auth — and a correction

I sold you on "one sign-in gives identity and Drive access." That's true for the *access* token, but I under-checked one thing: **Firebase's popup sign-in does not return a Google refresh token.** You get an access token valid ~1 hour and no way to renew it server-side. A 1-hour ceiling is fine for a click; it is not fine for a proxy that must keep serving byte ranges through a long study session, and it's no use at all for a background folder scan.

So the honest design is two credentials with two different jobs:

| Credential | Who holds it | Job |
|---|---|---|
| Firebase ID token | Browser → sent to API and Firestore | *Who are you* |
| Google **refresh** token | Server, in Secret Manager | *Reach Drive, forever* |

And because you're a single user, getting that refresh token is a one-time chore, not a feature to build. Run the OAuth consent once with `access_type=offline&prompt=consent` and scope `drive.readonly` — via the OAuth Playground or a 20-line local script — then paste the refresh token into Secret Manager. **You never need an OAuth callback endpoint at all.** If this ever grows a second user, that's when you build the real flow.

```python
_tok = {"v": None, "exp": 0}

async def drive_token() -> str:
    if _tok["v"] and time.time() < _tok["exp"] - 60:
        return _tok["v"]
    r = await http.post("https://oauth2.googleapis.com/token", data={
        "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "refresh_token": DRIVE_REFRESH_TOKEN, "grant_type": "refresh_token",
    })
    d = r.json()
    _tok.update(v=d["access_token"], exp=time.time() + d["expires_in"])
    return _tok["v"]
```

App-level auth on the API is a FastAPI dependency that verifies the Firebase ID token with `firebase-admin`. Ten lines.

---

## 2. The streaming proxy

This is the part with sharp edges. Three of them will each cost you an afternoon if you don't know them going in.

> **"Chrome only" does not mean you can skip the Safari rules.** Chrome on iPhone is a Chrome interface over Apple's WebKit — no browser has shipped a non-WebKit engine on iOS, even in the EU where the DMA supposedly requires it. So your phone is running Safari's video stack no matter what the icon says. All three gotchas below apply to it. On desktop, Chrome-only does let you skip Firefox testing, which is worth roughly nothing.

### The gotchas

**a. Your own endpoint has the same header problem Drive does.** `<video src>` can't send an `Authorization` header to *your* API either. So the stream URL carries a short-lived JWT in the query string. The SPA asks `GET /lectures/{id}/stream-url`, gets back a path with `?t=…`, and drops that into the video tag.

That token is **API-signed, and not the Firebase ID token.** Firebase ID tokens are full-privilege credentials — handing one to anything that can read a URL is not acceptable, and the URL lands in browser history, referrer headers and Cloud Run request logs. So `verify_stream_jwt` validates a second token with its own design:

| | |
|---|---|
| Signed with | A dedicated secret in Secret Manager — **a third secret**, alongside the Drive refresh token and the Anthropic key |
| Claims | `lecture_id` (required) and `exp`. Scoping to one lecture means a leaked token unlocks one video, not the library |
| TTL | **1 hour.** A seek mid-session reuses the token the page already has, so nothing longer buys you anything |

Step 4 depends on this, so settle it in step 1.

**b. Safari demands a file extension in the URL.** [Safari uniquely requires](https://corevo.io/the-weird-case-of-video-streaming-in-safari/) the URL to end in a matching video extension, on top of a correct `Content-Type`. So the route is `/lectures/{id}/stream.mp4`, **not** `/lectures/{id}/stream`. Chrome doesn't care. iOS silently refuses to play, with no useful error.

**c. Safari probes with a tiny range first.** It opens with a request for roughly the first two bytes purely to check you understand ranges. You must answer **206** with a correct `Content-Range`. Answer 200, and Safari won't render the video at all — even though the file is fine and plays locally.

Get those three right and iOS works. Miss any one and you'll be convinced Drive is at fault when it isn't.

### The endpoint

```python
CHUNK = 256 * 1024

@router.get("/lectures/{lecture_id}/stream.mp4")     # extension matters — see (b)
async def stream(lecture_id: str, request: Request,
                 _=Depends(verify_stream_jwt)):
    lec = await get_lecture(lecture_id)              # cached: drive_file_id, size
    upstream = f"https://www.googleapis.com/drive/v3/files/{lec.drive_file_id}?alt=media"

    r = await client.send(
        client.build_request("GET", upstream, headers={
            "Authorization": f"Bearer {await drive_token()}",
            "Range": request.headers.get("range", "bytes=0-"),
        }),
        stream=True,
    )

    out = {k: v for k, v in r.headers.items()
           if k.lower() in ("content-range", "content-length")}
    out["Content-Type"]  = "video/mp4"
    out["Accept-Ranges"] = "bytes"

    async def body():
        try:
            async for chunk in r.aiter_bytes(CHUNK):
                yield chunk
        finally:
            await r.aclose()

    return StreamingResponse(body(), status_code=r.status_code, headers=out)
```

`r.status_code` passes Drive's 206 straight through — that's what satisfies (c). Never buffer the response; `stream=True` plus an async generator is what keeps memory flat regardless of file size.

Cache `drive_file_id` and `size` on the Firestore lecture doc so a seek doesn't trigger a metadata call. Set Cloud Run's request timeout to 3600 s and concurrency to 4 — you're one person, but a seek can briefly overlap the previous stream.

---

## 3. Firestore

```
users/{uid}/projects/{projectId}
    name              "AWS DynamoDB"
    driveFolderId
    lastScanAt

users/{uid}/projects/{projectId}/lectures/{lectureId}
    driveFileId       stable across renames and moves
    module            "1. Designing Databases with DynamoDB"
    title             "5. Calculating Read and Write Capacity Units (RCUWCU)"
    orderIdx          1005      module*1000 + index → natural sort
    durationS
    sizeBytes
    seen              false
    note              markdown
    positionS         resume point
    updatedAt

users/{uid}/projects/{projectId}/cards/{cardId}
    lectureId, q, a
    due, interval, ease, lapses

users/{uid}/reviews/{reviewId}
    cardId, grade, answeredAt          append-only, for stats
```

Security rules, in full:

```js
match /users/{uid}/{doc=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```

**Indexes.** `where('due','<=',now).orderBy('due')` needs *no* composite index — an inequality filter plus an `orderBy` on the same field is served by the automatic single-field index Firestore builds for you. An earlier version of this plan called for a composite index on `due ASC`; that was a no-op.

The index you actually need is a different one. Cards live at `users/{uid}/projects/{projectId}/cards`, so "what's due today" across every course is a **collection group** query — and collection group queries need an explicitly declared index even for a single field. That's the `fieldOverrides` entry in `firestore.indexes.json`, deployed alongside the rules.

A composite index becomes necessary the moment a second field enters — `where('suspended','==',false).orderBy('due')`, or scoping by `lectureId`. Firestore's error message hands you a creation link when that happens.

`orderIdx` is worth getting right at scan time — sort naturally so `10.` lands after `9.`, not after `1.`. Sorting course lists lexicographically is the single most common way these tools end up feeling broken.

---

## 4. Scanning

`POST /projects/{id}/scan` walks Drive with `files.list`, `q="'{folderId}' in parents and trashed=false"`, recursing into subfolders. Top-level subfolders become modules, video files become lectures.

Ask for `fields=files(id,name,size,mimeType,videoMediaMetadata(durationMillis))` — Drive returns durations for many video files, so you often get the whole playlist timing without ever running `ffprobe`. Fall back to reading `video.duration` in the browser on first play and writing it back.

Re-scan matches on `driveFileId`, inserts only what's new, and reports orphans (files that vanished) rather than deleting notes. Your DynamoDB course lands as 9 modules / ~36 lectures / 4h00m, matching the playlist exactly.

---

## 5. Claude integration

Keys in Secret Manager, never in the client. Both calls use structured output so you're parsing validated JSON, not prose — via `messages.parse()`, which is the right fit when the schema is small and fixed:

```python
response = client.messages.parse(
    model="claude-sonnet-5",
    max_tokens=8192,
    messages=[{"role": "user", "content": prompt}],
    output_format=Cards,          # a Pydantic model
)
cards = response.parsed_output    # validated Cards instance
```

On `messages.create()` the equivalent is `output_config={"format": {"type": "json_schema", "schema": {...}}}`. A top-level `output_format=` on `create()` is the *old* parameter — don't reach for it, and don't use tool schemas either.

> **The trap: these are two different API generations, and the same request shape does not work for both.**
>
> | | `claude-sonnet-5` (cards) | `claude-haiku-4-5` (grading) |
> |---|---|---|
> | Thinking | **On by default.** `budget_tokens` is a 400 | Old-style `budget_tokens` form — but leave `thinking` unset; grading doesn't want it |
> | `output_config={"effort": …}` | Supported, defaults to `high` | **400. The parameter errors on this model** |
> | `temperature` / `top_p` / `top_k` | 400 at any non-default value | Accepted |
> | Assistant prefills | 400 | Accepted |
>
> Both IDs are complete as written — **never append a date suffix.**

Because `max_tokens` caps thinking *plus* response text, and Sonnet 5 thinks by default, size the card-generation call generously (~4–8K) rather than tightly around the expected JSON. For a short note, `output_config={"effort": "medium"}` is likely right — sweep it.

### Card generation — `claude-sonnet-5`

`POST /lectures/{id}/cards:generate` → reads the note from Firestore, returns drafts for you to approve or edit before they're saved.

```
Course: {course} · Module: {module} · Lecture: {title}

The student's notes:
---
{note}
---

Write {n} question/answer cards testing *understanding*, not recall of wording.

- Every question must be answerable from these notes alone.
- Prefer "why" and "when would you" over "what is".
- If the notes contain a formula or number, at least one card must require
  applying it to a new case, not restating it.
- Answers: 1–3 sentences, precise.
- Nothing about the video's structure or the instructor.
```

Schema: `{cards: [{q: string, a: string}]}`

### Grading — `claude-haiku-4-5`

`POST /cards/{id}/answer` with `{text}`.

```
Question:          {q}
Reference answer:  {a}
Student's answer:  {student}

Grade 0–5 on understanding, not wording:
  5 complete and precise
  4 correct, minor imprecision
  3 right idea with a real gap
  2 partially right, core misunderstanding
  1 mostly wrong but on topic
  0 wrong or blank

Be direct and specific. If the method was right and the arithmetic wrong,
say exactly that. Don't soften a 2 into a 3.
```

Schema: `{score: int, verdict: string, missing: string, correction: string}`

The score drives the scheduler; the prose goes on screen. Answering in your own words and being judged on understanding rather than string-matching is the entire reason this isn't just Anki.

### Discussion — optional, phase 2

`POST /lectures/{id}/discuss` streaming SSE, with the note plus surrounding module notes as context. Prompt caching on the course context makes follow-up turns nearly free — that context is large and stable, which is exactly what caching wants.

**Caching does nothing for grading, and fails silently.** The minimum cacheable prefix is **4096 tokens on Haiku 4.5**; a grading prompt (question + reference answer + student answer) is a few hundred. A `cache_control` marker there produces no error and no cache — just `cache_creation_input_tokens: 0`. The minimum is **1024 on Sonnet 5**, so a card-generation call with a large shared course preamble *could* cache, but with 36 lectures generated once each there's nothing to reuse.

---

## 6. Spaced repetition

Plain SM-2. Forty lines, well understood, good enough.

```python
def schedule(card, q: int):
    if q >= 3:
        interval = 1 if card.interval == 0 else 6 if card.interval == 1 \
                   else round(card.interval * card.ease)
        card.ease += 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)
    else:
        interval = 1
        card.ease -= 0.2
        card.lapses += 1
    card.ease = max(1.3, card.ease)
    card.interval = interval
    card.due = today() + timedelta(days=interval)
```

Daily caps of 30 new and 60 reviews, so it never becomes a wall you skip. A card that lapses 8 times gets flagged a **leech** — the UI should suggest rewriting it or re-watching that part of the video, because at that point the card is usually the problem, not you.

---

## 7. Screens

| # | Screen | Contents |
|---|---|---|
| 1 | **Sign in** | Google button. That's it |
| 2 | **Projects** | Course cards with progress rings · *Add project* → Drive folder picker → scan |
| 3 | **Course** | Modules as collapsible sections, seen checkbox per lecture, progress bar, "12 due" badge |
| 4 | **Lecture** | Player left, markdown note editor right (stacked on mobile) · *Mark seen* · *Generate cards* · *Fullscreen* the whole stage · optional *Auto-play next* |
| 5 | **Quiz** | Due card, free-text answer box, Claude's grade + correction, next |
| 6 | **Stats** | Reviews over time, weakest modules, leeches |

Notes autosave to Firestore on a 2-second debounce. Because the SPA writes Firestore directly, that costs you nothing server-side and works offline.

---

## 8. Mobile checklist

Because video plays on your iPhone — where Chrome is WebKit underneath — these stop being optional:

- [ ] `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` over every file before upload — without the moov atom up front, the player fetches the file's tail before it can start. Tolerable on wifi, painful on cellular.
- [ ] H.264 + AAC verified. This matters *more* now, not less: you're running two engines — WebKit on the phone, Blink on the desktop — and H.265 is exactly the codec they disagree about. WebKit plays it happily; desktop Chrome's support is hardware-dependent. A file that works on your phone and not your laptop is the confusing failure. H.264 works everywhere.
- [ ] `playsinline` on the `<video>` tag, or iOS yanks every video fullscreen.
- [ ] Stream URL ends in `.mp4` (gotcha b).
- [ ] `positionS` written on pause and on unmount — resume is what makes phone-then-laptop actually work.
- [ ] Optional: a one-time 720p re-encode halves both storage and mobile data. It's screencasts of a terminal; you won't miss the pixels.

---

## 9. Build order

| Step | Ships | Effort |
|---|---|---|
| **0** | **Spike: Drive refresh token → 30-line proxy → `<video>` seeks in Chrome *and* iOS Safari** | **1–2 h** |
| 1 | Cloud Run + FastAPI skeleton, Firebase ID token verification, deployed | 3–4 h |
| 2 | `POST /scan`, lectures written to Firestore | 4–5 h |
| 3 | SPA: sign-in, project list, course tree, seen checkboxes | 5–6 h |
| 4 | Lecture screen: player via the proxy, note editor, autosave, resume | 6–8 h |
| 5 | Card generation + grading endpoints + SM-2 | 5–6 h |
| 6 | Quiz screen, mobile layout, stats | 4–5 h |

**Roughly 5–6 focused days.** Useful from step 3, earning its keep from step 5.

Step 0 is not optional — it's the only step that can invalidate the other six, and it's the cheapest to run.

---

## 10. Running cost

| | |
|---|---|
| Drive storage | €0 within your free 15 GB (shared with Gmail + Photos — check what's left), else ~€2/mo for 100 GB |
| Cloud Run | Scales to zero; ~€0–3/mo |
| Egress via the proxy | ~€1.70/mo at 20 h of watching |
| Firestore · Auth · Hosting | €0, far inside free tier |
| Claude API | €1–3/mo (Sonnet for cards, Haiku for grading) |
| **Total** | **≈ €3–8/month** |

---

## Sources

- [Drive API — downloads, Range support, header auth](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Safari's video streaming requirements](https://corevo.io/the-weird-case-of-video-streaming-in-safari/)
- [Firebase — Google sign-in and scopes](https://firebase.google.com/docs/auth/web/google-signin)
- [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
