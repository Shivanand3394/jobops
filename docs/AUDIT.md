# JobOps V2 Audit Report

## 1) North Star requirements (A-H) - Status
- A) Job intake from alerts (URLs / raw email): **Implemented** - `POST /ingest` supports `raw_urls[]` plus `email_text`/`email_html`.
- B) Normalization + dedupe (`job_key`) across sources: **Implemented** - canonicalization + deterministic hash + upsert on `job_key`.
- C) JD resolution + cleaning/window extraction: **Implemented** - fetch/email fallback and low-quality detection are present.
- D) AI extraction + target scoring: **Implemented** - extract/score endpoints, batch score, single rescore, manual JD score path.
- E) Pipeline statuses + timestamps: **Partial** - fields are populated, but status semantics still overlap across flows.
- F) Android-friendly UI workflow: **Partial** - list/filter/detail/status/rescore/manual JD are implemented; Targets UI is still missing.
- G) Git-based deploy (Worker + D1 + Pages): **Implemented** - structure/config support this; operational checklist documented.
- H) Resume integration readiness: **Partial** - resume payload endpoint exists; no external integration yet.

## 2) Evidence map (as-built)
### A) Intake
- Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js) route `POST /ingest`.
- What it does:
  - accepts URL list + optional email fallback text.
  - resolves JD and upserts `jobs` rows.
- Limitations:
  - no dedicated dedupe UX message in UI.

### B) Normalize + dedupe
- Evidence: `normalizeJobUrl_`, `jobs.job_key` PK in [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql).
- What it does:
  - source-aware URL normalization (LinkedIn/IIMJobs/Naukri/generic).
  - dedupe by `ON CONFLICT(job_key) DO UPDATE`.
- Limitations:
  - dedupe reason is not surfaced as a dedicated API field.

### C) JD resolution
- Evidence: `resolveJd_`, `extractJdWindow_`, `extractJdFromEmail_`, `isLowQualityJd_` in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js).
- What it does:
  - fetches HTML and extracts clean JD window.
  - marks low-quality/blocked content.
- Limitations:
  - heuristic tuning may need source-specific refinements.

### D) Extract + score
- Evidence: `/extract-jd`, `/score-jd`, `/score-pending`, `/jobs/:job_key/rescore`, `/jobs/:job_key/manual-jd` in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js).
- What it does:
  - extracts structured fields.
  - scores against targets and reject keywords.
- Limitations:
  - score quality depends on model output stability.

### E) Pipeline tracking
- Evidence: jobs status/timestamp columns in [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql), status update/scoring updates in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js).
- What it does:
  - updates `status`, `system_status`, `last_scored_at`, and status timestamps.
- Limitations:
  - `next_status` often mirrors `status/system_status`.

### F) UI flow
- Evidence: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js), [ui/index.html](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html).
- What it does:
  - ingest, list/search/filter, detail, status update, rescore, manual JD textarea.
  - list uses `display_title` fallback and clickable cards.
- Limitations:
  - no Targets UI entry/CRUD.

### G) Deploy model
- Evidence: [worker/wrangler.jsonc](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc), static `ui/` folder.
- What it does:
  - Worker deploy with D1 binding `DB`, optional AI binding selector.
  - Pages static deploy from `ui`.
- Limitations:
  - production CORS is still `*` unless env var is tightened.

### H) Resume readiness
- Evidence: `/jobs/:job_key/resume-payload` route in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js).
- What it does:
  - emits compact payload for downstream resume tailoring.
- Limitations:
  - no end-to-end Reactive Resume integration.

## 3) Gaps / Risks
1. Targets UI is missing.
- Impact: target tuning still requires API calls.
- Where found: UI files do not call `/targets`.
- Recommended fix: add Targets screen with list/edit flows.

2. Ingest UX lacks clear/dedupe behavior.
- Impact: noisy operator workflow and unclear upsert outcome.
- Where found: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js) `doIngest()`.
- Recommended fix: clear textarea after success and show insert-vs-update counts.

3. Status semantics are loosely coupled.
- Impact: confusing downstream analytics/automation.
- Where found: multiple status writes in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js).
- Recommended fix: centralize status transition logic.

## 4) Security & Auth review
- UI_KEY usage: all UI requests use `api()` helper and send `x-ui-key`.
- API_KEY usage: admin routes (`/normalize-job`, `/resolve-jd`, `/extract-jd`, `/score-jd`) require `x-api-key`.
- API_KEY exposure in UI: no API key usage in `ui/` files.
- CORS:
  - preflight (`OPTIONS`) is handled.
  - `Access-Control-Allow-Origin` is derived from `ALLOW_ORIGIN` with safe fallback to `*`.
  - production should set `ALLOW_ORIGIN=https://getjobs.shivanand-shah94.workers.dev`.

## 5) Data integrity & status model
- `job_key` dedupe: enforced by PK + upsert.
- status vs system_status:
  - `status` drives visible lifecycle (`NEW/SCORED/SHORTLISTED/...`).
  - `system_status` includes pipeline/internal states like `NEEDS_MANUAL_JD`.
- timestamps:
  - `applied_at/rejected_at/archived_at` set by `/jobs/:job_key/status`.
  - `updated_at/last_scored_at` updated in scoring/manual flows.
- target + reject behavior:
  - scoring returns a `primary_target_id`.
  - target reject keywords and inline reject markers can force reject/score=0.

## 6) "Daily usable?" verdict
**Yes, with operational caveats.**
- Core daily workflow works: ingest -> inspect -> manual JD if needed -> rescore/status updates.
- Auth and route contracts are now consistent for UI vs API usage.
- Ingest/manual save now tolerate missing AI binding without hard-failing intake.
- Remaining productivity gap is lack of Targets management in UI.

## 7) Next 5 actions (recommended order)
1. Build Targets UI (list/edit/update) using existing `/targets` routes.
2. Add ingest dedupe UX (`cleared input`, concise result summary, duplicate signal).
3. Consolidate status transition writes behind one helper.
4. Add automated smoke script for auth matrix + manual recovery flow.
5. Pin production `ALLOW_ORIGIN` and add deploy checklist enforcement.
