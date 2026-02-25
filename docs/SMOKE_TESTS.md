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
  - `data.skipped_promotional`
  - `data.skipped_promotional_heuristic`
  - `data.skipped_promotional_ai`
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

Cap behavior check (>8 URLs in one email):
1. Send one test email containing more than 8 supported job URLs.
2. Run poll with override:
   - `query`: subject-specific filter for that test email
   - `max_jobs_per_email`: `3`
   - `max_jobs_per_poll`: `5`
3. PowerShell example:
```powershell
$body = @{
  query = 'in:anywhere newer_than:2d subject:"JobOps Cap Test"'
  max_per_run = 20
  max_jobs_per_email = 3
  max_jobs_per_poll = 5
} | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/gmail/poll" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```
4. Verify:
   - `data.urls_job_domains_total > data.jobs_kept_total`
   - `data.jobs_dropped_due_to_caps_total > 0`
   - `data.jobs_kept_total <= 5`

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

## 17) Verify title/company fallback rendering
1. Call jobs list and confirm each row includes display fields:

### curl
```bash
curl -sS "$BASE_URL/jobs?limit=10&offset=0" -H "x-ui-key: $UI_KEY"
```

### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=10&offset=0" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- each row has non-empty `display_title` (`role_title` fallback, then `(Needs AI)` / `(Needs JD)` / `(Untitled)`)
- `display_company` is always present (empty string when company is missing)
- UI list and detail headers do not show blank title/company rows

## 18) Verify resume-pack tables exist (D1)
Run from `worker/` directory.

### Bash
```bash
wrangler d1 execute jobops-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('resume_profiles','resume_drafts');"
```

### PowerShell
```powershell
wrangler d1 execute jobops-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('resume_profiles','resume_drafts');"
```

Expected:
- both `resume_profiles` and `resume_drafts` appear
- if missing, apply migration: `wrangler d1 migrations apply jobops-db --remote`

## 19) Save profile + generate application pack (UI key)
Use a real job key from `/jobs`.

### curl: save profile
```bash
curl -sS "$BASE_URL/resume/profiles" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"id":"primary","name":"Primary","profile_json":{"basics":{"name":"Test User"},"summary":"Operator","experience":[],"skills":[]}}'
```

### PowerShell: save profile
```powershell
$body = @{ id="primary"; name="Primary"; profile_json=@{ basics=@{ name="Test User" }; summary="Operator"; experience=@(); skills=@() } } | ConvertTo-Json -Depth 10
Invoke-WebRequest -Uri "$BASE_URL/resume/profiles" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

### curl: generate pack
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/generate-application-pack" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"profile_id":"primary","force":false,"renderer":"reactive_resume"}'
```

### PowerShell: generate pack
```powershell
$body = @{ profile_id="primary"; force=$false; renderer="reactive_resume" } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/generate-application-pack" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

### curl: fetch pack
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/application-pack?profile_id=primary" -H "x-ui-key: $UI_KEY"
```

### PowerShell: fetch pack
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/application-pack?profile_id=primary" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- save profile returns `ok:true` with `id`
- generate returns `ok:true` with `status` (`DRAFT_READY` or `NEEDS_AI`)
- fetch pack returns saved `pack_json`, `ats_json`, `rr_export_json`
- fetch pack returns `rr_export_contract.id = "jobops.rr_export.v1"`
- fetch pack returns `rr_export_contract.schema_version = 1`
- fetch pack returns `rr_export_json.metadata.contract_valid = true`
- fetch pack returns `rr_export_json.metadata.import_ready` (boolean)

### Optional strict test: malformed profile JSON still returns deterministic RR payload

#### curl: save malformed profile
```bash
curl -sS "$BASE_URL/resume/profiles" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"id":"broken-profile","name":"Broken Profile","profile_json":{"basics":"bad","experience":["oops"],"skills":[1,2],"summary":123}}'
```

