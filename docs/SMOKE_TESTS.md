# Smoke Tests (copy/paste)

Set variables.

## Bash
```bash
BASE_URL="https://get-job.shivanand-shah94.workers.dev"
UI_KEY="<your-ui-key>"
API_KEY="<your-api-key>"
JOB_KEY="<job_key>"
```

## PowerShell
```powershell
$BASE_URL = "https://get-job.shivanand-shah94.workers.dev"
$UI_KEY = "<your-ui-key>"
$API_KEY = "<your-api-key>"
$JOB_KEY = "<job_key>"
```

## 1) GET /health (public)
### curl
```bash
curl -sS "$BASE_URL/health"
```
### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET | Select-Object -ExpandProperty Content
```
Expected: `ok=true`.

## 2) POST /ingest (UI key)
### curl
```bash
curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"raw_urls":["https://www.linkedin.com/jobs/view/1234567890/"]}'
```
### PowerShell
```powershell
$body = @{ raw_urls = @("https://www.linkedin.com/jobs/view/1234567890/") } | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/ingest" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```
Expected: HTTP 200 with `data.results[]` and `inserted_or_updated`.
Also expect deterministic fields:
- `data.inserted_count`
- `data.updated_count`
- `data.link_only`
- each row has `was_existing` and `action`.

## 3) GET /jobs?limit=5 (UI key)
### curl
```bash
curl -sS "$BASE_URL/jobs?limit=5&offset=0" -H "x-ui-key: $UI_KEY"
```
### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=5&offset=0" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
Expected: rows include `job_key`, `status`, `display_title`.

## 4) GET /jobs/:job_key (UI key)
### curl
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY" -H "x-ui-key: $UI_KEY"
```
### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
Expected: job detail with status/system fields.

## 5) POST /jobs/:job_key/status (UI key)
### curl
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/status" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"status":"APPLIED"}'
```
### PowerShell
```powershell
$body = @{ status = "APPLIED" } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/status" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```
Expected: `data.status=APPLIED`.

## 6) POST /jobs/:job_key/rescore
Supported auth: **UI key only**.

### curl (supported)
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/rescore" -X POST -H "x-ui-key: $UI_KEY"
```
### PowerShell (supported)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/rescore" -Method POST -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
### curl (API key negative)
```bash
curl -i "$BASE_URL/jobs/$JOB_KEY/rescore" -X POST -H "x-api-key: $API_KEY"
```
Expected negative: `401 Unauthorized`.

## 7) POST /score-pending (both key modes)
### curl (UI key)
```bash
curl -sS "$BASE_URL/score-pending" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"limit":30}'
```
### curl (API key)
```bash
curl -sS "$BASE_URL/score-pending" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"limit":30}'
```
### PowerShell (UI key)
```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/score-pending" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```
### PowerShell (API key)
```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/score-pending" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```
Expected: `picked`, `updated`, `jobs[]`.

## 8) GET/POST /targets (UI key)
### curl GET list
```bash
curl -sS "$BASE_URL/targets" -H "x-ui-key: $UI_KEY"
```
### curl POST update
```bash
curl -sS "$BASE_URL/targets/TGT-001" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"name":"Core Product Target","primary_role":"Product Manager","seniority_pref":"Senior","location_pref":"Bangalore","must_keywords_json":["roadmap"],"nice_keywords_json":["saas"],"reject_keywords_json":["night shift"]}'
```
### PowerShell GET list
```powershell
Invoke-WebRequest -Uri "$BASE_URL/targets" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
### PowerShell POST update
```powershell
$body = @{ name="Core Product Target"; primary_role="Product Manager"; seniority_pref="Senior"; location_pref="Bangalore"; must_keywords_json=@("roadmap"); nice_keywords_json=@("saas"); reject_keywords_json=@("night shift") } | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/targets/TGT-001" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```
Expected:
- Works with UI key.
- If reject column missing in DB, API returns `meta.reject_keywords_enabled=false` and UI hides reject editor field.

## 9) GET/POST /jobs/:job_key/checklist (UI key)
### curl GET
```bash
curl -i "$BASE_URL/jobs/$JOB_KEY/checklist" -H "x-ui-key: $UI_KEY"
```
### curl POST
```bash
curl -i "$BASE_URL/jobs/$JOB_KEY/checklist" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"applied_note":"sent","follow_up_at":1735603200000,"referral_status":"requested"}'
```
### PowerShell GET
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/checklist" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```
### PowerShell POST
```powershell
$body = @{ applied_note="sent"; follow_up_at=1735603200000; referral_status="requested" } | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/checklist" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```
Expected:
- If checklist columns exist: normal success.
- If missing: HTTP 400 with `Checklist fields not enabled in DB schema` (no 500).

