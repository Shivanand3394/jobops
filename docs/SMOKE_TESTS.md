# Smoke Tests (copy/paste)

Set variables first.

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

## 1) Health (public)
Purpose: worker liveness without auth.

### curl
```bash
curl -sS "$BASE_URL/health"
```

### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- `{"ok":true,"ts":...}`

## 2) Jobs list (UI key)
Purpose: verify UI auth and list payload.

### curl
```bash
curl -sS "$BASE_URL/jobs?limit=20&offset=0" -H "x-ui-key: $UI_KEY"
```

### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=20&offset=0" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- each item includes `job_key`, `status`, `display_title`

## 3) Ingest URL(s) (UI key)
Purpose: ingest links and create/upsert rows.

### curl
```bash
curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{
    "raw_urls": [
      "https://www.iimjobs.com/j/sample-role-123456.html",
      "https://www.naukri.com/sample-role-jobs-123456",
      "https://www.linkedin.com/jobs/view/1234567890/"
    ]
  }'
```

### PowerShell
```powershell
$body = @{
  raw_urls = @(
    "https://www.iimjobs.com/j/sample-role-123456.html",
    "https://www.naukri.com/sample-role-jobs-123456",
    "https://www.linkedin.com/jobs/view/1234567890/"
  )
} | ConvertTo-Json -Depth 6

Invoke-WebRequest -Uri "$BASE_URL/ingest" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- `data.results[*].job_key` present
- LinkedIn may produce `system_status=NEEDS_MANUAL_JD`, `status=LINK_ONLY`
- If AI binding is missing, expect `fetch_status=ai_unavailable` and graceful insert/update (still HTTP 200)

## 4) Batch score pending (UI key OR API key)
Purpose: score NEW/SCORED jobs.

### curl
```bash
curl -sS "$BASE_URL/score-pending" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"limit":30}'
```

### PowerShell
```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/score-pending" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- `data.picked`, `data.updated`, `data.jobs`
- Auth clarification: this route accepts either valid `x-ui-key` or `x-api-key`.

### curl (API key variant)
```bash
curl -sS "$BASE_URL/score-pending" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"limit":30}'
```

### PowerShell (API key variant)
```powershell
$body = @{ limit = 30 } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/score-pending" -Method POST -ContentType "application/json" -Headers @{ "x-api-key" = $API_KEY } -Body $body | Select-Object -ExpandProperty Content
```

## 5) Job detail (UI key)
Purpose: confirm detailed payload and manual-JD flags.

### curl
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY" -H "x-ui-key: $UI_KEY"
```

### PowerShell
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- includes `status`, `system_status`, `fetch_status`, `jd_source`

## 6) Set status (UI key)
Purpose: verify explicit status change path.

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

Expected:
- HTTP 200
- `data.status` is `APPLIED`

## 7) Manual JD (UI key)
Purpose: recover blocked/low-quality fetch records.

### curl
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/manual-jd" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"jd_text_clean":"Paste at least 200 chars of JD text here..."}'
```

### PowerShell
```powershell
$body = @{ jd_text_clean = "Paste at least 200 chars of JD text here..." } | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/manual-jd" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- If AI configured: returns scored data with `status` + `final_score`
- If AI unavailable: returns `saved_only=true` and clear message; JD text is still saved

## 8) Negative auth tests

### 8a) UI endpoint with API key only (must fail)
```bash
curl -i "$BASE_URL/jobs?limit=1" -H "x-api-key: $API_KEY"
```

```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs?limit=1" -Method GET -Headers @{ "x-api-key" = $API_KEY } | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 401

### 8b) Admin endpoint with UI key only (must fail)
```bash
curl -i "$BASE_URL/extract-jd" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"text":"sample jd text long enough to pass minimum length test in a real run"}'
```

```powershell
$body = @{ text = "sample jd text long enough to pass minimum length test in a real run" } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/extract-jd" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 401

## 9) LinkedIn blocked -> manual recovery
### curl end-to-end
```bash
# ingest linkedin
INGEST_RESP=$(curl -sS "$BASE_URL/ingest" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"raw_urls":["https://www.linkedin.com/jobs/view/1234567890/"]}')
echo "$INGEST_RESP"

# use returned job_key (replace <JOB_KEY>)
curl -sS "$BASE_URL/jobs/<JOB_KEY>" -H "x-ui-key: $UI_KEY"

# manual jd paste + rescore
curl -sS "$BASE_URL/jobs/<JOB_KEY>/manual-jd" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"jd_text_clean":"Paste full JD text with at least 200 characters..."}'

# verify final_score is populated
curl -sS "$BASE_URL/jobs/<JOB_KEY>" -H "x-ui-key: $UI_KEY"
```

### PowerShell end-to-end
```powershell
$ingestBody = @{ raw_urls = @("https://www.linkedin.com/jobs/view/1234567890/") } | ConvertTo-Json -Depth 6
$ingest = Invoke-WebRequest -Uri "$BASE_URL/ingest" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $ingestBody | Select-Object -ExpandProperty Content
$ingestObj = $ingest | ConvertFrom-Json
$JOB_KEY = $ingestObj.data.results[0].job_key

Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content

$manualBody = @{ jd_text_clean = "Paste full JD text with at least 200 characters..." } | ConvertTo-Json -Depth 6
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/manual-jd" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $manualBody | Select-Object -ExpandProperty Content

Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

## 10) Ingest when AI binding is missing (graceful)
Purpose: confirm ingest does not fail hard if Workers AI binding is unavailable.

Expected:
- HTTP 200
- rows are still inserted/updated in D1
- each affected result has `status=LINK_ONLY`, `system_status=NEEDS_MANUAL_JD`, `fetch_status=ai_unavailable`

## 11) Targets list + upsert (UI key)
Purpose: verify Targets CRUD paths used by UI.

### curl list
```bash
curl -sS "$BASE_URL/targets" -H "x-ui-key: $UI_KEY"
```

### PowerShell list
```powershell
Invoke-WebRequest -Uri "$BASE_URL/targets" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

### curl upsert/update
```bash
curl -sS "$BASE_URL/targets/TGT-001" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{
    "name":"Core Product Target",
    "primary_role":"Product Manager",
    "seniority_pref":"Senior",
    "location_pref":"Bangalore",
    "must_keywords_json":["product strategy","roadmap"],
    "nice_keywords_json":["saas","growth"],
    "reject_keywords_json":["night shift"]
  }'
```

### PowerShell upsert/update
```powershell
$body = @{
  name = "Core Product Target"
  primary_role = "Product Manager"
  seniority_pref = "Senior"
  location_pref = "Bangalore"
  must_keywords_json = @("product strategy","roadmap")
  nice_keywords_json = @("saas","growth")
  reject_keywords_json = @("night shift")
} | ConvertTo-Json -Depth 6

Invoke-WebRequest -Uri "$BASE_URL/targets/TGT-001" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

Expected:
- HTTP 200
- `GET /targets` returns list with `id/name/primary_role/seniority_pref/location_pref`
- if DB lacks `reject_keywords_json`, API meta indicates `reject_keywords_enabled=false` and reject field is ignored/hidden in UI