#### PowerShell: save malformed profile
```powershell
$body = @{ id="broken-profile"; name="Broken Profile"; profile_json=@{ basics="bad"; experience=@("oops"); skills=@(1,2); summary=123 } } | ConvertTo-Json -Depth 10
Invoke-WebRequest -Uri "$BASE_URL/resume/profiles" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Then generate + fetch using `profile_id=broken-profile`.

Expected:
- API stays `ok:true` with deterministic `rr_export_json`
- `rr_export_json.metadata.import_ready` may be `false`
- `rr_export_json.metadata.import_errors` lists strict import issues

## 20) If titles/company are missing
1. Call `/jobs?limit=5` and confirm rows include `display_title` and `display_company`.
2. If many rows show `(Needs AI)` and `system_status=AI_UNAVAILABLE`, AI extraction has not run.
3. Verify AI binding exists for Worker:
   - binding `AI` (preferred), or var `AI_BINDING` pointing to a valid AI binding name.
4. Validate AI routes:
   - `POST /extract-jd` with `x-api-key` should return `ok:true` for valid text.

## 21) RSS poll (API key)
Set worker var `RSS_FEEDS` to comma/newline-separated feed URLs, then call:

### curl
```bash
curl -sS "$BASE_URL/rss/poll" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"max_per_run":20}'
```

### PowerShell
```powershell
$body = @{ max_per_run = 20 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/rss/poll" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- `ok:true`
- `data.feeds_total >= 1` (when feeds are configured)
- `data.items_listed >= 0`
- `data.items_filtered_allow` / `data.items_filtered_block` present
- `data.urls_job_domains_total >= 0`
- `data.inserted_or_updated` present
- `data.source_summary[]` present

Optional one-off override without env var:

### curl
```bash
curl -sS "$BASE_URL/rss/poll" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"feed_urls":["https://example.com/jobs-feed.xml"],"max_per_run":10,"allow_keywords":["strategy","consulting"],"block_keywords":["newsletter","premium","upgrade"]}'
```

## 22) RSS diagnostics (API key only)
Purpose: debug why RSS items are not turning into ingest candidates, without exposing feed message content.

### curl (diagnostics run)
```bash
curl -sS "$BASE_URL/rss/diagnostics" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"max_per_run":10,"sample_limit":5}'
```

### PowerShell (diagnostics run)
```powershell
$body = @{ max_per_run = 10; sample_limit = 5 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/rss/diagnostics" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected keys under `data`:
- `run_id`, `ts`
- `feeds_total`, `feeds_processed`, `feeds_failed`
- `items_listed`, `items_filtered_allow`, `items_filtered_block`, `processed`
- `urls_found_total`, `urls_unique_total`, `urls_job_domains_total`, `ignored_domains_count`
- `inserted_or_updated`, `inserted_count`, `updated_count`, `ignored`, `link_only`
- `reason_buckets` with:
  - `unsupported_domain`
  - `normalize_ignored`
  - `unresolved_wrapper`
  - `duplicate_candidate`
  - `no_url_in_item`
  - `ingested`
- `unsupported_domain_by_host` (host -> count)
- `rejected_url_samples[]` (capped URL-only samples with `reason` + `url`)
- `feed_summaries[]` with `sample_candidates[]` (URL-only)
- `source_summary[]`

### Negative auth check (must fail without API key)
```bash
curl -i "$BASE_URL/rss/diagnostics" -X POST -H "Content-Type: application/json" -d '{}'
```
Expected: `401 Unauthorized`.

### Override feeds and keyword filters for one run
```powershell
$body = @{
  feed_urls = @(
    "https://example.com/feed-1.xml",
    "https://example.com/feed-2.xml"
  )
  max_per_run = 10
  sample_limit = 5
  allow_keywords = @("strategy","consulting")
  block_keywords = @("newsletter","premium","upgrade")
} | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/rss/diagnostics" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```

## 23) Verify fallback reason logging (blocked/low_quality/manual_required)
Trigger ingest with a known difficult URL (e.g., LinkedIn) and inspect result rows:

### curl
```bash
curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"raw_urls":["https://www.linkedin.com/jobs/view/1234567890/"]}'
```

Expected per result row:
- `fallback_reason` is one of `blocked`, `low_quality`, `manual_required`, or `none`
- `fallback_policy` present

Then verify events in D1:

```bash
wrangler d1 execute jobops-db --remote --command "SELECT event_type, job_key, payload_json, ts FROM events WHERE event_type='INGEST_FALLBACK' ORDER BY ts DESC LIMIT 10;"
```

Expected payload keys:
- `source_domain`
- `fallback_reason` (`blocked|low_quality|manual_required`)
- `fallback_policy`

## 24) Recovery automation (manual endpoint smoke + cron vars)
Recovery now runs in cron when enabled, using:
- `RECOVERY_ENABLED` (`1`/`0`)
- `RECOVER_BACKFILL_LIMIT` (default `30`)
- `RECOVER_RESCORE_LIMIT` (default `30`)

Manual endpoint check (same flow UI Tracking CTA uses):

### curl
```bash
curl -sS "$BASE_URL/jobs/backfill-missing" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"limit":30}'
```

```bash
curl -sS "$BASE_URL/jobs/recover/rescore-existing-jd" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"limit":30}'
```

### PowerShell
```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/jobs/backfill-missing" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
Invoke-WebRequest -Uri "$BASE_URL/jobs/recover/rescore-existing-jd" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- backfill returns `picked`, `processed`, `inserted_or_updated`, `updated_count`, `link_only`, `source_summary`
- rescore-existing-jd returns `picked`, `updated`, `jobs[]`
- `fetch_status`
