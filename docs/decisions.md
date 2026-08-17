# Decisions

What was chosen, why, and what was rejected getting there. Check here before proposing an alternative — most of the obvious ones have already been argued through, and several were adopted and then reversed for reasons that aren't visible from the current code.

---

## 1. Videos live in Google Drive

**Chosen** over Dropbox, OneDrive, S3, Cloudflare R2 and local disk.

Drive is the *worst* of these on pure streaming mechanics — it's the only one that can't produce a self-authenticating URL. But it wins on integration: the project is already on Firebase, which is already a Google Cloud project, and `GoogleAuthProvider.addScope('drive.readonly')` means the same sign-in that identifies you also reaches your files. Every other provider means a second, independent credential system.

**Rejected:**

- **Dropbox** — best streaming API of the lot; `get_temporary_link` returns a rangeable URL you can drop straight into a `<video>` tag. Lost on cost (2 GB free, ~€12/mo for more) and on being a second OAuth.
- **OneDrive** — same mechanism, better value if you already pay for M365. Same second-OAuth problem.
- **Cloudflare R2** — cheapest by a distance ($0.015/GB-month, zero egress). Rejected on uncertainty: there are open community reports of `Accept-Ranges` missing from R2 responses, which breaks seeking. Possibly only affects public-bucket paths rather than presigned URLs, but unverified, and not worth finding out on day four.
- **S3** — rock-solid ranges, no ambiguity, but a second credential system and egress that scales with watching.

## 2. Video is proxied through the API, not served by signed URL

**Chosen** because Drive gives no alternative: `files.get?alt=media` supports Range requests, but authorization is `Authorization: Bearer` header only, and a `<video src>` cannot send headers. There is no signed-URL escape hatch.

This reverses earlier advice in this project's own history. Proxying video bytes through an application server is normally a serious mistake, and it was ruled out twice before the numbers were actually run. For **one user** they come out fine: ~20 hours of watching a month is ~14 GB, GCP egress is ~$0.12/GB, so roughly **$1.70/month**. Cloud Run's request timeout is 60 minutes against a need of about six.

The real costs are 200–400 ms of added latency per seek, and playback that depends on the API being up.

**This calculus does not survive a second user.** If this ever grows one, revisit.

**Rejected:**

- **Drive's iframe player** (`/file/d/{id}/preview`) — free, adaptive, works everywhere, zero code, and Google does the video engineering. But it's opaque: no `currentTime`, no resume, no jump-to-timestamp, no custom controls. That kills the note-taking loop, which is the point. **Keep as a fallback** if the proxy's seek latency disappoints.
- **Public share links** (`uc?export=download`) — virus-scan interstitial on large files, rate-limited, periodically broken by Google, and makes paid course videos public to anyone with the link.

## 3. Firestore, not Postgres

**Chosen**, reversing an earlier call in this project's history.

The argument for Postgres was that once an API sits in front of the data, Firestore's security rules stop earning their keep and you're left using it as a dumb key-value store. Half right — but the client talks to Firestore *directly* for notes and card state, so the rules do still work. And the query-power objection was weak at this scale: *cards due today* is `where('due','<=',now).orderBy('due')` with one composite index, and the schema has no join worth the name.

Postgres would mean an instance to run, migrations to manage, and no offline caching or live updates in the client.

## 4. The client writes Firestore directly; the API is narrow

The API exists for four things a browser can't do: hold the Drive refresh token, hold the Anthropic key, stream video bytes, and walk Drive during a scan. Everything else — notes, seen flags, resume position, card state — goes client → Firestore, authorised by security rules.

Scan is the exception that proves the rule. It needs the Drive credential, so it has to be server-side, and once you're there you may as well write the result — so scan results reach Firestore through the Admin SDK, which bypasses the security rules entirely. That means the API needs a service account with Firestore write access. It's the right design, but it's the one place "the client owns Firestore" isn't true, and it was previously described as three things when it was always four.

Consequence: Cloud Run stays scaled to zero except while you're watching a video or generating cards, and note autosave costs nothing server-side and works offline.

## 5. Two credentials, not one

The pitch for Drive was "one sign-in gives identity *and* file access." True for the access token, but **Firebase's popup sign-in does not return a Google refresh token** — you get ~1 hour and no server-side renewal. Fine for a click; useless for a proxy serving byte ranges through a study session, or for a background folder scan.

So:

| Credential | Held by | Job |
|---|---|---|
| Firebase ID token | Browser | Who you are |
| Google refresh token | Server, Secret Manager | Reach Drive, indefinitely |

Because there's one user, obtaining the refresh token is a one-time chore, not a feature: run `spike/get_refresh_token.py` once and paste the result into config. **There is no OAuth callback endpoint in this app.** Build one when there's a second user.

## 6. Single user, deliberately

Sign-in is Firebase Auth with Google — one account, yours. No signup, no password reset, no email delivery.

**There is no password anywhere in this design.** An earlier iteration had one ("one password in an env var, one JWT"), and that sentence survived into the docs long after the design moved on. It's incompatible with everything else here: Firestore security rules key off `request.auth.uid`, which only a Firebase ID token produces, and the direct-to-Firestore architecture collapses without it. The Firebase path is the correct one.

What survives from that iteration is *don't build multi-user*: no per-user scoping logic, no admin surface, no invitations. Firestore paths are still `users/{uid}/…` — that's the natural Firebase layout and it costs nothing, so it isn't a violation.

There is a second, API-signed JWT in the system, but it's unrelated to identity — it's the short-lived stream token that lets a `<video>` tag authenticate (see [`build-plan.md`](build-plan.md) §2).

Adding a real second user later is a migration — a couple of hours. Building it upfront is days for an audience of one.

## 7. The no-server architecture was considered and is closed

An earlier design had the browser read the course folder off local disk via `showDirectoryPicker()` and play it with no upload, no server, no egress and no monthly cost — about half the build. It was dropped because that API is Chromium-only.

When "Chrome only" was later confirmed as a constraint, this looked reopenable, and it isn't: **File System Access does not exist on iOS in any browser.** Chrome on iPhone is a Chrome interface over WebKit; no browser has shipped a non-WebKit engine on iOS even in the EU. Since the phone is in scope, this path can't reach half the devices.

It shipped on *Android* Chrome in M132 (January 2025), so it would be live again if the phone ever became Android.

## 8. SM-2 for scheduling

Plain, well-understood, about forty lines. Grade ≥3 grows the interval, below that resets to tomorrow. Daily caps of 30 new and 60 reviews so it never becomes a wall you skip; 8 lapses flags a leech.

FSRS is better and not better enough to justify the dependency here.

## 9. `claude-sonnet-5` for cards, `claude-haiku-4-5` for grading

Card generation needs judgment about what's worth testing; grading is high-volume and narrow. Both use structured output so the app parses validated JSON rather than prose. Around €1–3/month — grading dominates at roughly $1.90/month against the 60-review daily cap, and card generation is a one-off per lecture that rounds to nothing.

The two are different API generations and **the same request shape does not work for both** — see [`gotchas.md`](gotchas.md). Sonnet 5's introductory pricing ($2/$10 per MTok vs $3/$15) ends **2026-08-31**, so don't build a cost model on it.

Not chosen: `claude-opus-5` for card generation. It's the stronger model and the general default, but cards are drafted from a short note you already wrote and you approve them before they're saved — the judgment required is modest and the review step catches what's weak. Revisit if the drafts turn out to need heavy editing.

The grading prompt is explicitly instructed not to soften scores. A tutor that rounds a 2 up to a 3 is worse than no tutor.
