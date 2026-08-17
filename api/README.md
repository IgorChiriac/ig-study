# api — Drive proxy, scan, and streaming

FastAPI service on Cloud Run. It exists for the four things a browser can't do:
hold the Drive refresh token, hold the Anthropic key, stream video bytes, and
walk Drive during a scan. Everything else — notes, seen flags, resume position,
card state — goes client → Firestore directly.

## Endpoints

| | |
|---|---|
| `GET /health` | Liveness, plus which config is missing. Never returns a secret value. Not `/healthz` — Google's frontend intercepts that path on Cloud Run and answers its own 404 |
| `GET /drive/folders?parent=root` | Browse Drive folders, to find the course folder id |
| `GET /drive/folders/{id}/preview` | Exactly what a scan would write — **without writing anything** |
| `POST /projects/{id}/scan` | Walk the folder, write lectures to Firestore |
| `GET /lectures/{id}/stream-url` | Mint a 1-hour URL scoped to one lecture |
| `GET /lectures/{id}/stream.mp4?t=…` | The bytes. Range-proxied from Drive |
| `POST /lectures/{id}/cards:generate` | Sonnet 5 drafts cards from the note. Saves nothing |
| `POST /lectures/{id}/cards` | Save the approved drafts |
| `GET /cards/due` | Today's queue, capped at 30 new / 60 reviews |
| `POST /cards/{id}/answer` | Haiku grades the answer, SM-2 schedules the card |
| `GET /usage` | Token and byte totals for the month, priced |

All except `stream.mp4` require `Authorization: Bearer <Firebase ID token>`.
`stream.mp4` takes the stream token in the query string instead, because a
`<video src>` cannot send headers.

## One-time setup

### 1. OAuth client and refresh token

The Drive API is already enabled on `ig-study`. You still need a client and a
token — both are console work, and the token is a browser consent:

1. [Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent?project=ig-study)
   → External → add yourself as a **Test user**. No verification needed for
   personal use.
2. **Publish the app** on the Audience page. In *Testing* status Google expires
   `drive.readonly` refresh tokens after **7 days**, so playback would break
   weekly. Published-but-unverified is fine for one user: you get a "Google
   hasn't verified this app" screen, click *Advanced → Go to ig-study*.
3. [Credentials](https://console.cloud.google.com/apis/credentials?project=ig-study)
   → Create credentials → OAuth client ID.
   **Desktop app** needs nothing registered. **Web application** works too, but
   you must register the exact callback, port included:
   `http://localhost:8765/callback` (add the `127.0.0.1` spelling as well —
   Google treats them as different URIs).
4. Run the one-time consent, which prints a refresh token:

```bash
cp api/.env.example api/.env    # paste the client id + secret
api/.venv/bin/python tools/get_refresh_token.py
```

> No `refresh_token` in the response? You've consented for this client before.
> Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
> and re-run.

The scope is `drive.readonly`. That is deliberate — this service never writes
to Drive, so it never asks for permission to.

### 2. Stream signing key

The third secret. Not the Drive credential, not the Firebase key:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## Local development

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env          # fill in the four values
uvicorn app.main:app --reload --host 0.0.0.0
```

`--host 0.0.0.0` for anything you intend to reach from the phone. Then
`curl localhost:8000/health` — it lists whatever config is still missing.

Firestore access locally uses Application Default Credentials:
`gcloud auth application-default login`.

```bash
ruff check . && ruff format . && pytest -q
```

## Deploy

```bash
gcloud config set project ig-study

for name in DRIVE_REFRESH_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET STREAM_JWT_SECRET ANTHROPIC_API_KEY; do
  printf '%s' "$(grep "^$name=" api/.env | cut -d= -f2-)" \
    | gcloud secrets create "$name" --data-file=- 2>/dev/null \
    || printf '%s' "$(grep "^$name=" api/.env | cut -d= -f2-)" \
       | gcloud secrets versions add "$name" --data-file=-
done

gcloud run deploy ig-study-api \
  --source api/ \
  --region europe-west1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --concurrency 4 \
  --set-secrets "DRIVE_REFRESH_TOKEN=DRIVE_REFRESH_TOKEN:latest,\
GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,\
GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,\
STREAM_JWT_SECRET=STREAM_JWT_SECRET:latest,\
ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest"
```

Rotating just the key later doesn't need a rebuild — add a secret version, then
`gcloud run services update ig-study-api --update-secrets …` to force a new
revision. Cloud Run resolves secrets at **instance start**, so a new version
alone never reaches the container already serving.

Three flags are load-bearing:

- **`--allow-unauthenticated`** — the browser cannot present a GCP IAM token, so
  the Firebase ID token check *is* the only gate. This is why the budget alert
  exists.
- **`--timeout 3600`** — the default cuts long streams. A lecture needs about six
  minutes; an hour is headroom.
- **`--concurrency 4`** — one viewer, but a seek briefly overlaps the stream it
  replaces.

`europe-west1` matches Firestore. Don't split them.

The runtime service account needs several roles. Scan writes Firestore through
the Admin SDK, and `--source` builds run as this same account — **without the
Cloud Build roles the deploy fails before it builds anything**, with a
permission error on the source bucket that `roles/editor` alone does not fix:

```bash
SA="$(gcloud projects describe ig-study --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
for role in roles/datastore.user roles/secretmanager.secretAccessor \
            roles/cloudbuild.builds.builder roles/logging.logWriter \
            roles/artifactregistry.writer roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding ig-study \
    --member="serviceAccount:$SA" --role="$role" --condition=None
done
```

Then set `VITE_API_BASE_URL` in `web/.env.local` to the deployed URL, and add
that URL's origin to `ALLOWED_ORIGINS` if you serve the SPA from anywhere other
than `ig-study.web.app`.

> **Don't route video through a Firebase Hosting rewrite.** It makes the JSON
> API same-origin and removes CORS, which looks like an obvious win — but
> Hosting rewrites cap at 60 seconds and a stream needs 3600. Video must hit
> Cloud Run directly.

## Getting a course in

```bash
python tools/prepare_upload.py "~/Downloads/Some Course" -o ~/Desktop/ready
```

That remuxes every file with `+faststart` (moov atom at the front, or the
player fetches the tail before it can start) and flags anything that isn't
H.264 + AAC. Drag the output into Drive, then:

```bash
TOKEN="<Firebase ID token>"
curl -H "Authorization: Bearer $TOKEN" "$API/drive/folders"
curl -H "Authorization: Bearer $TOKEN" "$API/drive/folders/<id>/preview"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"driveFolderId":"<id>","name":"AWS DynamoDB"}' \
     "$API/projects/dynamodb/scan"
```

Run the preview first. It is where you find out that a folder has no numeric
prefix, or that Drive hasn't finished processing an upload and is still
withholding durations (`missingDuration` in the response). Re-scanning is safe:
notes, seen flags and resume positions are preserved, and a lecture that
vanished from Drive is reported as an orphan rather than deleted.

## Things that will bite

- **The video route must end in `.mp4`.** WebKit requires the extension in the
  URL path on top of a correct Content-Type, and Chrome on iPhone is WebKit.
  Renaming it breaks the phone and nothing else.
- **Drive's status code passes straight through.** Playback opens with a ~2 byte
  range request to check the server understands ranges; it must be answered
  206. Hardcode 200 and iOS renders nothing, with no error.
- **Nothing is buffered.** `stream=True` plus an async generator, always.
- **Retest the streaming path on the iPhone**, not just desktop. Desktop Chrome
  is forgiving about exactly the things WebKit isn't.
