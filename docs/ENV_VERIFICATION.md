# ENV Verification (Worker + Gmail Bridge)

This checklist verifies Cloudflare Worker environment and bindings without exposing secret values.

## A) Wrangler config verification

Source: `worker/wrangler.jsonc`

### Must exist
- D1 binding named `DB`
- Gmail poll cron trigger
- Vars:
  - `GMAIL_CLIENT_ID`
  - `GMAIL_QUERY`
  - `GMAIL_MAX_PER_RUN`
  - `RSS_FEEDS`
  - `RSS_MAX_PER_RUN`
  - `RSS_ALLOW_KEYWORDS`
  - `RSS_BLOCK_KEYWORDS`
  - `RR_BASE_URL`
  - `RR_HEALTH_PATH`
  - `RR_IMPORT_PATH`
  - `RR_TIMEOUT_MS`
  - `RECOVERY_ENABLED`
  - `RECOVER_BACKFILL_LIMIT`
  - `RECOVER_RESCORE_LIMIT`
  - `ALLOW_ORIGIN`

### Current repo state
- `d1_databases[].binding = "DB"`: present
- `triggers.crons`: present (`*/15 * * * *`)
- `vars.GMAIL_CLIENT_ID`: present (`REPLACE_IN_DASHBOARD` placeholder)
- `vars.GMAIL_QUERY`: present
- `vars.GMAIL_MAX_PER_RUN`: present
- `vars.RSS_FEEDS`: should be present (empty allowed, or feed URLs)
- `vars.RSS_MAX_PER_RUN`: should be present
- `vars.RSS_ALLOW_KEYWORDS`: optional (comma/newline-separated keywords)
- `vars.RSS_BLOCK_KEYWORDS`: optional (comma/newline-separated keywords)
- `vars.RR_BASE_URL`: optional (required for Worker -> Reactive Resume bridge health checks)
- `vars.RR_HEALTH_PATH`: optional (default `/api/health`)
- `vars.RR_IMPORT_PATH`: optional (default `/api/openapi/resumes/import`)
- `vars.RR_TIMEOUT_MS`: optional (default `6000`)
- `vars.RECOVERY_ENABLED`: optional (`1` default, set `0` to disable cron recovery)
- `vars.RECOVER_BACKFILL_LIMIT`: optional (default `30`)
- `vars.RECOVER_RESCORE_LIMIT`: optional (default `30`)
- `vars.SCORING_MIN_JD_CHARS`: optional (default `120`, range `60..2000`)
- `vars.SCORING_MIN_TARGET_SIGNAL`: optional (default `8`, range `0..100`)
- `vars.ALLOW_ORIGIN`: present

### If missing, what to do
1. Add missing var in Cloudflare dashboard (Worker -> Settings -> Variables), or add to `wrangler.jsonc` vars.
2. Redeploy worker.
3. Re-run runtime checks below.

## B) Runtime requirements map

Source files:
- `worker/src/worker.js`
- `worker/src/gmail.js`

