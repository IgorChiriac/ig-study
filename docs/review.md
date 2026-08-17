# Repo and plan review

Review of the repo as it stands (docs + step-0 spike, no `api/` or `web/` yet) against the plan in
[`build-plan.md`](build-plan.md), [`decisions.md`](decisions.md) and [`gotchas.md`](gotchas.md).

**Verdict: the plan is sound and the spike is correct on the three things that matter.** The video
route ends in `.mp4`, Drive's status code is passed straight through, and the body is streamed rather
than buffered. Those are the three failure modes that invalidate everything else, and they're right.

What follows is what would cost time if left as-is. Ordered by how expensive each one is to discover
late.

---

## 1. Contradictions between the docs

### 1a. Two incompatible auth designs are described

`build-plan.md` §1 and the stack table specify **Firebase Auth with Google sign-in**, and the whole
"client writes Firestore directly" architecture depends on it — Firestore security rules key off
`request.auth.uid`, which only exists with a Firebase ID token.

But `CLAUDE.md` rule 7 says *"One user, one password, one JWT"* and `decisions.md` §6 says *"One
password in an env var, one JWT, one dependency that validates it."* There is no password anywhere in
the Firebase design.

This is a leftover from an earlier iteration. The Firebase path is the correct one — it's the only one
that makes direct Firestore writes work. Rule 7's real content is "don't build multi-user", and that
survives; the password sentence should go.

### 1b. "The API exists for exactly three things" is already four

`decisions.md` §4 and `CLAUDE.md` rule 6 both say the API exists only to hold the Drive credential,
hold the Anthropic key, and stream bytes. But build step 2 is *"`POST /scan`, lectures written to
Firestore"* — the API writes Firestore too, via the Admin SDK.

That's the right design (scan needs Drive credentials, so it has to be server-side, and once you're
there you may as well write the result). But it means the API needs a service account with Firestore
write access, which isn't mentioned anywhere. Rule 6 should read: notes, seen flags, resume position
and card state go client → Firestore; scan results are written server-side.

### 1c. Firestore schema is per-user, which rule 7 nominally forbids

`users/{uid}/projects/...` is the right shape and costs nothing extra — it's the natural Firebase
layout and the security rule is one line because of it. Worth noting explicitly that this is *not* a
violation of "don't build multi-user", so nobody later "simplifies" it away.

---

## 2. Factual corrections

### 2a. The `cards` composite index claim is wrong

`gotchas.md` says:

> `where('due','<=',now).orderBy('due')` requires a composite index. It works in the emulator and
> fails in production with a link to create it.

It doesn't. Firestore automatically creates ascending and descending single-field indexes for every
field, and a query with an inequality filter and an `orderBy` on **the same field** is served by that
automatic index. `build-plan.md` §3's "one composite index on `cards`: `due ASC`" is likewise a no-op.

A composite index *is* needed as soon as a second field enters — e.g. `where('suspended','==',false)
.orderBy('due')`, or scoping by `lectureId`.

**The index you will actually need is a different one.** Cards live at
`users/{uid}/projects/{projectId}/cards`. A quiz that spans projects ("12 due today" across all
courses) is a **collection group query** on `cards`, and collection group queries *do* require an
explicitly declared index even for a single field. That's the entry that belongs in
`firestore.indexes.json`, and it's not currently mentioned.

### 2b. Structured output is no longer done with tool schemas

`CLAUDE.md` says *"Anthropic calls use structured output (tool schemas), never prose parsing"* and
`build-plan.md` §5 says both calls "use structured output". The intent is right; the mechanism named is
dated. The current API has a first-class structured-output parameter:

```python
response = client.messages.parse(
    model="claude-sonnet-5",
    max_tokens=4096,
    messages=[{"role": "user", "content": prompt}],
    output_format=Cards,          # a Pydantic model
)
cards = response.parsed_output    # validated Cards instance
```

Raw-schema form, if you'd rather not depend on Pydantic:

```python
output_config={"format": {"type": "json_schema", "schema": {...}}}
```

