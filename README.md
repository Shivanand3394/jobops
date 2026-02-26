# JobOps

## Project Status
JobOps is running as:
- Cloudflare Worker API in [`worker/src/worker.js`](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js)
- Cloudflare D1 database (binding: `DB`)
- Cloudflare Pages static UI in [`ui/index.html`](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html) + [`ui/app.js`](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js)

Current deployed URLs:
- Worker API: `https://get-job.shivanand-shah94.workers.dev`
- UI: `https://getjobs.shivanand-shah94.workers.dev`

## Architecture
Repo layout:
- [`worker/`](/c:/Users/dell/Documents/GitHub/jobops/worker)
- [`ui/`](/c:/Users/dell/Documents/GitHub/jobops/ui)

Core Worker config:
- [`worker/wrangler.jsonc`](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc)
- D1 binding variable must be `DB`
- Workers AI binding should be `AI` (or provide `AI_BINDING` env var that points to the actual binding name)

DB schema baseline:
- [`worker/migrations/001_init.sql`](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql)

## Auth Model
- Public: `GET /health`
- Public: `POST /ingest/whatsapp/vonage` (requires webhook key; if `WHATSAPP_VONAGE_SIGNATURE_SECRET` is set, also requires valid `Authorization: Bearer <jwt>` from Vonage; optional sender allowlist via `WHATSAPP_VONAGE_ALLOWED_SENDERS`)
- UI endpoints: require `x-ui-key == env.UI_KEY`
- Admin/AI endpoints: require `x-api-key == env.API_KEY`

From current Worker routing:
- UI-auth group includes `/jobs*`, `/ingest`, `/score-pending`, `/targets*`
- Public ingest webhook: `/ingest/whatsapp/vonage` (gated by `WHATSAPP_VONAGE_KEY`; optionally JWT-verified with `WHATSAPP_VONAGE_SIGNATURE_SECRET`; optional sender allowlist via `WHATSAPP_VONAGE_ALLOWED_SENDERS`)
  - Media-aware behavior: document/image payloads are detected. If no URL can be ingested directly, Worker records a queued media extraction event (`WHATSAPP_VONAGE_MEDIA_QUEUED`) and returns `200` without failing the webhook.
- Admin-auth group includes `/normalize-job`, `/resolve-jd`, `/extract-jd`, `/score-jd`
- `/score-pending` is implemented to accept either valid UI key or API key

## Core Flows
1. Ingest job URL:
   - `POST /ingest` with `raw_urls[]`
   - Normalizes URL -> resolves JD content -> inserts/updates `jobs`
2. Resolve/fetch JD:
   - Fetch + cleanup + extraction window
   - Low-quality content detection marks manual-JD-required paths
3. Score + status:
   - AI extraction/scoring updates `score_*`, `final_score`, `status`, `system_status`
   - Status set used by app: `NEW`, `SCORED`, `SHORTLISTED`, `APPLIED`, `ARCHIVED`, `REJECTED`, `LINK_ONLY`
   - Manual-required system marker: `NEEDS_MANUAL_JD`
4. Manual JD flow:
   - `POST /jobs/:job_key/manual-jd`
   - Saves `jd_text_clean`, sets `jd_source=manual`, then extracts + scores

## Endpoint Summary (from code)
- `GET /health` (public)
- `GET /jobs?status=&limit=&offset=` (UI key)
- `GET /dashboard/triage?stale_days=&limit=&gold_limit=` (UI key)
- `GET /jobs/:job_key` (UI key)
- `GET /jobs/:job_key/resume/html?profile_id=&evidence_limit=` (UI key)
- `GET /jobs/:job_key/profile-preference` (UI key)
- `POST /jobs/:job_key/profile-preference` (UI key)
- `POST /jobs/:job_key/status` (UI key)
- `POST /ingest` (UI key)
- `POST /ingest/whatsapp/vonage` (public route; requires `key` query/header matching `WHATSAPP_VONAGE_KEY`; if signature secret is set, requires valid Vonage bearer JWT signature; optional sender allowlist via `WHATSAPP_VONAGE_ALLOWED_SENDERS`)
- `POST /score-pending` (UI key or API key)
- `POST /jobs/:job_key/rescore` (UI key)
- `POST /jobs/:job_key/manual-jd` (UI key)
- `GET /jobs/:job_key/contacts` (UI key)
- `POST /jobs/:job_key/draft-outreach` (UI key)
- `POST /jobs/:job_key/contacts/:contact_id/draft` (UI key)
- `POST /jobs/:job_key/contacts/:contact_id/touchpoint-status` (UI key)
- `GET /admin/scoring-runs/report` (API key; includes source/profile funnel breakdown + touchpoint conversion)
- `POST /extract-jd` (API key)
- `POST /score-jd` (API key)