| Name | Type | Where used | Symptom if missing |
|---|---|---|---|
| `API_KEY` | Secret | API auth in `requireAuth_`, `/gmail/poll` API path | `401 Unauthorized` for API-key routes |
| `UI_KEY` | Secret | UI auth in `requireAuth_`, `/jobs*`, `/ingest`, `/targets*`, `/gmail/auth` | `401 Unauthorized` for UI routes |
| `GMAIL_CLIENT_SECRET` | Secret | Gmail token exchange/refresh | `Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET` |
| `TOKEN_ENC_KEY` | Secret | AES-GCM encrypt/decrypt refresh token | `Missing TOKEN_ENC_KEY` or invalid key-length error |
| `GMAIL_CLIENT_ID` | Var | Gmail OAuth URL + token exchange | `Missing GMAIL_CLIENT_ID` |
| `GMAIL_QUERY` | Var | Gmail `messages.list` query | Poll scans wrong/no messages; start debug with `in:anywhere newer_than:7d` |
| `GMAIL_MAX_PER_RUN` | Var | Gmail poll message cap | Unexpected poll volume |
| `RSS_FEEDS` | Var | RSS poll feed list (`/rss/poll`, scheduled poll) | RSS poll reports `skipped: no_feeds_configured` |
| `RSS_MAX_PER_RUN` | Var | RSS poll item cap | Unexpected RSS ingest volume |
| `RSS_ALLOW_KEYWORDS` | Var | RSS item allow filter (title/summary) | Too many irrelevant RSS items pass through |
| `RSS_BLOCK_KEYWORDS` | Var | RSS item block filter (title/summary) | Promo/non-job RSS items still processed |
| `RR_KEY` | Secret | Worker-side Reactive Resume probe (`/resume/rr/health`) | Probe returns `missing_config` / `unauthorized` |
| `RR_BASE_URL` | Var | Reactive Resume base URL used by Worker probe | Probe returns `missing_config` / `unreachable` |
| `RR_HEALTH_PATH` | Var | Optional RR health path override | Probe returns `endpoint_not_found` |
| `RR_IMPORT_PATH` | Var | Path used by push endpoint `/jobs/:job_key/push-reactive-resume` | Push returns endpoint/path error |
| `RR_TIMEOUT_MS` | Var | Optional timeout for RR probe | Probe returns `unreachable` on slow/blocked network |
| `RECOVERY_ENABLED` | Var | Enables/disables cron recovery sequence (backfill + rescore-existing-jd) | No periodic recovery events/counters if disabled |
| `RECOVER_BACKFILL_LIMIT` | Var | Cron limit for `/jobs/backfill-missing` equivalent | Too few/too many jobs retried per run |
| `RECOVER_RESCORE_LIMIT` | Var | Cron limit for `/jobs/recover/rescore-existing-jd` equivalent | Too few/too many rescored jobs per run |
| `WHATSAPP_VONAGE_KEY` | Secret | Public webhook gate for `POST /ingest/whatsapp/vonage` | `401 Unauthorized` on webhook calls |
| `WHATSAPP_VONAGE_SIGNATURE_SECRET` | Secret | Optional Vonage bearer JWT verification for webhook | `401` with missing/invalid bearer token |
| `WHATSAPP_VONAGE_ALLOWED_SENDERS` | Secret/Var | Optional sender allowlist (`from` IDs, comma/newline list) | `403 Forbidden sender` for non-allowlisted senders |
| `ALLOW_ORIGIN` | Var | CORS response header | Browser CORS failures |
| `DB` | Binding (D1) | Jobs/targets/events and Gmail state persistence | `Missing D1 binding env.DB (bind your D1 as DB)` |
| `AI` or `AI_BINDING` | Binding/Var indirection | Extraction/scoring routes (`getAi_`) | `Missing Workers AI binding (env.AI or AI_BINDING)` |

## C) Terminal verification commands (no secret values)

PowerShell:
```powershell
cd worker
wrangler whoami
wrangler secret list
wrangler d1 list
Get-Content .\wrangler.jsonc
wrangler deploy --dry-run
```

Bash:
```bash
cd worker
wrangler whoami
wrangler secret list
wrangler d1 list
cat ./wrangler.jsonc
wrangler deploy --dry-run
```

Notes:
- `wrangler vars list` is not available in all Wrangler versions.
- Equivalent safe check is local `wrangler.jsonc` + dashboard Variables panel.

Optional diagnostics:
```powershell
wrangler tail
wrangler types
```

## D) Runtime endpoint verification

Set placeholders:

```powershell
$BASE_URL = "https://get-job.shivanand-shah94.workers.dev"
$UI_KEY = "<ui-key>"
$API_KEY = "<api-key>"
$WHATSAPP_VONAGE_KEY = "<optional-webhook-key>"
$WHATSAPP_VONAGE_SIGNATURE_SECRET = "<optional-signature-secret>"
```

```bash
BASE_URL="https://get-job.shivanand-shah94.workers.dev"
UI_KEY="<ui-key>"
API_KEY="<api-key>"
WHATSAPP_VONAGE_KEY="<optional-webhook-key>"
WHATSAPP_VONAGE_SIGNATURE_SECRET="<optional-signature-secret>"
```

### 1) Health
```powershell
Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET | Select-Object -ExpandProperty Content
```
```bash
curl -i "$BASE_URL/health"
```

### 2) Jobs list (UI auth)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=1" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
```bash
curl -i "$BASE_URL/jobs?limit=1" -H "x-ui-key: $UI_KEY"
```

### 3) Gmail OAuth entry (UI auth)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/gmail/auth" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } -MaximumRedirection 0 -ErrorAction SilentlyContinue | Format-List StatusCode,Headers
```
```bash
curl -i "$BASE_URL/gmail/auth" -H "x-ui-key: $UI_KEY"
```
Expected: `302` with Google OAuth `Location` header.

### 4) Gmail poll (API auth)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/gmail/poll" -Method POST -Headers @{ "x-api-key" = $API_KEY } | Select-Object -ExpandProperty Content
```
```bash
curl -i -X POST "$BASE_URL/gmail/poll" -H "x-api-key: $API_KEY"
```
Expected response keys under `data`: `scanned`, `processed`, `skipped_existing`, `inserted_or_updated`, `ignored`, `link_only`.

