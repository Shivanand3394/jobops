# ENV Verification (Worker + Gmail Bridge)

This checklist verifies Cloudflare Worker environment and bindings without exposing secret values.

## A) Wrangler config verification

Source: [`worker/wrangler.jsonc`](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc)

### Must exist
- D1 binding named `DB`
- Gmail poll cron trigger
- Gmail vars:
  - `GMAIL_CLIENT_ID`
  - `GMAIL_QUERY`
  - `GMAIL_MAX_PER_RUN`

### Current repo state
- `d1_databases[].binding = "DB"`: present
- `triggers.crons`: present (`*/15 * * * *`)
- `vars.GMAIL_QUERY`: present
- `vars.GMAIL_MAX_PER_RUN`: present
- `vars.GMAIL_CLIENT_ID`: **missing in wrangler.jsonc**

### If missing, what to do
1. Add missing var in Cloudflare dashboard (Worker -> Settings -> Variables), or add to `wrangler.jsonc` vars.
2. Redeploy worker.
3. Re-run runtime checks below.

## B) Runtime requirements map

Source files:
- [`worker/src/worker.js`](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js)
- [`worker/src/gmail.js`](/c:/Users/dell/Documents/GitHub/jobops/worker/src/gmail.js)

| Name | Type | Where used | Symptom if missing |
|---|---|---|---|
| `API_KEY` | Secret | `worker.js`: API auth (`requireAuth_`), `/gmail/poll` manual auth path | `401 Unauthorized` for API-key routes |
| `UI_KEY` | Secret | `worker.js`: UI auth (`requireAuth_`), `/gmail/auth`, `/jobs*`, `/ingest`, `/targets*` | `401 Unauthorized` for UI routes |
| `GMAIL_CLIENT_SECRET` | Secret | `gmail.js`: OAuth token exchange / refresh | `Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET` |
| `TOKEN_ENC_KEY` | Secret | `gmail.js`: AES-GCM encrypt/decrypt refresh token | `Missing TOKEN_ENC_KEY` or `TOKEN_ENC_KEY must be base64 for 32-byte key` |
| `GMAIL_CLIENT_ID` | Var | `gmail.js`: OAuth URL + token exchange | `Missing GMAIL_CLIENT_ID` |
| `GMAIL_QUERY` | Var | `gmail.js`: `messages.list` query (default exists in code) | Poll may scan wrong/no messages if misconfigured |
| `GMAIL_MAX_PER_RUN` | Var | `gmail.js`: max messages per poll (default exists in code) | Too few/many messages per run |
| `ALLOW_ORIGIN` | Var | `worker.js`: CORS headers | Browser CORS failures from UI |
| `DB` | Binding (D1) | `worker.js`, `gmail.js`: all persistence and ingestion | `Missing D1 binding env.DB (bind your D1 as DB)` |
| `AI` or `AI_BINDING` | Binding/Var indirection | `worker.js`: extraction/scoring routes (`getAi_`) | `Missing Workers AI binding (env.AI or AI_BINDING)` |

## C) Terminal verification commands (no secret values)

Run from PowerShell in repo root:

```powershell
cd worker
wrangler whoami
wrangler secret list
wrangler d1 list
Get-Content .\wrangler.jsonc
wrangler deploy --dry-run
```

`wrangler vars list` is not consistently available across versions.
Equivalent safe check:
- inspect local `wrangler.jsonc`
- inspect Dashboard -> Worker -> Settings -> Variables for runtime values.

Optional diagnostics:

```powershell
wrangler tail
wrangler types
```

Linux/macOS equivalents:

```bash
cd worker
wrangler whoami
wrangler secret list
wrangler d1 list
cat ./wrangler.jsonc
wrangler deploy --dry-run
```

Expected:
- `whoami` resolves correct account.
- secret names exist (values not shown).
- D1 database exists and binding is valid.
- dry-run validates config/build without deployment.

## D) Runtime endpoint verification

Set placeholders:

```bash
BASE_URL="https://get-job.shivanand-shah94.workers.dev"
UI_KEY="<ui-key>"
API_KEY="<api-key>"
```

```powershell
$BASE_URL = "https://get-job.shivanand-shah94.workers.dev"
$UI_KEY = "<ui-key>"
$API_KEY = "<api-key>"
```

### 1) Health
curl:
```bash
curl -i "$BASE_URL/health"
```
PowerShell:
```powershell
Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET | Select-Object -ExpandProperty Content
```

