# ig-study

A study app. Take a note per video lecture, let Claude turn it into question cards, and get quizzed on a spaced-repetition schedule — answering in your own words, graded on whether you actually understood it.

Built for one person, watching course videos on a laptop and an iPhone.

---

## How it works

```
Course videos in Google Drive
        │
        ▼
FastAPI on Cloud Run ──── streams video (Range proxy)
        │             └── calls Claude for cards + grading
        ▼
React SPA on Firebase Hosting ──── reads/writes notes directly to Firestore
```

You point it at a Drive folder once. It scans the tree, builds the lecture list, and from then on each video has a note, a seen flag, and a resume position. When you've watched something and written it up, Claude drafts cards from your notes. Later it asks them back, grades what you type, and schedules the next review with SM-2.

## Status

Deployed and working end to end on desktop.

| | | |
|---|---|---|
| 0 | Drive streams and seeks through the proxy | done — verified by `tools/smoke_test.py` |
| 1 | FastAPI on Cloud Run, Firebase ID token auth | done |
| 2 | Drive folder scan → Firestore | done — 37 lectures across 9 modules |
| 3 | SPA: sign-in, course list, course tree | done |
| 4 | Lecture screen: player, notes, resume | done |
| 5 | Card generation, grading, SM-2 | done |
| 6 | Quiz screen, usage and cost page | done |
| — | Stats screen: reviews over time, weakest modules | not started |

**Still unverified: playback on the iPhone.** Every byte-level property WebKit
cares about is asserted by the smoke test — the route ends in `.mp4`, the
opening two-byte probe is answered 206, seeks return the exact range — but no
test can prove WebKit is happy. Desktop Chrome is forgiving about precisely the
things it isn't.

| | |
|---|---|
| App | https://ig-study.web.app |
| API | https://ig-study-api-379754101088.europe-west1.run.app |

## Docs

| | |
|---|---|
| [`docs/build-plan.md`](docs/build-plan.md) | The full plan — architecture, schema, endpoints, prompts, effort |
| [`docs/decisions.md`](docs/decisions.md) | What was chosen, why, and what was rejected along the way |
| [`docs/gotchas.md`](docs/gotchas.md) | The sharp edges, each of which costs an afternoon if you meet it cold |
| [`CLAUDE.md`](CLAUDE.md) | Working rules for Claude Code |

## Layout

```
api/     FastAPI service → Cloud Run
web/     React SPA → Firebase Hosting
tools/   One-off scripts: OAuth consent, ffmpeg prep, smoke test
docs/    Plan, decisions, gotchas, review
```

## Running cost

Around €2–5/month, and the app meters it itself — see **Usage & cost** in the app.

The original €1.70 egress estimate assumed ~14 GB of watching a month. The
DynamoDB course is 394 MB for 3h18m, about 120 MB per hour, so 20 hours is
closer to 2.4 GB and well under a euro. Measured Claude cost is about half a
cent to draft a lecture's cards and $0.001 to grade an answer, so the 60/day cap
comes to roughly $1.85/month. Drive storage, Firestore, Auth, Hosting and Cloud
Run all sit inside free tiers at one user.

A 10 CHF/month budget alert covers the Google side. Anthropic bills separately
and is **not** part of it.
