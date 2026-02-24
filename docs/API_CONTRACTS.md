# API Contracts (Source of Truth)

Base URL (prod): `https://get-job.shivanand-shah94.workers.dev`

Auth headers:
- UI routes: `x-ui-key: <UI_KEY>`
- API routes: `x-api-key: <API_KEY>`
- Either routes: one valid key is enough

## Public routes

### GET /health
- Auth: none
- Response 200:
```json
{ "ok": true, "ts": 1700000000000 }
```

### GET /
- Auth: none
- Response 200 text: `JobOps API (UI authenticated). Use /jobs`

## UI routes

### GET /jobs
- Auth: `x-ui-key`
- Query: `status?`, `q?`, `limit?`, `offset?`
- Response 200:
```json
{ "ok": true, "data": [ { "job_key":"...", "status":"NEW", "display_title":"..." } ] }
```
- Side effects: none
- Failures: `401`, `500` (missing DB), `500` worker exception

### GET /jobs/:job_key
- Auth: `x-ui-key`
- Response 200: full job row + parsed arrays + `display_title`
- Side effects: none
- Failures: `401`, `404`, `500`

### POST /jobs/:job_key/status
- Auth: `x-ui-key`
- Body:
```json
{ "status":"APPLIED|ARCHIVED|REJECTED|SHORTLISTED|SCORED|NEW|LINK_ONLY" }
```
- Response 200:
```json
{ "ok": true, "data": { "job_key":"...", "status":"APPLIED", "updated_at":1700000000000 } }
```
- Side effects: updates `jobs.status`, `updated_at`, and status-specific timestamp columns.
- Failures: `400` invalid body/status, `401`, `404`, `500`

### POST /jobs/:job_key/rescore
- Auth: `x-ui-key`
- Body: none
- Response 200:
```json
{ "ok": true, "data": { "job_key":"...", "final_score":82, "status":"SHORTLISTED", "primary_target_id":"TGT-001" } }
```
- Side effects: updates extraction/scoring/status fields and `last_scored_at`.
- Failures: `400` (missing scoreable input / no targets), `401`, `404`, `500` (including missing AI)

### POST /jobs/:job_key/manual-jd
- Auth: `x-ui-key`
- Body:
```json
{ "jd_text_clean":"...>=200 chars..." }
```
- Response 200 (AI available):
```json
{ "ok": true, "data": { "job_key":"...", "status":"SCORED", "final_score":66, "primary_target_id":"TGT-001" } }
```
- Response 200 (AI missing):
```json
{ "ok": true, "data": { "job_key":"...", "status":"LINK_ONLY", "saved_only":true, "message":"Manual JD saved, but AI binding is unavailable. Configure AI and rescore." } }
```
- Side effects: always stores JD text; may score/update if AI available.
- Failures: `400` short JD, `401`, `404`, `500`

### POST /ingest
- Auth: `x-ui-key`
- Body:
```json
{ "raw_urls":["https://..."], "email_text":"...optional...", "email_html":"...optional..." }
```
- Response 200:
```json
{
  "ok": true,
  "data": {
    "count_in": 1,
    "inserted_or_updated": 1,
    "inserted_count": 0,
    "updated_count": 1,
    "ignored": 0,
    "link_only": 1,
    "results": [
      {
        "raw_url":"...",
        "job_key":"...",
        "job_url":"...",
        "was_existing": true,
        "action":"inserted|updated|ignored|link_only",
        "status":"NEW|LINK_ONLY",
        "jd_source":"fetched|email|none",
        "fetch_status":"ok|blocked|failed|ai_unavailable",
        "system_status":"NEEDS_MANUAL_JD|AI_UNAVAILABLE|null"
      }
    ]
  }
}
```
- Side effects: inserts/updates `jobs` rows.
- Action semantics:
  - `inserted`/`updated` are deterministic from pre-upsert existence check.
  - `ignored` means URL normalization rejected the row.
  - `link_only` means row stayed in link-only pipeline while AI was available (low-quality/blocked JD path).
  - When AI is unavailable, ingest still upserts and action remains `inserted` or `updated`.
- Failures: `400` missing `raw_urls[]`, `401`, `500` missing DB, `500` worker exception

