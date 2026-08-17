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
| Video | Google Drive, streamed through the API's Range proxy |
| AI | Anthropic API — Sonnet for card generation, Haiku for grading |

## Layout

```
api/          FastAPI service → Cloud Run
web/          React SPA → Firebase Hosting
spike/        Step 0 throwaway proof (see spike/README.md)
docs/         Plan, decisions, gotchas
```

## Rules that are load-bearing

These aren't style preferences. Breaking any one of them produces a bug that's hard to trace back.

1. **The video route must end in `.mp4`.** WebKit refuses to render video from an extension-less URL. Chrome on iPhone *is* WebKit. Never "clean up" `/lectures/{id}/stream.mp4` into `/lectures/{id}/stream`.
2. **Pass Drive's status code straight through.** WebKit opens with a ~2-byte range request to test the server. It must get a **206**, not a 200, or it won't play the video at all.
3. **Never buffer a video response.** Always `stream=True` plus an async generator. Reading a response body into memory will work on a 5 MB test file and fall over on a real lecture.
4. **`<video src>` cannot send headers**, so the stream URL carries a short-lived JWT in the query string. Don't "fix" this by moving it to an `Authorization` header.
5. **H.264 + AAC only.** Two engines are in play — WebKit on the phone, Blink on the desktop — and H.265 is what they disagree about.
6. **Notes, seen flags and card state go client → Firestore directly.** The API exists only for what a browser can't do: hold Drive credentials, hold the Anthropic key, stream bytes. Don't route Firestore writes through FastAPI.
7. **Don't build multi-user.** One user, one password, one JWT. Adding `user_id` later is a migration; building it now is days for nothing.
8. **Secrets never reach the client.** Anthropic key and Drive refresh token live in Secret Manager, server-side only.

## Conventions

- Python: 3.12, `ruff` for lint and format, type hints on public functions.
- TypeScript strict on. No `any` without a comment saying why.
- Firestore document IDs come from Drive's stable `fileId`, never from a path hash — Drive preserves the ID across renames and moves, so reorganising folders never orphans a note.
- Sort lecture lists **naturally**: `10.` comes after `9.`, not after `1.`. Lexicographic sorting is the single most common way these tools end up feeling broken.
- Anthropic calls use structured output (tool schemas), never prose parsing.

## Commands

```bash
# spike
cd spike && uvicorn main:app --host 0.0.0.0 --port 8000

# api
cd api && uvicorn app.main:app --reload

# web
cd web && npm run dev

# deploy
gcloud run deploy ig-study-api --source api/
firebase deploy --only hosting
```

## Working notes

- `--host 0.0.0.0` on anything you need to test from the phone.
- Every change to the streaming path must be retested **on the iPhone**, not just desktop. Desktop Chrome is forgiving about exactly the things WebKit isn't.
- Cloud Run: request timeout 3600 s, concurrency 4. A seek can briefly overlap the previous stream.