Note the deprecated spelling: a top-level `output_format=` on `messages.create()` is the old
parameter. On `create()` use `output_config={"format": ...}`; `messages.parse()` is the convenience
wrapper and is the better choice here since both calls have a fixed, small schema.

Using a tool schema for this still works, but it's more code and you have to hunt the `tool_use` block
out of the response yourself. Update the rule to name `output_config.format`.

### 2c. Model IDs, and one parameter that will 400

Verified against the current model catalogue:

| Role | ID | Input $/MTok | Output $/MTok | Context | Max output |
|---|---|---|---|---|---|
| Card generation | `claude-sonnet-5` | $3.00 | $15.00 | 1M | 128K |
| Grading | `claude-haiku-4-5` | $1.00 | $5.00 | 200K | 64K |

Both IDs are complete as written — **never append a date suffix**. (`claude-haiku-4-5-20251001` also
resolves, but prefer the alias.)

Sonnet 5 is on introductory pricing of $2/$10 per MTok through **2026-08-31**, i.e. for about two more
weeks. Don't build a cost model on it.

**The trap:** the two models are different API generations, and the same request shape does not work
for both.

- **Sonnet 5** — adaptive thinking is *on by default*; `temperature` / `top_p` / `top_k` at non-default
  values return **400**; `thinking: {"type": "enabled", "budget_tokens": N}` returns **400**; assistant
  prefills return **400**. Depth is controlled with `output_config={"effort": ...}`, default `high`.
  For card generation from a short note, `"medium"` is likely the right setting — sweep it.
- **Haiku 4.5** — the `effort` parameter **errors** on this model. Setting `output_config={"effort":
  "low"}` on the grading call is a 400, not a hint. Thinking, if you want it at all, uses the old
  `budget_tokens` form. For grading you don't want it: leave `thinking` unset.

Since `max_tokens` caps thinking *plus* response text, and Sonnet 5 thinks by default, size the card
generation call generously (~4–8K) rather than tightly around the expected JSON.

### 2d. Prompt caching won't help the grading call

`build-plan.md` §5 notes prompt caching for the phase-2 discussion endpoint. That's correct and
worthwhile — course context is large and stable.

It will not help grading. The minimum cacheable prefix is **4096 tokens on Haiku 4.5**; a grading
prompt (question + reference answer + student answer) is a few hundred. A `cache_control` marker there
silently does nothing — no error, just `cache_creation_input_tokens: 0`. Worth writing down so nobody
spends an afternoon wondering why the cache never hits.

(For reference, the minimum is **1024** on Sonnet 5, so a card-generation call with a large shared
course preamble *could* cache — but with 36 lectures generated once each, there's nothing to reuse.)

### 2e. Cost estimate holds up

€1–3/month for the Anthropic API checks out. At the daily cap of 60 reviews × ~300 input / ~150 output
tokens on Haiku, grading runs about **$1.90/month**. Card generation is a one-off per lecture and
rounds to nothing. The overall €3–8/month total is realistic.

---

## 3. Gaps to close before writing `api/`

These aren't errors in the plan, they're things the plan doesn't mention that you'll hit in step 1 or 4.

### 3a. CORS — nothing in the plan addresses it

The SPA on `*.web.app` calling Cloud Run is cross-origin. The `<video>` tag doesn't care (no
`crossorigin` attribute → no preflight), but every `fetch` does: `/stream-url`, `/scan`,
`/cards:generate`, `/answer`. Without `CORSMiddleware` on the FastAPI app, the whole JSON API fails in
the browser while working perfectly from `curl`.

The tempting alternative — a Firebase Hosting rewrite to Cloud Run, which makes everything same-origin
and removes CORS entirely — **breaks video**. Hosting rewrites have a 60-second timeout; a lecture
stream needs 3600. So:

- JSON API: Hosting rewrite *or* direct + CORS, either is fine.
- Video: must hit Cloud Run directly, and therefore CORS applies to the JSON API too unless you split
  the two across different origins.

Simplest is direct Cloud Run for both, with CORS allowing exactly the Hosting origin. Worth a line in
the plan since the rewrite looks like an obvious win until you notice the timeout.

