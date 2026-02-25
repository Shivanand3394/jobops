# Resume Pack (Job Application Pack)

JobOps can generate a stable Application Pack per job/profile and store it in D1.

Pack output is renderer-agnostic:
- `pack_json`: job + target + tailoring data
- `ats_json`: deterministic ATS coverage/score
- `rr_export_json`: Reactive Resume-compatible export payload (adapter output)

RR export contract (locked):
- `rr_export_json.metadata.contract_id = "jobops.rr_export.v1"`
- `rr_export_json.metadata.schema_version = 1`
- `rr_export_json.job_context.job_key` is always present

Worker behavior:
- normalizes RR payload on generate/save/fetch
- validates contract fields and marks `metadata.contract_valid`

Reactive Resume is not a runtime dependency; it is an export format target.

## Statuses
- `DRAFT_READY`: full pack generated
- `NEEDS_AI`: saved with deterministic tailoring, AI polish unavailable
- `ERROR`: generation failed; check `error_text`

## Endpoints (UI key)
- `GET /resume/profiles`
- `POST /resume/profiles`
- `POST /jobs/:job_key/generate-application-pack`
- `GET /jobs/:job_key/application-pack`

## Example: list profiles
PowerShell:
```powershell
$BASE_URL = "https://get-job.shivanand-shah94.workers.dev"
$UI_KEY = "<ui-key>"
Invoke-WebRequest -Uri "$BASE_URL/resume/profiles" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

curl:
```bash
curl -sS "$BASE_URL/resume/profiles" -H "x-ui-key: $UI_KEY"
```

## Example: upsert profile
PowerShell:
```powershell
$body = @{
  id = "primary"
  name = "Primary"
  profile_json = @{
    basics = @{ name=""; email=""; phone=""; location="" }
    summary = ""
    experience = @()
    skills = @()
  }
} | ConvertTo-Json -Depth 8
Invoke-WebRequest -Uri "$BASE_URL/resume/profiles" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

curl:
```bash
curl -sS "$BASE_URL/resume/profiles" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"id":"primary","name":"Primary","profile_json":{"basics":{"name":"","email":"","phone":"","location":""},"summary":"","experience":[],"skills":[]}}'
```

## Example: generate application pack
PowerShell:
```powershell
$JOB_KEY = "<job_key>"
$body = @{
  profile_id = "primary"
  force = $true
  renderer = "reactive_resume"
} | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/generate-application-pack" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

curl:
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/generate-application-pack" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"profile_id":"primary","force":true,"renderer":"reactive_resume"}'
```

## Example: fetch pack
PowerShell:
```powershell
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/application-pack?profile_id=primary" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

curl:
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/application-pack?profile_id=primary" -H "x-ui-key: $UI_KEY"
```

Expected on fetch:
- `data.rr_export_contract.id = "jobops.rr_export.v1"`
- `data.rr_export_contract.schema_version = 1`
- `data.rr_export_json.metadata.contract_valid = true`

## Mobile usage
From job detail in UI:
1. Select profile / renderer.
2. Save profile JSON if needed.
3. Tap `Generate` or `Regenerate`.
4. Use `Copy tailored summary`, `Copy tailored bullets`, or `Download RR JSON`.