### 5) RSS poll (API auth)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/rss/poll" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body (@{ max_per_run = 20 } | ConvertTo-Json) | Select-Object -ExpandProperty Content
```
```bash
curl -i -X POST "$BASE_URL/rss/poll" -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d '{"max_per_run":20}'
```
Expected:
- `ok:true`
- `data.feeds_total`
- `data.items_listed`
- `data.items_filtered_allow`
- `data.items_filtered_block`
- `data.inserted_or_updated`
- `data.source_summary`

### 6) RSS diagnostics (API auth)
```powershell
$body = @{ max_per_run = 10; sample_limit = 5 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/rss/diagnostics" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```
```bash
curl -i -X POST "$BASE_URL/rss/diagnostics" -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d '{"max_per_run":10,"sample_limit":5}'
```
Expected:
- `ok:true`
- `data.reason_buckets` present with deterministic keys
- `data.unsupported_domain_by_host` present
- `data.rejected_url_samples` present (URL-only, capped)
- `data.feed_summaries[]` present with URL-only samples
- `data.inserted_or_updated` and `data.source_summary[]` present

### 7) Reactive Resume bridge health (UI auth)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/resume/rr/health" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
```bash
curl -i "$BASE_URL/resume/rr/health" -H "x-ui-key: $UI_KEY"
```
Expected:
- `ok:true`
- `data.status` is one of:
  - `ready`
  - `unauthorized`
  - `endpoint_not_found`
  - `unreachable`
  - `missing_config`

### 8) WhatsApp Vonage webhook (optional)
```powershell
$waBody = @{ from = "+14155550100"; text = "Smoke webhook https://example.com/jobs/123"; message_uuid = "smoke-wa-1" } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/ingest/whatsapp/vonage?key=$WHATSAPP_VONAGE_KEY" -Method POST -ContentType "application/json" -Body $waBody
```
```bash
curl -i -X POST "$BASE_URL/ingest/whatsapp/vonage?key=$WHATSAPP_VONAGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"+14155550100","text":"Smoke webhook https://example.com/jobs/123","message_uuid":"smoke-wa-1"}'
```
Expected:
- `200` with `ok:true` when key/signature checks pass
- `401` if signature secret is enabled but bearer JWT is missing/invalid
- `403` if `WHATSAPP_VONAGE_ALLOWED_SENDERS` is enabled and sender is not allowlisted

## E) Troubleshooting table

| Failure symptom | Likely cause | How to confirm | Fix |
|---|---|---|---|
| `Unauthorized` | Wrong/missing key type or value | Retry endpoint with correct header (`x-ui-key` vs `x-api-key`) | Set correct secret in Worker settings and send correct header |
| `Forbidden sender` on `/ingest/whatsapp/vonage` | Sender is not in `WHATSAPP_VONAGE_ALLOWED_SENDERS` | Check webhook body `from` and allowlist values | Add sender to allowlist (normalized format) or remove allowlist var |
| `Missing Workers AI binding (env.AI or AI_BINDING)` | AI binding not configured | Call scoring endpoint (`/score-pending` or `/jobs/:job_key/rescore`) | Add AI binding `AI` or set `AI_BINDING` to valid binding name |
| Gmail OAuth redirect/callback failures | `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` mismatch or redirect URI mismatch | Inspect `/gmail/auth` redirect and Google OAuth client config | Correct vars/secrets and exact callback URI `/gmail/callback` |
| Cron not firing or `/gmail/poll` not ingesting | Trigger missing or poll runtime error | Check `wrangler.jsonc` cron and use `wrangler tail` around schedule | Ensure cron exists, deploy latest Worker, fix poll errors |
| `/rss/poll` returns `skipped: no_feeds_configured` | `RSS_FEEDS` empty/missing | Call `/rss/poll` and inspect payload | Set `RSS_FEEDS` var to feed URLs (comma/newline separated), redeploy |
| `/rss/poll` has high `items_filtered_allow` | `RSS_ALLOW_KEYWORDS` too strict | Inspect response counters | Relax/remove `RSS_ALLOW_KEYWORDS` |
| `/rss/poll` still ingests promo/news items | `RSS_BLOCK_KEYWORDS` not set or too weak | Inspect `items_filtered_block` and item sources | Add stronger block keywords (e.g., `premium,newsletter,upgrade,sponsored`) |
| `/rss/diagnostics` shows high `unresolved_wrapper` | Wrapped links (e.g., Google News RSS) not resolving to canonical job URLs | Call `/rss/diagnostics` and inspect `data.reason_buckets` + `feed_summaries.sample_candidates` | Use cleaner feeds where possible, keep query-param redirects, and verify resolver behavior with small `max_per_run` test |
| `/rss/diagnostics` shows high `normalize_ignored` or `unsupported_domain` | URLs are non-job pages or unsupported domains after normalization | Inspect `reason_buckets` and sample candidates | Tighten `RSS_ALLOW_KEYWORDS`, extend source feeds, or add domain support in normalization logic |
| `/resume/rr/health` returns `missing_config` | `RR_BASE_URL` or `RR_KEY` missing | Call `/resume/rr/health` and inspect `data.configured` | Set `RR_BASE_URL` var + `RR_KEY` secret and redeploy |
| `/resume/rr/health` returns `unauthorized` | RR key rejected by RR backend | Check `data.http_status` (`401/403`) | Rotate/reissue RR key and update Worker secret `RR_KEY` |
| `/resume/rr/health` returns `endpoint_not_found` | Health path mismatch for RR deployment | Check `data.attempted_paths` | Set `RR_HEALTH_PATH` to a valid endpoint path and redeploy |
| `/jobs/:job_key/push-reactive-resume` returns import path error | RR import endpoint path mismatch | Inspect response `data.import_path` and HTTP status | Set `RR_IMPORT_PATH` var to the correct RR import route and redeploy |
| `/gmail/poll` returns `ok:true` but `scanned=0` | Query too narrow (label mismatch / mailbox visibility) | Inspect `data.query_used` in poll response | Temporarily set `GMAIL_QUERY` to `in:anywhere newer_than:7d`, or call `/gmail/poll` with body override `{ "query":"in:anywhere newer_than:7d","max_per_run":50 }` |
| D1 errors / missing migrations | DB binding wrong or migrations not applied | Endpoint errors and `wrangler d1 list` | Bind D1 as `DB` and apply migrations through latest (`010_contacts_v2.sql`) |
| CORS/origin failures | `ALLOW_ORIGIN` not set for UI origin | Check response headers and browser console | Set `ALLOW_ORIGIN` to Pages URL in prod (`https://getjobs.shivanand-shah94.workers.dev`) |
| Pages not deploying | Pages config mismatch (branch/root/output/build) | Inspect Pages deploy logs/settings | Set branch `main`, root repo root, output `ui`, no build command |
| Wrangler permission error on `C:\Users\dell\Application Data` | Local Windows profile/path permission issue | `wrangler whoami` or deploy fails before network call | Open fresh shell as same user, re-auth (`wrangler logout/login`), retry from `worker/` |

## F) DB schema reality note

- `worker/migrations/001_init.sql` baseline does not include checklist columns (`applied_note`, `follow_up_at`, `referral_status`).
- Runtime Worker checks schema via `getJobsSchema_` and returns clear `400` for checklist routes when absent.
- Evidence schema (`job_evidence`) is now active in remote D1 via `008_job_evidence.sql`.
- Scoring telemetry schema is additive via `009_scoring_runs.sql`.
- Contacts CRM schema is additive via `010_contacts_v2.sql`.
- If your live DB includes those columns from later migration/manual alter, checklist routes will work.

Optional query:
```sql
PRAGMA table_info(jobs);
```

## G) Verification checklist (5-10 min)
1. Run `wrangler whoami`, `wrangler secret list`, `wrangler d1 list`.
2. Confirm secret names exist: `API_KEY`, `UI_KEY`, `GMAIL_CLIENT_SECRET`, `TOKEN_ENC_KEY`.
3. Confirm vars exist: `ALLOW_ORIGIN`, `GMAIL_CLIENT_ID`, `GMAIL_QUERY`, `GMAIL_MAX_PER_RUN` (and `RR_BASE_URL` if using RR bridge).
4. Optional scoring gate vars: `SCORING_MIN_JD_CHARS`, `SCORING_MIN_TARGET_SIGNAL` (used by `/admin/scoring-runs/report` as `heuristic_config` context).
5. Confirm secrets exist: `API_KEY`, `UI_KEY`, `GMAIL_CLIENT_SECRET`, `TOKEN_ENC_KEY` (and `RR_KEY` if using RR bridge).
6. Run `/health`, `/jobs?limit=1`, `/gmail/auth`, `/gmail/poll` checks.
7. If RR bridge is enabled, run `/resume/rr/health`.
8. If failures occur, use troubleshooting table and retest.