## Known Issues We Solved
1. CORS invalid header value (`YES`):
   - Fixed by using valid `ALLOW_ORIGIN` values only (`*` or real origin URL).
2. Duplicate SQLite/D1 column migration failures:
   - Strategy: avoid blind `ALTER TABLE ADD COLUMN`; check existing schema and make migrations idempotent.
3. UI header overlap:
   - Fixed in UI layout/CSS so list/detail remains usable on mobile.
4. Unauthorized errors in UI:
   - Root-cause checklist:
     - Missing `UI_KEY` in Worker secrets
     - UI sending wrong/empty `x-ui-key`
     - UI base URL pointed to wrong Worker
     - CORS misconfigured for UI origin
5. Missing Workers AI binding:
   - If `env.AI` not present and `AI_BINDING` does not resolve to a real binding, AI routes fail.
   - Configure binding in Worker settings/wrangler and verify at deploy time.

## Local Run + Deploy
### Worker
From repo root:

```bash
cd worker
```

Apply D1 migrations (local):

```bash
wrangler d1 migrations apply jobops-db --local
```

Apply D1 migrations (remote):

```bash
wrangler d1 migrations apply jobops-db --remote
```

Run worker locally:

```bash
wrangler dev
```

Deploy worker:

```bash
wrangler deploy
```

Configure Vonage webhook key (one-time, secret):

```bash
wrangler secret put WHATSAPP_VONAGE_KEY
```

Configure Vonage signature secret (recommended):

```bash
wrangler secret put WHATSAPP_VONAGE_SIGNATURE_SECRET
```

Optional: restrict webhook to known sender IDs (comma/newline list):

```bash
wrangler secret put WHATSAPP_VONAGE_ALLOWED_SENDERS
```

Optional: configure dedicated media extractor endpoint for WhatsApp attachments.
Reference implementation is in [`extractor/`](/c:/Users/dell/Documents/GitHub/jobops/extractor) and setup notes in [`extractor/README.md`](/c:/Users/dell/Documents/GitHub/jobops/extractor/README.md).

```bash
wrangler secret put WHATSAPP_MEDIA_EXTRACTOR_URL
```

Optional extractor hardening:

```bash
wrangler secret put WHATSAPP_MEDIA_EXTRACTOR_TOKEN
wrangler secret put WHATSAPP_MEDIA_EXTRACTOR_ALLOW_HOSTS
wrangler secret put WHATSAPP_MEDIA_FORWARD_VONAGE_AUTH
wrangler secret put WHATSAPP_MEDIA_EXTRACTOR_TIMEOUT_MS
```

### WhatsApp Media Extractor Contract
When `WHATSAPP_MEDIA_EXTRACTOR_URL` is set, Worker sends:

```json
{
  "provider": "vonage",
  "message_id": "string|null",
  "sender": "string|null",
  "media": {
    "url": "https://...",
    "type": "document|image|video|audio|null",
    "mime_type": "string|null",
    "file_name": "string|null",
    "size_bytes": 12345,
    "caption": "string|null"
  },
  "signature": {
    "verified": true,
    "mode": "verified|disabled|null",
    "issuer": "string|null"
  }
}
```

Accepted extractor responses:
- Canonical JSON: `{ "text": "...", "title": "...", "urls": ["https://..."] }`
- Gemini-style pass-through: `{ "candidates": [{ "content": { "parts": [{ "text": "..." }] } }] }`
- Gemini text can be plain text or JSON-in-text/fenced-json; Worker extracts `job_description/description`, `title/job_title`, and URLs.

### UI
Static UI files live in [`ui/`](/c:/Users/dell/Documents/GitHub/jobops/ui).
Local preview options:

```bash
cd ui
python -m http.server 8788
```

or with Pages dev:

```bash
wrangler pages dev ui
```

In UI settings modal, set:
- API base URL = Worker URL
- UI key = value matching Worker `UI_KEY`

## Smoke Tests
Set vars:

