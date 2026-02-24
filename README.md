# JobOps V2

## Runbook (JobOps V2)

### What this repo contains

- `worker/`: Cloudflare Worker API, D1 access, and Workers AI integration.
- `ui/`: static frontend for Cloudflare Pages.
- Key files:
  - `worker/src/worker.js`
  - `worker/migrations/001_init.sql`
  - `worker/wrangler.jsonc`
  - `ui/index.html`
  - `ui/app.js`
  - `ui/styles.css`

### Deployment domains

- Worker: `https://get-job.shivanand-shah94.workers.dev`
- UI: `https://getjobs.shivanand-shah94.workers.dev`

### Auth model

- `GET /health` is public.
- UI endpoints require header `x-ui-key` equal to `env.UI_KEY`.
- Admin/AI endpoints require header `x-api-key` equal to `env.API_KEY`.

### Required bindings

- D1 binding variable name must be `DB`.
- Workers AI binding should be named `AI`.
- Alternative AI setup: set env var `AI_BINDING` to the binding name.

### Endpoint map

- `GET /health` (public)
- `GET /jobs?status=&limit=&offset=` (`x-ui-key`)
- `GET /jobs/:job_key` (`x-ui-key`)
- `POST /jobs/:job_key/status` (`x-ui-key`)
- `POST /ingest` (`x-ui-key`)
- `POST /score-pending` (`x-ui-key`)
- `POST /jobs/:job_key/rescore` (`x-ui-key`)
- `POST /extract-jd` (`x-api-key`)
- `POST /score-jd` (`x-api-key`)

### Quick tests (PowerShell)

Set variables:

```powershell
$BASE_URL = "https://get-job.shivanand-shah94.workers.dev"
$UI_KEY = "<your-ui-key>"
$API_KEY = "<your-api-key>"
```

Health check (public):

```powershell
Invoke-WebRequest -Uri "$BASE_URL/health" -Method GET | Select-Object -ExpandProperty Content
```

List jobs (`x-ui-key`):

```powershell
Invoke-WebRequest `
  -Uri "$BASE_URL/jobs?status=&limit=20&offset=0" `
  -Method GET `
  -Headers @{ "x-ui-key" = $UI_KEY } | Select-Object -ExpandProperty Content
```

Ingest raw URLs (`x-ui-key`):

```powershell
$body = @{
  raw_urls = @(
    "https://www.linkedin.com/jobs/view/1234567890/",
    "https://www.iimjobs.com/j/sample-role-123456.html"
  )
} | ConvertTo-Json -Depth 5

Invoke-WebRequest `
  -Uri "$BASE_URL/ingest" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-ui-key" = $UI_KEY } `
  -Body $body | Select-Object -ExpandProperty Content
```

Score pending (`x-ui-key`):

```powershell
$body = @{ limit = 30 } | ConvertTo-Json

Invoke-WebRequest `
  -Uri "$BASE_URL/score-pending" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-ui-key" = $UI_KEY } `
  -Body $body | Select-Object -ExpandProperty Content
```

Update job status (`x-ui-key`):

```powershell
$jobKey = "<job_key>"
$body = @{ status = "APPLIED" } | ConvertTo-Json

Invoke-WebRequest `
  -Uri "$BASE_URL/jobs/$jobKey/status" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-ui-key" = $UI_KEY } `
  -Body $body | Select-Object -ExpandProperty Content
```

Extract JD (`x-api-key`):

```powershell
$body = @{
  text = "Paste JD text here. Include enough content for extraction."
} | ConvertTo-Json -Depth 5

Invoke-WebRequest `
  -Uri "$BASE_URL/extract-jd" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-api-key" = $API_KEY } `
  -Body $body | Select-Object -ExpandProperty Content
```

### Known behavior

- LinkedIn fetch often returns cookie/privacy shell pages in server-side fetch.
- If JD extraction fails due to blocked/low-quality content, manual JD flow should be used.