## 10) Manual recovery end-to-end (LinkedIn)
1. `POST /ingest` with LinkedIn URL.
2. `GET /jobs/:job_key` -> expect `LINK_ONLY` and `NEEDS_MANUAL_JD` or `AI_UNAVAILABLE`.
3. `POST /jobs/:job_key/manual-jd` with JD text.
4. `GET /jobs/:job_key` -> expect `final_score` when AI is available.

## 11) AI missing reproduction (graceful ingest + UI notice)
1. Temporarily deploy worker without AI binding (`AI` absent and no valid `AI_BINDING` var).
2. Run ingest:
### curl
```bash
curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"raw_urls":["https://www.linkedin.com/jobs/view/1234567890/"]}'
```
### PowerShell
```powershell
$body = @{ raw_urls = @("https://www.linkedin.com/jobs/view/1234567890/") } | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/ingest" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```
Expected:
- ingest still succeeds and returns per-row `action` (`inserted`/`updated`).
- row shows `fetch_status = ai_unavailable` and `system_status = AI_UNAVAILABLE`.
- in UI, scoring/rescore calls will surface an AI-missing warning banner (shown once per session).

## 12) Gmail connect flow (UI key)
### curl (inspect redirect target)
```bash
curl -i "$BASE_URL/gmail/auth" -H "x-ui-key: $UI_KEY"
```
Expected:
- HTTP `302`
- `Location` header points to Google OAuth URL with gmail.readonly scope.

### PowerShell (inspect redirect target)
```powershell
Invoke-WebRequest -Uri "$BASE_URL/gmail/auth" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } -MaximumRedirection 0 -ErrorAction SilentlyContinue | Format-List StatusCode,Headers
```

## 13) Gmail poll (manual run)
### curl
```bash
curl -sS "$BASE_URL/gmail/poll" \
  -X POST \
  -H "x-api-key: $API_KEY"
```

### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/gmail/poll" -Method POST -Headers @{ "x-api-key" = $API_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- HTTP `200`
- response shape includes:
  - `data.run_id`
  - `data.ts`
  - `data.query_used`
  - `data.scanned`
  - `data.processed`
  - `data.skipped_already_ingested` (and back-compat `data.skipped_existing`)
  - `data.urls_found_total`
  - `data.urls_unique_total`
  - `data.ignored_domains_count`
  - `data.ingested_count` (and back-compat `data.inserted_or_updated`)
  - `data.inserted_count`
  - `data.updated_count`
  - `data.link_only_count` (and back-compat `data.link_only`)
  - `data.ignored_count` (and back-compat `data.ignored`)

## 14) Gmail debug: force `scanned > 0`
1. Set Worker var `GMAIL_QUERY` to:
   - `in:anywhere newer_than:7d`
2. Run `POST /gmail/poll` (section 13).
3. Verify `data.scanned > 0`.

If `data.scanned = 0`, either:
- query does not match mailbox visibility, or
- OAuth account has no matching emails.

Override query without changing Worker vars:

### curl
```bash
curl -sS "$BASE_URL/gmail/poll" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query":"in:anywhere newer_than:7d","max_per_run":50}'
```

### PowerShell
```powershell
$body = @{ query = "in:anywhere newer_than:7d"; max_per_run = 50 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/gmail/poll" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- `data.scanned > 0`
- `data.urls_unique_total > 0` (for URL-bearing emails)

## 15) Deterministic end-to-end test email
1. Send yourself an email:
   - Subject: `JobOps Test 1`
   - Body: one supported URL on its own line (`linkedin/iimjobs/naukri`).
2. Set query temporarily:
   - `in:anywhere newer_than:2d subject:"JobOps Test 1"`
3. Run `POST /gmail/poll`.
4. Verify:
   - `data.scanned > 0`
   - `data.processed > 0`
   - `data.urls_found_total > 0`
   - `data.urls_job_domains_total > 0`
5. Confirm jobs ingestion:
   - `GET /jobs?limit=20&offset=0` with `x-ui-key`.

Tracking-link normalization check:
1. Send test mail with subject `JobOps Test 2`.
2. Include a LinkedIn tracking/collections URL that ultimately resolves to a jobs link.
3. Run poll with override query:
   - `in:anywhere newer_than:2d subject:"JobOps Test 2"`
4. Verify counters:
   - `data.urls_found_total > 0`
   - `data.urls_job_domains_total > 0` after normalization
   - `data.ingested_count > 0` or `data.ingest_ignored_count` explains rejection

## 16) Verify Gmail-ingested jobs appear
1. Run manual Gmail poll.
2. Fetch jobs:

### curl
```bash
curl -sS "$BASE_URL/jobs?limit=20&offset=0" -H "x-ui-key: $UI_KEY"
```

### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=20&offset=0" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- newly ingested jobs visible in jobs list.
