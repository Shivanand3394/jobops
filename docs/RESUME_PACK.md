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
- validates import readiness and marks `metadata.import_ready` + `metadata.import_errors`

Reactive Resume is not a runtime dependency; it is an export format target.

## Statuses
- `DRAFT_READY`: full pack generated
- `NEEDS_AI`: saved with deterministic tailoring, AI polish unavailable
- `ERROR`: generation failed; check `error_text`
- `READY_FOR_EXPORT`: reviewed draft saved, waiting for approval/export
- `READY_TO_APPLY`: approved draft locked for apply flow

Lock behavior:
- Once a draft is `READY_TO_APPLY` or `APPLIED`, non-force generate/regenerate calls do not overwrite it.
- Use `force=true` to intentionally regenerate a locked draft.

## Endpoints (UI key)
- `GET /resume/profiles`
- `POST /resume/profiles`
- `POST /jobs/:job_key/generate-application-pack`
- `GET /jobs/:job_key/application-pack`
- `GET /resume/rr/health` (safe Reactive Resume connectivity probe)
- `POST /jobs/:job_key/push-reactive-resume` (push RR payload to RR API)

## Optional Reactive Resume runtime bridge vars
- `RR_BASE_URL` (var): Reactive Resume API base URL (e.g. `https://rr.example.com`)
- `RR_HEALTH_PATH` (var, optional): health probe path (default `/api/health`)
- `RR_IMPORT_PATH` (var, optional): import path (default `/api/openapi/resumes/import`)
- `RR_TIMEOUT_MS` (var, optional): probe timeout in ms (default `6000`)
- `RR_KEY` (secret): API key used server-side by Worker only

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

## Example: probe Reactive Resume connectivity (safe)
PowerShell:
```powershell
Invoke-WebRequest -Uri "$BASE_URL/resume/rr/health" -Method GET -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

curl:
```bash
curl -sS "$BASE_URL/resume/rr/health" -H "x-ui-key: $UI_KEY"
```

Expected:
- `ok: true`
- `data.status` one of: `ready`, `unauthorized`, `endpoint_not_found`, `unreachable`, `missing_config`
- no secrets are returned

## Example: push pack to Reactive Resume (safe server-side key use)
PowerShell:
```powershell
$body = @{ profile_id = "primary" } | ConvertTo-Json
Invoke-WebRequest -Uri "$BASE_URL/jobs/$JOB_KEY/push-reactive-resume" -Method POST -ContentType "application/json" -Headers @{ "x-ui-key" = $UI_KEY } -Body $body | Select-Object -ExpandProperty Content
```

curl:
```bash
curl -sS "$BASE_URL/jobs/$JOB_KEY/push-reactive-resume" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-ui-key: $UI_KEY" \
  -d '{"profile_id":"primary"}'
```

Expected:
- `ok: true`
- `data.rr_resume_id` present when RR returns an identifier
- `data.rr_push_adapter` is `jobops_rr_export` or `rxresu_data_model_fallback`
- no RR secret exposed to UI

Expected on fetch:
- `data.rr_export_contract.id = "jobops.rr_export.v1"`
- `data.rr_export_contract.schema_version = 1`
- `data.rr_export_json.metadata.contract_valid = true`
- `data.rr_export_json.metadata.import_ready` is present
- `data.rr_export_json.metadata.import_errors` is present only when import checks fail

## Mobile usage
From job detail in UI:
1. Select profile / renderer.
2. Save profile JSON if needed.
3. Tap `Generate` or `Regenerate`.
4. Use `Copy tailored summary`, `Copy tailored bullets`, or `Download RR JSON`.
5. In wizard `Finish`, use `PDF-ready view` + `Print / Save PDF` for portal uploads that require a file.
