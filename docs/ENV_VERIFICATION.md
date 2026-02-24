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
  - `ALLOW_ORIGIN`

### Current repo state
- `d1_databases[].binding = "DB"`: present
- `triggers.crons`: present (`*/15 * * * *`)
- `vars.GMAIL_CLIENT_ID`: present (`REPLACE_IN_DASHBOARD` placeholder)
- `vars.GMAIL_QUERY`: present
- `vars.GMAIL_MAX_PER_RUN`: present
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
```

```bash
BASE_URL="https://get-job.shivanand-shah94.workers.dev"
UI_KEY="<ui-key>"
API_KEY="<api-key>"
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

## E) Troubleshooting table

| Failure symptom | Likely cause | How to confirm | Fix |
|---|---|---|---|
| `Unauthorized` | Wrong/missing key type or value | Retry endpoint with correct header (`x-ui-key` vs `x-api-key`) | Set correct secret in Worker settings and send correct header |
| `Missing Workers AI binding (env.AI or AI_BINDING)` | AI binding not configured | Call scoring endpoint (`/score-pending` or `/jobs/:job_key/rescore`) | Add AI binding `AI` or set `AI_BINDING` to valid binding name |
| Gmail OAuth redirect/callback failures | `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` mismatch or redirect URI mismatch | Inspect `/gmail/auth` redirect and Google OAuth client config | Correct vars/secrets and exact callback URI `/gmail/callback` |
| Cron not firing or `/gmail/poll` not ingesting | Trigger missing or poll runtime error | Check `wrangler.jsonc` cron and use `wrangler tail` around schedule | Ensure cron exists, deploy latest Worker, fix poll errors |
| `/gmail/poll` returns `ok:true` but `scanned=0` | Query too narrow (label mismatch / mailbox visibility) | Inspect `data.query_used` in poll response | Temporarily set `GMAIL_QUERY` to `in:anywhere newer_than:7d`, or call `/gmail/poll` with body override `{ "query":"in:anywhere newer_than:7d","max_per_run":50 }` |
| D1 errors / missing migrations | DB binding wrong or migrations not applied | Endpoint errors and `wrangler d1 list` | Bind D1 as `DB` and apply `001_init.sql` + `002_gmail.sql` |
| CORS/origin failures | `ALLOW_ORIGIN` not set for UI origin | Check response headers and browser console | Set `ALLOW_ORIGIN` to Pages URL in prod (`https://getjobs.shivanand-shah94.workers.dev`) |
| Pages not deploying | Pages config mismatch (branch/root/output/build) | Inspect Pages deploy logs/settings | Set branch `main`, root repo root, output `ui`, no build command |
| Wrangler permission error on `C:\Users\dell\Application Data` | Local Windows profile/path permission issue | `wrangler whoami` or deploy fails before network call | Open fresh shell as same user, re-auth (`wrangler logout/login`), retry from `worker/` |

## F) DB schema reality note

- `worker/migrations/001_init.sql` baseline does not include checklist columns (`applied_note`, `follow_up_at`, `referral_status`).
- Runtime Worker checks schema via `getJobsSchema_` and returns clear `400` for checklist routes when absent.
- If your live DB includes those columns from later migration/manual alter, checklist routes will work.

Optional query:
```sql
PRAGMA table_info(jobs);
```

## G) Verification checklist (5-10 min)
1. Run `wrangler whoami`, `wrangler secret list`, `wrangler d1 list`.
2. Confirm secret names exist: `API_KEY`, `UI_KEY`, `GMAIL_CLIENT_SECRET`, `TOKEN_ENC_KEY`.
3. Confirm vars exist: `ALLOW_ORIGIN`, `GMAIL_CLIENT_ID`, `GMAIL_QUERY`, `GMAIL_MAX_PER_RUN`.
4. Run `/health`, `/jobs?limit=1`, `/gmail/auth`, `/gmail/poll` checks.
5. If failures occur, use troubleshooting table and retest.
