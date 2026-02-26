# JobOps V2 Audit Report

## 1) North Star requirements (A-H) - Status
- A) Job intake from alerts (URLs/raw email): **Implemented**.
- B) Normalization + dedupe (`job_key`) across sources: **Implemented**.
- C) JD resolution (fetch/email fallback) + cleaning/window extraction: **Implemented**.
- D) AI extraction + target-based scoring: **Implemented**.
- E) Pipeline tracking/status semantics: **Partial**.
- F) Android-friendly UI for ingest/list/filter/detail/status/rescore/manual JD/targets: **Implemented**.
- G) Git-based deploy model (Worker + D1 + Pages): **Implemented**.
- H) Resume integration readiness: **Partial**.

## 2) Evidence map (as-built)
### A) Intake
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:833) `POST /ingest`.
- What it does:
  - Accepts `raw_urls[]` plus optional `email_text`/`email_html`.
  - Normalizes URL, resolves JD, upserts `jobs`.
- Limitations:
  - Response does not include deterministic per-row `was_existing`.

### B) Normalize + dedupe
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1235) `normalizeJobUrl_`; [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql) `job_key TEXT PRIMARY KEY`.
- What it does:
  - Source-aware canonicalization for LinkedIn/IIMJobs/Naukri/generic URLs.
  - Dedupes through `ON CONFLICT(job_key)` upsert.
- Limitations:
  - Upsert path not exposed as explicit row-level signal.

### C) JD resolution
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1297) `resolveJd_`, [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1359) `isLowQualityJd_`.
- What it does:
  - Fetch + cleanup + extraction-window heuristic.
  - Fallback from fetched page to email content.
- Limitations:
  - Heuristic may still produce false positives/negatives.

### D) Extract + score
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:679) `/extract-jd`, [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:691) `/score-jd`, [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:729) `/score-pending`, [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:342) `/jobs/:job_key/rescore`, [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:198) `/jobs/:job_key/manual-jd`.
- What it does:
  - Structured extraction + score against targets.
  - Reject keyword checks from target + inline marker support.
- Limitations:
  - Model output quality is prompt/model dependent.

### E) Pipeline/status tracking
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1509) `applyStatusTransition_`; writes in ingest/manual/rescore/batch-scoring and status route.
- What it does:
  - Central helper covers ingest/scoring transitions.
  - `status`, `system_status`, `next_status` are written per transition reason.
- Limitations:
  - `/jobs/:job_key/status` updates only lifecycle `status` and timestamp fields; it does not reconcile `system_status`.

### F) UI workflow
- Evidence: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js), [ui/index.html](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html).
- What it does:
  - Jobs flow: ingest/list/filter/detail/status/rescore/manual JD.
  - Targets flow: list/select/edit/save with schema-aware reject-field behavior.
- Limitations:
  - Dedupe notice in UI remains heuristic.

### G) Deploy model
- Evidence: [worker/wrangler.jsonc](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc), static `ui/` for Pages.
- What it does:
  - Worker bound to D1 via `DB`; `ALLOW_ORIGIN` var present.
  - Static Pages-ready UI directory.
- Limitations:
  - `ALLOW_ORIGIN` still defaults to `*` in config; production tightening is manual.

### H) Resume readiness
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:507) `/jobs/:job_key/resume-payload`.
- What it does:
  - Returns compact resume-bridge payload (job metadata + keyword focus).
- Limitations:
  - No direct Reactive Resume API adapter or push endpoint.

## 3) Gaps / Risks
1. Ingest dedupe signaling is heuristic.
- Impact: operator message may miss true update-vs-insert distinction.
- Where found: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:522) `doIngest()`.
- Recommended fix: add `was_existing` boolean per ingest row from Worker.

2. Checklist schema is intentionally guarded when columns are missing.
- Impact: checklist feature is unavailable on baseline schema until migration is applied, but API now fails safely (400) instead of 500.
- Where found: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:467), [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:484), [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1032), [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql).
- Recommended fix: add migration for checklist columns to fully enable checklist endpoints.

3. Status semantics still partially coupled.
- Impact: lifecycle/internal statuses can become confusing in edge/manual override paths.
- Where found: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:161), [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1509).
- Recommended fix: decide canonical behavior when manual status updates should clear or preserve `system_status`.

## 4) Security & Auth review
- UI key usage: all UI requests in [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:38) use `api()` with `x-ui-key`.
- API key usage: admin routes require `x-api-key`; `/score-pending` accepts either key via route mode `either`.
- API key leakage in UI: no `x-api-key` usage in `ui/` code.
- CORS:
  - OPTIONS preflight handled globally.
  - `Access-Control-Allow-Headers` includes `Content-Type,x-api-key,x-ui-key`.
  - origin is `ALLOW_ORIGIN` or safe fallback `*`.

## 5) Data integrity & status model
- Dedupe: `jobs.job_key` PK + `ON CONFLICT(job_key)` upsert in ingest.
- `status`/`system_status`/`next_status`:
  - `status` = lifecycle (NEW, SCORED, SHORTLISTED, APPLIED, REJECTED, ARCHIVED, LINK_ONLY).
  - `system_status` = internal pipeline markers (NEEDS_MANUAL_JD, AI_UNAVAILABLE, or null).
  - `next_status` currently mostly null through transition helper.
- timestamps:
  - `updated_at` widely maintained.
  - `last_scored_at` updated in scoring routes.
  - `applied_at/rejected_at/archived_at` set in explicit status route.

## 6) Daily usable verdict
**Yes, with caveats.**
- Core daily flows work in current code and UI.
- Auth and CORS behavior align with intended model.
- Manual recovery remains available when AI is missing.
- Remaining operational caveats: checklist schema drift and heuristic dedupe messaging.

## 7) Next actions (recommended order)
1. Add deterministic `was_existing` per ingest result row.
2. Resolve checklist schema drift (migration or schema-gated route behavior).
3. Clarify status override policy for `/jobs/:job_key/status` vs `system_status`.
4. Pin `ALLOW_ORIGIN` to Pages origin in production environment.
5. Add CI smoke checks for auth + ingest + manual recovery + targets.