```bash
BASE_URL="https://get-job.shivanand-shah94.workers.dev"
UI_KEY="<your-ui-key>"
API_KEY="<your-api-key>"
JOB_KEY="<job_key>"
WHATSAPP_VONAGE_KEY="<optional-webhook-key>"
WHATSAPP_VONAGE_SIGNATURE_SECRET="<optional-signature-secret>"
WHATSAPP_TEST_SENDER="+14155550100"
```

```powershell
$BASE_URL = "https://get-job.shivanand-shah94.workers.dev"
$UI_KEY = "<your-ui-key>"
$API_KEY = "<your-api-key>"
$JOB_KEY = "<job_key>"
$WHATSAPP_VONAGE_KEY = "<optional-webhook-key>"
$WHATSAPP_VONAGE_SIGNATURE_SECRET = "<optional-signature-secret>"
$WHATSAPP_TEST_SENDER = "+14155550100"
```

### 1) /health
curl:

```bash
curl -sS "$BASE_URL/health"
```

PowerShell:

```powershell
Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET | Select-Object -ExpandProperty Content
```

### 2) GET /jobs
curl:

```bash
curl -sS "$BASE_URL/jobs?limit=20&offset=0" \
  -H "x-ui-key: $UI_KEY"
```

PowerShell:

```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=20&offset=0" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

### 3) POST /ingest
curl:

```bash
curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"raw_urls":["https://www.linkedin.com/jobs/view/1234567890/"]}'
```

PowerShell:

```powershell
$body = @{ raw_urls = @("https://www.linkedin.com/jobs/view/1234567890/") } | ConvertTo-Json -Depth 5
Invoke-WebRequest -Uri "$BASE_URL/ingest" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

### 4) POST /score-pending
curl:

```bash
curl -sS "$BASE_URL/score-pending" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"limit":30}'
```

PowerShell:

```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/score-pending" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

API key variant (also accepted):

```bash
curl -sS "$BASE_URL/score-pending" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"limit":30}'
```

```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/score-pending" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```

### 5) POST /jobs/:job_key/manual-jd
curl:

```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/manual-jd" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"jd_text_clean":"Paste full JD text with at least 200 characters..."}'
```

PowerShell:

```powershell
$body = @{ jd_text_clean = "Paste full JD text with at least 200 characters..." } | ConvertTo-Json -Depth 5
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/manual-jd" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

### 6) POST /ingest when AI binding is missing (graceful)
Expected: HTTP 200, rows inserted/updated, `status=LINK_ONLY`, `system_status=NEEDS_MANUAL_JD`, `fetch_status=ai_unavailable`.

```bash
curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"raw_urls":["https://www.linkedin.com/jobs/view/1234567890/"]}'
```

```powershell
$body = @{ raw_urls = @("https://www.linkedin.com/jobs/view/1234567890/") } | ConvertTo-Json -Depth 5
Invoke-WebRequest -Uri "$BASE_URL/ingest" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

## Next Moves
1. Add automated integration tests for `ingest -> manual-jd -> score` flow.
2. Add an explicit Worker startup self-check endpoint for bindings (`DB`, `AI`/`AI_BINDING`) in non-production.
3. Tighten production CORS to Pages origin only; keep `*` for debug profiles.
4. Add a small admin page/CLI script to inspect recent `events` quickly.
5. Add deployment checklist in CI (migrations applied, secrets present, bindings validated).

## Branch Protection (GitHub)
Use the guide in [`docs/BRANCH_PROTECTION.md`](/c:/Users/dell/Documents/GitHub/jobops/docs/BRANCH_PROTECTION.md).

Minimum settings for `main`:
- Require pull request before merge
- Require at least 1 review
- Require status checks to pass
- Require conversation resolution
- Disallow force push
- Disallow branch deletion

## CI Validation
This repo includes a validation-only workflow: [`.github/workflows/ci.yml`](/c:/Users/dell/Documents/GitHub/jobops/.github/workflows/ci.yml).

What it checks on `push` and `pull_request` to `main`:
- `worker/wrangler.jsonc` is parseable JSONC
- D1 binding `DB` exists in wrangler config
- `worker/src/worker.js` passes syntax check (`node --check`)
- `ui/index.html` exists
- `worker/migrations/001_init.sql` exists

No deployment happens in CI.

## Recommended Git Workflow
1. Create feature branch from `main`.
2. Make changes and run local checks.
3. Open PR to `main`.
4. Wait for CI pass + review approval.
5. Merge PR (avoid direct commit/push to `main`).
