# Runtime Contract Audit

## UI-called endpoints (from `ui/app.js`)

1. `GET /jobs?status&limit&offset`
- Auth: `x-ui-key`
- Request keys: query `status`, `limit`, `offset`
- Response keys consumed: `data[]` including `job_key`, `status`, `display_title`, `company`, `location`, `final_score`, `source_domain`, `seniority`

2. `GET /jobs/:job_key`
- Auth: `x-ui-key`
- Request keys: path `job_key`
- Response keys consumed: full job row (`status`, `system_status`, `jd_source`, `fetch_status`, keywords arrays, scores)

3. `POST /jobs/:job_key/status`
- Auth: `x-ui-key`
- Request body: `{ status }`
- Response keys consumed: success only; UI refreshes list/detail

4. `POST /jobs/:job_key/rescore`
- Auth: `x-ui-key`
- Request body: none
- Response keys consumed: success only; UI refreshes list/detail

5. `POST /jobs/:job_key/manual-jd`
- Auth: `x-ui-key`
- Request body: `{ jd_text_clean }`
- Response keys consumed: success only; UI refreshes list/detail

6. `POST /ingest`
- Auth: `x-ui-key`
- Request body: `{ raw_urls[] }`
- Response keys consumed:
  - aggregate: `inserted_count`, `updated_count`, `ignored`, `link_only`
  - per row: `raw_url`, `job_key`, `status`, `was_existing`, `action`

7. `POST /score-pending`
- Auth sent by UI: `x-ui-key`
- Request body: `{ limit }`
- Response keys consumed: `data.picked`, `data.updated`

8. `GET /targets`
- Auth: `x-ui-key`
- Response keys consumed: `data[]` + `meta.reject_keywords_enabled`

9. `GET /targets/:id`
- Auth: `x-ui-key`
- Response keys consumed: target fields + optional `meta.reject_keywords_enabled`

10. `POST /targets/:id`
- Auth: `x-ui-key`
- Request body: `name`, `primary_role`, `seniority_pref`, `location_pref`, `must_keywords_json[]`, `nice_keywords_json[]`, optional `reject_keywords_json[]`
- Response keys consumed: success only

## Runtime auth behavior (from `worker/src/worker.js`)

- Public:
  - `GET /health`
  - `GET /`
- UI-only (`x-ui-key`):
  - `/jobs*`, `/ingest`, `/targets*`, `/jobs/:job_key/checklist`, `/jobs/:job_key/resume-payload`
- API-only (`x-api-key`):
  - `POST /normalize-job`, `POST /resolve-jd`, `POST /extract-jd`, `POST /score-jd`
- Either (`x-ui-key` OR `x-api-key`):
  - `POST /score-pending`

Auth is enforced centrally through `routeModeFor_()` + `requireAuth_()`.

## CORS runtime behavior
- `OPTIONS` preflight handled globally and returns `204`.
- Headers:
  - `Access-Control-Allow-Origin`: `ALLOW_ORIGIN` if `*` or URL, else fallback `*`
  - `Access-Control-Allow-Methods`: `POST,GET,OPTIONS`
  - `Access-Control-Allow-Headers`: `Content-Type,x-api-key,x-ui-key`
- Invalid value like `YES` is sanitized away by fallback logic.

## Docs-vs-runtime mismatches

1. Checklist schema documentation is environment-sensitive.
- Runtime uses schema guard (`getJobsSchema_`) and returns clear `400` when columns are missing.
- Some historical docs still imply baseline migration has checklist columns; baseline file does not.

2. Ingest contract changed recently.
- Runtime now returns deterministic `was_existing`, `action`, `inserted_count`, `updated_count`, `link_only`.
- Any older docs/tests referring only to heuristic dedupe are stale.

3. `/score-pending` auth expectations.
- Runtime accepts either key; UI uses UI key only.
- Any docs claiming UI-only for `/score-pending` are stale.

## Conclusion
- UI and Worker are aligned on current core contract and auth.
- Highest remaining contract risk is doc drift, not runtime mismatch.
