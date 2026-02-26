# UI <-> API Matrix

## UI action map

### Ingest URL(s)
- UI action: Add URL modal -> Ingest
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:522)
- Endpoint: `POST /ingest`
- Auth header: `x-ui-key`
- Body keys: `raw_urls[]`
- Response used: `inserted_or_updated`, `ignored`, `results[].job_key`, `results[].status`

### Load jobs list
- UI action: initial load / filter / refresh
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:156)
- Endpoint: `GET /jobs`
- Auth header: `x-ui-key`
- Query: `status?`, `limit`, `offset`
- Response used: list rows + `display_title`

### Open job detail
- UI action: click/keyboard on job list card
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:149), [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:175)
- Endpoint: `GET /jobs/:job_key`
- Auth header: `x-ui-key`
- Response used: detail fields, scoring fields, status fields

### Update lifecycle status
- UI action: Mark APPLIED/SHORTLISTED/REJECTED/ARCHIVED
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:458)
- Endpoint: `POST /jobs/:job_key/status`
- Auth header: `x-ui-key`
- Body: `{status}`

### Rescore single job
- UI action: Rescore this job
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:494)
- Endpoint: `POST /jobs/:job_key/rescore`
- Auth header: `x-ui-key`
- Body: none

### Save manual JD + rescore
- UI action: Save & Rescore in manual JD section
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:472)
- Endpoint: `POST /jobs/:job_key/manual-jd`
- Auth header: `x-ui-key`
- Body: `{jd_text_clean}`

### Batch score pending
- UI action: Rescore NEW+SCORED / Rescore (safe)
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:566)
- Endpoint: `POST /score-pending`
- Auth header sent by UI: `x-ui-key`
- Body: `{limit}`

### Targets list/detail/save
- UI actions: switch Targets tab, select target, save target
- Code: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:380), [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:404), [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:425)
- Endpoints:
  - `GET /targets`
  - `GET /targets/:id`
  - `POST /targets/:id`
- Auth header: `x-ui-key`
- Schema fallback: uses `meta.reject_keywords_enabled` to hide reject keywords field when unsupported.

## Worker route/auth truth table

### Public
- `GET /health`
- `GET /`

### UI-only (`x-ui-key`)
- `GET /jobs`
- `GET /jobs/:job_key`
- `POST /jobs/:job_key/status`
- `POST /jobs/:job_key/manual-jd`
- `POST /jobs/:job_key/rescore`
- `GET /jobs/:job_key/checklist`
- `POST /jobs/:job_key/checklist`
- `GET /jobs/:job_key/resume-payload`
- `POST /ingest`
- `GET /targets`
- `GET /targets/:id`
- `POST /targets/:id`

### API-only (`x-api-key`)
- `POST /normalize-job`
- `POST /resolve-jd`
- `POST /extract-jd`
- `POST /score-jd`
- `GET /admin/scoring-runs/report`

### Either (`x-ui-key` OR `x-api-key`)
- `POST /score-pending`

## Drift and contradictions
- Correct runtime behavior: `/score-pending` accepts either key (not UI-only).
- UI sends only `x-ui-key` and never references API key.
- Checklist route safety improved:
  - if checklist columns are absent, routes now return clear 400 instead of 500.
- Remaining gap:
  - ingest response still lacks deterministic `was_existing` per row.