### 2) Jobs list (UI auth)
curl:
```bash
curl -i "$BASE_URL/jobs?limit=1" -H "x-ui-key: $UI_KEY"
```
PowerShell:
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=1" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

### 3) Gmail OAuth entry (UI auth)
curl:
```bash
curl -i "$BASE_URL/gmail/auth" -H "x-ui-key: $UI_KEY"
```
PowerShell:
```powershell
Invoke-WebRequest -Uri "$BASE_URL/gmail/auth" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } -MaximumRedirection 0 -ErrorAction SilentlyContinue | Format-List StatusCode,Headers
```
Expected:
- HTTP `302`
- `Location` is Google OAuth URL.

### 4) Gmail poll (API auth)
curl:
```bash
curl -i -X POST "$BASE_URL/gmail/poll" -H "x-api-key: $API_KEY"
```
PowerShell:
```powershell
Invoke-WebRequest -Uri "$BASE_URL/gmail/poll" -Method POST -Headers @{ "x-api-key" = $API_KEY } | Select-Object -ExpandProperty Content
```
Expected:
- HTTP `200`
- response data keys: `scanned`, `processed`, `skipped_existing`, `inserted_or_updated`, `ignored`, `link_only`

## E) Troubleshooting table

| Failure symptom | Likely cause | How to confirm | Fix |
|---|---|---|---|
| `401 Unauthorized` | Wrong/missing API or UI key | Call endpoint with known-good key; check route type (`/jobs`=UI, `/gmail/poll`=API/cron) | Set correct secret in Cloudflare and send correct header (`x-ui-key` or `x-api-key`) |
| `Missing Workers AI binding (env.AI or AI_BINDING)` | AI binding not configured | Hit `/score-pending` or rescore endpoint and inspect error | Add Workers AI binding `AI` or set `AI_BINDING` to existing binding name |
| `/gmail/auth` or callback OAuth failure | `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` bad or redirect URI mismatch | Check `/gmail/auth` redirect URL and Google OAuth client redirect list | Set correct `GMAIL_CLIENT_ID`, rotate/set `GMAIL_CLIENT_SECRET`, ensure redirect URI exactly matches `/gmail/callback` |
| Cron not ingesting (`/gmail/poll` works manually) | Cron trigger missing or runtime failures | Verify `triggers.crons` in wrangler and use `wrangler tail` around schedule time | Ensure cron exists, deploy latest worker, inspect tail logs for Gmail API/token errors |
| D1 errors / missing tables | DB binding wrong or migrations not applied | `wrangler d1 list`; run endpoint and inspect `Missing D1 binding env.DB` or SQL errors | Ensure D1 binding name is `DB`; apply migrations (`001_init.sql`, `002_gmail.sql`) |
| Browser CORS failures | `ALLOW_ORIGIN` incorrect | Check response headers from Worker; browser console CORS error | Set `ALLOW_ORIGIN` to Pages origin in production (`https://getjobs...`) or `*` for debugging |
| Pages not deploying | Pages project branch/output misconfigured | Check Pages build settings + logs (`Output directory not found`, `No index.html`) | Set branch=`main`, root=`repo root`, output=`ui`, build command empty (or no-op) |
| `Wrangler permission error accessing C:\Users\dell\Application Data` | Windows profile path/permission issue for Wrangler cache/config | Re-run command in elevated shell; check exact error path; run `wrangler whoami` | Close locked terminals, run PowerShell as user with profile access, clear stale Wrangler state, or set/update `%USERPROFILE%`/Wrangler auth and retry |

## F) DB schema reality check (checklist fields)

- Baseline migration [`worker/migrations/001_init.sql`](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql) does **not** include:
  - `applied_note`
  - `follow_up_at`
  - `referral_status`
- Runtime code guards checklist endpoints with schema detection and returns clear `400` when fields are absent.
- If your production DB already has these columns (via earlier migration/manual ALTER), checklist endpoints will work.

Optional validation query (D1):
```sql
PRAGMA table_info(jobs);
```

## G) Verification checklist (5–10 min)

1. Run `wrangler whoami`, `wrangler secret list`, `wrangler d1 list`.
2. Confirm secrets exist by name: `API_KEY`, `UI_KEY`, `GMAIL_CLIENT_SECRET`, `TOKEN_ENC_KEY`.
3. Confirm vars include `GMAIL_CLIENT_ID` (plus query/max/origin vars) via `wrangler.jsonc` and Dashboard Variables.
4. Call runtime checks: `/health`, `/jobs?limit=1`, `/gmail/auth`, `/gmail/poll`.
5. If any failure occurs, use the troubleshooting table above and re-test.