### POST /score-pending
- Auth: either `x-ui-key` or `x-api-key`
- Body:
```json
{ "limit":30, "status":"NEW|SCORED (optional)" }
```
- Response 200:
```json
{ "ok": true, "data": { "picked": 10, "updated": 8, "jobs": [ { "job_key":"...", "ok":true, "status":"SCORED", "final_score":70 } ] } }
```
- Side effects: scoring/status updates on selected rows.
- Failures: `400` no targets, `401`, `500` missing AI or DB

### GET /targets
- Auth: `x-ui-key`
- Response 200:
```json
{
  "ok": true,
  "data": [
    {
      "id":"TGT-001",
      "name":"...",
      "primary_role":"...",
      "seniority_pref":"...",
      "location_pref":"...",
      "must_keywords_json":"[ ... ]",
      "nice_keywords_json":"[ ... ]",
      "reject_keywords_json":"[ ... ]",
      "must_keywords":["..."],
      "nice_keywords":["..."],
      "reject_keywords":["..."]
    }
  ],
  "meta": { "reject_keywords_enabled": true }
}
```
- Side effects: none
- Failures: `401`, `500`

### GET /targets/:id
- Auth: `x-ui-key`
- Response 200: one target + `meta.reject_keywords_enabled`
- Side effects: none
- Failures: `400`, `401`, `404`, `500`

### POST /targets/:id
- Auth: `x-ui-key`
- Body keys: `name`, `primary_role`, `seniority_pref`, `location_pref`, `must_keywords_json|must_keywords`, `nice_keywords_json|nice_keywords`, `reject_keywords_json|reject_keywords`
- Behavior: updates existing target row only (not insert-on-missing)
- Response 200:
```json
{ "ok": true, "data": { "id":"TGT-001", "updated_at":1700000000000 } }
```
- Failures: `400`, `401`, `404`, `500`

### GET /jobs/:job_key/checklist
- Auth: `x-ui-key`
- Response 200 (when checklist columns exist): returns `job_key`, `applied_note`, `follow_up_at`, `referral_status`, `applied_at`.
- Response 400 (when checklist columns are missing):
```json
{ "ok": false, "error": "Checklist fields not enabled in DB schema" }
```
- Failures: `400`, `401`, `404`, `500`

### POST /jobs/:job_key/checklist
- Auth: `x-ui-key`
- Body: `applied_note`, `follow_up_at`, `referral_status`
- Response 200: `{ "ok": true, "data": { "job_key":"...", "updated_at":1700000000000 } }`
- Response 400 (when checklist columns are missing):
```json
{ "ok": false, "error": "Checklist fields not enabled in DB schema" }
```
- Failures: `400`, `401`, `404`, `500`

### GET /jobs/:job_key/resume-payload
- Auth: `x-ui-key`
- Response 200:
```json
{
  "ok": true,
  "data": {
    "job_key":"...",
    "company":"...",
    "role_title":"...",
    "location":"...",
    "source_domain":"...",
    "primary_target_id":"...",
    "final_score":72,
    "skills_to_emphasize":["..."],
    "keywords":["..."]
  }
}
```

## API routes

### POST /normalize-job
- Auth: `x-api-key`
- Body: `{ "raw_url":"https://..." }`
- Response: normalized object or `{ignored:true}`.

### POST /resolve-jd
- Auth: `x-api-key`
- Body: `{ "job_url":"https://...", "email_text":"...", "email_html":"..." }`
- Response: `{jd_text_clean,jd_source,fetch_status,debug}`.

### POST /extract-jd
- Auth: `x-api-key`
- Body: `{ "text":"...>=50 chars" }`
- Response: extracted fields JSON.

### POST /score-jd
- Auth: `x-api-key`
- Body: `{ "job":{...}, "targets":[...], "cfg":{...} }`
- Response: `{primary_target_id,score_must,score_nice,final_score,reject_triggered,reason_top_matches}`.

## CORS contract
- Preflight handled for all paths (`OPTIONS` -> `204`).
- Response headers include:
  - `Access-Control-Allow-Origin` = `ALLOW_ORIGIN` if `*` or URL, else fallback `*`
  - `Access-Control-Allow-Methods` = `POST,GET,OPTIONS`
  - `Access-Control-Allow-Headers` = `Content-Type,x-api-key,x-ui-key`
