# UI <-> API Matrix

## UI-called endpoints

### `GET /jobs?status=&limit=&offset=`
- Headers: `Content-Type`, `x-ui-key`
- Body: none
- Where called: [ui/app.js:134](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:134) `loadJobs()`
- Response fields used:
  - list: `job_key`, `status`, `final_score`, `display_title`, `role_title`, `company`, `location`, `source_domain`, `seniority`

### `GET /jobs/:job_key`
- Headers: `Content-Type`, `x-ui-key`
- Body: none
- Where called: [ui/app.js:153](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:153) `setActive()`
- Response fields used:
  - detail: `job_key`, `job_url`, `status`, `system_status`, `next_status`, `final_score`, `primary_target_id`, `must_have_keywords`, `nice_to_have_keywords`, `reject_keywords`, `reason_top_matches`, `jd_source`, `fetch_status`, `role_title`, `display_title`, `company`

### `POST /jobs/:job_key/status`
- Headers: `Content-Type`, `x-ui-key`
- Body: `{ status }`
- Where called: [ui/app.js:250](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:250) `updateStatus()`
- Response fields used: none directly; UI reloads list/detail

### `POST /jobs/:job_key/manual-jd`
- Headers: `Content-Type`, `x-ui-key`
- Body: `{ jd_text_clean }`
- Where called: [ui/app.js:264](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:264) `saveAndRescoreManualJd()`
- Response fields used: none directly; UI reloads list/detail

### `POST /jobs/:job_key/rescore`
- Headers: `Content-Type`, `x-ui-key`
- Body: none
- Where called: [ui/app.js:286](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:286) `rescoreOne()`
- Response fields used: none directly; UI reloads list/detail

### `POST /ingest`
- Headers: `Content-Type`, `x-ui-key`
- Body: `{ raw_urls }`
- Where called: [ui/app.js:308](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:308) `ingestUrls()`, [ui/app.js:314](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:314) `doIngest()`
- Response fields used:
  - modal output: full response JSON
  - auto-open: `data.results[0].job_key` if present

### `POST /score-pending`
- Headers: `Content-Type`, `x-ui-key`
- Body: `{ limit }`
- Where called: [ui/app.js:342](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:342) `rescorePending()`
- Response fields used:
  - toast: `data.picked`, `data.updated`

### `GET /targets`
- Headers: `Content-Type`, `x-ui-key`
- Body: none
- Where called: `ui/app.js` `loadTargets()`
- Response fields used:
  - list: `id`, `name`, `primary_role`, `seniority_pref`, `location_pref`
  - meta: `meta.reject_keywords_enabled`

### `GET /targets/:id`
- Headers: `Content-Type`, `x-ui-key`
- Body: none
- Where called: `ui/app.js` `setActiveTarget()`
- Response fields used:
  - form: `id`, `name`, `primary_role`, `seniority_pref`, `location_pref`, `must_keywords_json`, `nice_keywords_json`, `reject_keywords_json`
  - meta: `meta.reject_keywords_enabled`

### `POST /targets/:id`
- Headers: `Content-Type`, `x-ui-key`
- Body: `{ name, primary_role, seniority_pref, location_pref, must_keywords_json[], nice_keywords_json[], reject_keywords_json[]? }`
- Where called: `ui/app.js` `saveActiveTarget()`
- Response fields used:
  - none directly; UI reloads list/detail

## Worker-implemented endpoints

### Public
- `GET /health`
  - Auth: public
  - Response: `{ ok, ts }`

### UI-auth (`x-ui-key`)
- `GET /jobs`
- `GET /jobs/:job_key`
- `POST /jobs/:job_key/status`
- `POST /jobs/:job_key/manual-jd`
- `POST /jobs/:job_key/rescore`
- `GET /jobs/:job_key/checklist`
- `POST /jobs/:job_key/checklist`
- `GET /jobs/:job_key/resume-payload`
- `POST /ingest`
- `POST /score-pending`
- `GET /targets`
- `GET /targets/:id`
- `POST /targets/:id`

### Admin/API-auth (`x-api-key`)
- `POST /normalize-job`
- `POST /resolve-jd`
- `POST /extract-jd`
- `POST /score-jd`

## Mismatch report
- No blocking request/response mismatch between current UI calls and Worker routes.
- `/score-pending` is now consistently UI-auth only (`x-ui-key`) in both global gate and handler behavior.
- `display_title` fallback is available server-side and consumed by UI (`(Needs JD)` fallback).
- List items are clickable via click and keyboard handlers on `.job-card`.
- Gaps still present:
  - Dedupe message relies on repeated returned `job_key` evidence; Worker does not yet return explicit `was_existing` per row.