### 3b. `verify_stream_jwt` is referenced but never specified

`build-plan.md` §2 calls `Depends(verify_stream_jwt)` and gotcha (a) says the URL carries "a
short-lived JWT". But nothing says who signs it. It can't be the Firebase ID token — those are ~1 hour
and you'd be handing a full-privilege credential to anything that reads a URL out of a log.

So it's a second, API-signed token, which means:

- a signing secret in Secret Manager (a third secret — the plan lists two),
- **the lecture ID must be a claim**, so a leaked token unlocks one lecture rather than the library,
- "valid a few hours" is generous for something that lands in browser history, referrer headers and
  Cloud Run request logs. An hour is plenty; a seek mid-session just re-uses the token you already have.

Specify this in step 1, because step 4 depends on it.

### 3c. Cloud Run must be `--allow-unauthenticated`

The browser can't present a GCP IAM token, so the service has to be publicly reachable and the Firebase
ID token check becomes the *only* gate. Two consequences worth writing down: set a billing budget alert
(a bug in that dependency means someone can spend your Anthropic credits), and the deploy command in
`CLAUDE.md` needs the flag.

### 3d. `positionS` on unmount will not fire reliably on iOS

Mobile checklist says *"`positionS` written on pause and on unmount"*. On iPhone, switching apps or
locking the screen frequently fires neither `unload` nor a React unmount. The events that do fire are
`pagehide` and `visibilitychange`. Resume is the feature that makes phone-then-laptop work, so this is
worth getting right first time.

### 3e. `reviews` can't answer the Stats screen

Schema is `users/{uid}/reviews/{reviewId}` with `cardId, grade, answeredAt`. Screen 6 wants "weakest
modules" — which needs `module`, and the review has no path to one without loading the card, then the
lecture. Denormalise `projectId`, `lectureId` and `module` onto each review at write time. It's
append-only, so there's no update cost.

### 3f. Daily caps have no counter

30 new / 60 reviews per day needs a per-day count. It's derivable from `reviews` with a range query on
`answeredAt`, but that's a query on every card served. A `users/{uid}/daily/{yyyy-mm-dd}` doc with two
counters is cheaper and simpler.

### 3g. `due` needs a timezone decision

`schedule()` uses `today() + timedelta(days=interval)`. If `due` is a UTC timestamp and "due today" is a
UTC-day comparison, the day boundary flips at 01:00 or 02:00 local time depending on DST — mid-evening
study sessions will straddle it. Store `due` as a local-date string (`"2026-08-17"`), or pin a fixed
offset. One user, one timezone, so this is a five-minute decision — but only if it's made once, on
purpose.

### 3h. `orderIdx` needs a stated fallback

`module_index * 1000 + lecture_index` requires parsing a numeric prefix from every folder and file name.
Define what happens when there isn't one (a module named `Appendix`, a bonus video), and note the 999
lectures-per-module ceiling. Both are non-issues at this scale, but only if the scan doesn't crash on
the first unprefixed name.

### 3i. Scan details the plan skips

- `files.list` paginates — 36 lectures fits the default page of 100, but the recursion needs a
  `pageToken` loop or the first big course silently truncates.
- Drive returns `size` as a **string** (int64 over JSON). `int()` it before arithmetic.
- `videoMediaMetadata.durationMillis` is absent until Drive finishes processing a freshly uploaded
  file. The plan's browser fallback covers this — just don't assume the field on first scan.

### 3j. No lint config, no tests, no CI

`CLAUDE.md` specifies ruff and Python 3.12 with type hints on public functions, but there's no
`pyproject.toml` or `ruff.toml` anywhere, so nothing enforces it. Add one in step 1.

The SM-2 scheduler is a pure function with a known-correct reference implementation — it's the one piece
of this app where a wrong answer is invisible for weeks and then manifests as "the scheduling feels
off". A dozen assertions covering the 0→1→6→interval×ease progression, the ease floor at 1.3, and the
lapse path would pay for themselves.

---

## 4. Spike code

