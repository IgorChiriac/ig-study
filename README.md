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

| Step | | |
|---|---|---|
| 0 | Spike — prove Drive seeks through the proxy | see `spike/` |
| 1 | FastAPI + Cloud Run + auth | not started |
| 2 | Drive folder scan → Firestore | not started |
| 3 | SPA: course tree, seen checkboxes | not started |
| 4 | Lecture screen: player, notes, resume | not started |
| 5 | Card generation, grading, SM-2 | not started |
| 6 | Quiz screen, mobile layout, stats | not started |

**Start with step 0.** It's the only step that can invalidate the other six, and it takes an hour or two. `spike/README.md` has the full runbook.

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
spike/   Step 0 proof — throwaway
docs/    Plan and decisions
```

## Running cost

Around €3–8/month: Drive storage (free within your 15 GB), Cloud Run scaled to zero, ~€1.70 of egress at 20 hours of watching, Firestore and Auth and Hosting all inside their free tiers, and €1–3 of Anthropic API.
