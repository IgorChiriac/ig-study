# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A personal study app. You take a note per video lecture, Claude turns those notes into question cards, and the app quizzes you on a spaced-repetition schedule, grading free-text answers on understanding rather than string matching.

Single user (Igor). Videos live in Google Drive. Watched on desktop Chrome and on an iPhone.

**Read `docs/build-plan.md` before making architectural changes.** `docs/decisions.md` records what was already considered and rejected — check it before proposing an alternative, because most of the obvious ones have already been argued through.

## Stack

| Layer | Choice |
|---|---|
| UI | React + Vite, deployed to Firebase Hosting |
| Identity | Firebase Auth (Google sign-in) |
| Data | Firestore, written **directly from the client** |
| API | FastAPI on Cloud Run |
| Video | Google Drive through the API's Range proxy, **or** YouTube through the IFrame Player API |
| AI | Anthropic API — `claude-sonnet-5` for card generation, `claude-haiku-4-5` for grading |

## Layout

```
api/          FastAPI service → Cloud Run
web/          React SPA → Firebase Hosting
tools/        One-off scripts: OAuth consent, ffmpeg prep, smoke test
docs/         Plan, decisions, gotchas
```

## Rules that are load-bearing

These aren't style preferences. Breaking any one of them produces a bug that's hard to trace back.

1. **The video route must end in `.mp4`.** WebKit refuses to render video from an extension-less URL. Chrome on iPhone *is* WebKit. Never "clean up" `/lectures/{id}/stream.mp4` into `/lectures/{id}/stream`.
2. **Pass Drive's status code straight through.** WebKit opens with a ~2-byte range request to test the server. It must get a **206**, not a 200, or it won't play the video at all.
3. **Never buffer a video response.** Always `stream=True` plus an async generator. Reading a response body into memory will work on a 5 MB test file and fall over on a real lecture.
4. **`<video src>` cannot send headers**, so the stream URL carries a short-lived JWT in the query string. Don't "fix" this by moving it to an `Authorization` header.
5. **YouTube is embedded, never downloaded.** The IFrame Player API gives resume and seeking, which is why embedding is right here and was wrong for Drive (decision 2). `yt-dlp` through the proxy breaks YouTube's terms and is not an option.
6. **H.264 + AAC only.** Two engines are in play — WebKit on the phone, Blink on the desktop — and H.265 is what they disagree about.
7. **Notes, seen flags, resume position and card state go client → Firestore directly.** Scan results are the one exception — they're written server-side with the Admin SDK, because the scan needs the Drive credential anyway. The API exists for what a browser can't do: hold the Drive refresh token, hold the Anthropic key, stream bytes, walk Drive. Don't route the client's own writes through FastAPI.
8. **Don't build multi-user.** Identity is Firebase Auth (Google sign-in) — that's what makes `request.auth.uid` exist, and the whole direct-to-Firestore design rests on it. Firestore paths are scoped by `uid` because that's the natural Firebase shape, *not* because multi-user is being built; don't "simplify" it away. Adding a second user later is a migration; building for one now is days for nothing.
9. **Secrets never reach the client.** Anthropic key and Drive refresh token live in Secret Manager, server-side only.

## Conventions

- Python: 3.12, `ruff` for lint and format, type hints on public functions.
- TypeScript strict on. No `any` without a comment saying why.
- Firestore document IDs come from Drive's stable `fileId`, never from a path hash — Drive preserves the ID across renames and moves, so reorganising folders never orphans a note.
- Sort lecture lists **naturally**: `10.` comes after `9.`, not after `1.`. Lexicographic sorting is the single most common way these tools end up feeling broken.
- Anthropic calls use structured output via `output_config.format` — or `messages.parse()`, which is the better fit here since both calls have a small fixed schema. Never prose parsing, and never tool schemas (that's the dated mechanism: more code, and you hunt the `tool_use` block out of the response yourself).
- **Model IDs are complete as written — never append a date suffix.** `claude-sonnet-5` and `claude-haiku-4-5`.
- **`effort` errors on Haiku 4.5.** `output_config={"effort": ...}` is a 400 on the grading call, not a hint. It's a Sonnet-5-only knob here; leave `thinking` unset on Haiku.

## Commands

```bash
# api
cd api && uvicorn app.main:app --reload

# web
cd web && npm run dev

# tools
python tools/get_refresh_token.py                  # one-time Drive consent
python tools/prepare_upload.py <course> -o <out>   # faststart + codec check
python tools/smoke_test.py --folder <driveId>      # end-to-end check

# deploy
gcloud run deploy ig-study-api --source api/ --region europe-west1 \
  --allow-unauthenticated --timeout 3600 --concurrency 4
firebase deploy --only hosting
```

## Working notes

- `--host 0.0.0.0` on anything you need to test from the phone.
- Every change to the streaming path must be retested **on the iPhone**, not just desktop. Desktop Chrome is forgiving about exactly the things WebKit isn't.
- Cloud Run: request timeout 3600 s, concurrency 4. A seek can briefly overlap the previous stream.