The spike does its job. These matter mostly because `api/` will inherit the shape.

**`spike/get_refresh_token.py:104` — `server.handle_request()` handles exactly one request.** If the
browser sends anything before the OAuth callback (a favicon probe, a speculative connection), that
request is consumed, `handle_request()` returns, and the script exits with "No authorization code
received" despite a successful consent. Usually the callback arrives first, so this usually works —
which is the worst kind of bug for a script you run once and then can't easily re-run without revoking
consent. Loop until `_received.get("code")` or the error is set.

**`spike/main.py:143` — no retry on a Drive 401.** If the access token is rejected (revoked, clock
skew), the request fails and the video stops. The real endpoint should catch 401 once, force a token
refresh, and retry — otherwise a token edge case looks like a broken video.

**`spike/main.py:168` — `cache-control: no-store`.** Correct for the spike: you want to *see* every
range request. Carry it into production and every re-seek and every re-watch re-fetches from Drive,
which roughly doubles the egress the €1.70/month estimate assumes. The stream URL already carries a
per-session token, so caching by URL is safe — the real endpoint should send something like
`private, max-age=3600`.

**`spike/main.py:59` — concurrent token refresh.** Two overlapping range requests with an expired token
both refresh. Harmless for one user (worst case: one wasted token call), but an `asyncio.Lock` is two
lines if it bothers you.

**Drive rate limits are unhandled.** Scrubbing generates a burst of range requests, each a separate
Drive API call. Drive can return `403 rateLimitExceeded`; the spike surfaces that as a 403 to the
player, which renders as a dead video. The real endpoint should retry 403/429 with backoff.

**Minor:** Starlette adds `HEAD` automatically to `GET` routes, so `HEAD /video.mp4` will run the
handler and open an upstream stream it doesn't need. Not something WebKit does in practice, but a
one-line short-circuit is cheap.

Both `/meta` and `/video.mp4` are unauthenticated on `0.0.0.0`. Deliberate and fine for a LAN spike —
noted only so it isn't copied forward.

---

## 5. Things the plan gets right that are worth not losing

- **Step 0 first.** Genuinely the only step that can invalidate the other six, and by far the cheapest.
  The instrumented test page with the seek-hammer button and a PASS/SLOW/FAIL verdict is better than
  most people build for a throwaway.
- **Passing `r.status_code` through rather than hardcoding 200.** This is the one-line difference
  between a working iPhone and an afternoon blaming Drive.
- **Keying Firestore docs on Drive `fileId`.** Reorganising folders is exactly the thing that would
  otherwise silently orphan every note, and it's the kind of decision that's free now and a migration
  later.
- **`decisions.md` recording reversals.** "This reverses earlier advice in this project's own history"
  plus the numbers that justified the reversal is the part almost nobody writes down, and it's what
  stops the same argument being re-litigated in three months.
- **The grading prompt refusing to soften scores.** *"Don't soften a 2 into a 3"* is the single line
  that determines whether this app is useful or merely encouraging.

---

## Suggested order

Before step 1:

1. Fix the auth contradiction (1a) and the "exactly three things" framing (1b) in `CLAUDE.md` and
   `decisions.md`.
2. Correct the index claims (2a) and note the collection-group index that's actually needed.
3. Update the structured-output rule to `output_config.format` (2b) and pin the model IDs plus the
   Haiku-`effort` trap (2c).
4. Decide the stream-JWT design (3b) — step 4 blocks on it.

During step 1:

5. `pyproject.toml` with ruff config (3j).
6. CORS middleware, and the Hosting-rewrite-breaks-video note (3a).
7. `--allow-unauthenticated` plus a billing budget alert (3c).

During step 2: pagination, `size`-as-string, `orderIdx` fallback (3h, 3i).

During step 4: `pagehide`/`visibilitychange` for `positionS` (3d); production `Cache-Control` and the
Drive 401/403 retries on the stream endpoint (§4).

During step 5: `due` timezone decision (3g), denormalised review fields (3e), daily counters (3f),
SM-2 unit tests (3j).
