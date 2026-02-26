# North Star Check (JobOps V2)

Scope audited from runtime code:
- [`worker/src/worker.js`](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js)
- [`worker/migrations/001_init.sql`](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql)
- [`worker/wrangler.jsonc`](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc)
- [`ui/index.html`](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html)
- [`ui/app.js`](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js)
- [`ui/styles.css`](/c:/Users/dell/Documents/GitHub/jobops/ui/styles.css)

## A) Intake from alerts (URLs/email)
- Status: **Implemented**
- Evidence:
  - Route `POST /ingest` in `worker/src/worker.js`
  - `raw_urls`, `email_text`, `email_html` handling in ingest body parsing
  - UI ingest action `doIngest()` -> `POST /ingest` in `ui/app.js`
- Gaps:
  - UI does not expose email_text/email_html entry, only URL paste.

## B) Normalization + dedupe by `job_key`
- Status: **Implemented**
- Evidence:
  - `normalizeJobUrl_()` in `worker/src/worker.js`
  - `ON CONFLICT(job_key)` upsert in ingest SQL
  - `jobs.job_key` primary key in `worker/migrations/001_init.sql`
  - Ingest response now includes deterministic `was_existing` + `action`
- Gaps:
  - No explicit conflict reason subtype beyond `action` (sufficient for current UX).

## C) JD resolution + cleaning + low-quality fallback
- Status: **Implemented**
- Evidence:
  - `resolveJd_()`, `extractJdWindow_()`, `cleanJdText_()`, `isLowQualityJd_()` in `worker/src/worker.js`
  - `shouldRequireManualJd_()` drives `NEEDS_MANUAL_JD`/`LINK_ONLY`
  - Manual recovery route `POST /jobs/:job_key/manual-jd`
- Gaps:
  - Heuristics are static and may require tuning from production samples.

## D) AI extraction + scoring against targets
- Status: **Implemented**
- Evidence:
  - `extractJdWithModel_()`, `scoreJobWithModel_()` in `worker/src/worker.js`
  - Routes: `POST /score-pending`, `POST /jobs/:job_key/rescore`, `POST /jobs/:job_key/manual-jd`
  - Target reject keyword blending via `computeTargetReject_()`
- Gaps:
  - No scoring trace payload persisted for model observability/debugging.

## E) Pipeline statuses + timestamps
- Status: **Partial**
- Evidence:
  - Central helper `applyStatusTransition_()` in `worker/src/worker.js`
  - Timestamp writes: `applied_at/rejected_at/archived_at/last_scored_at/updated_at`
- Gaps (impact):
  - `/jobs/:job_key/status` updates lifecycle `status` only and does not explicitly reconcile `system_status`; can cause mixed semantics in edge/manual flows.

## F) Android-friendly UI workflow
- Status: **Implemented**
- Evidence:
  - UI has Jobs + Targets tabs in `ui/index.html`
  - Search/filter/list/detail/status/rescore/manual-JD in `ui/app.js`
  - Deterministic ingest banner + result list via `renderIngestResultBox()`
  - Clickable cards (`.job-card` handlers) and sticky header CSS in `ui/styles.css`
- Gaps:
  - Checklist fields (`applied_note`, `follow_up_at`, `referral_status`) are in backend but not exposed in UI.

## G) Git-based deployment (Worker + D1 + Pages)
- Status: **Implemented**
- Evidence:
  - Worker config in `worker/wrangler.jsonc` (`main`, D1 binding `DB`)
  - Static UI deployable from `ui/` without build step
- Gaps (impact):
  - `ALLOW_ORIGIN` defaults to `*`; production hardening depends on environment settings.

## H) Resume integration readiness
- Status: **Partial**
- Evidence:
  - Route `GET /jobs/:job_key/resume-payload` in `worker/src/worker.js`
- Gaps (impact):
  - No direct Reactive Resume API integration, push sync, or auth mapping yet.

## Current schema reality note
- Baseline migration `001_init.sql` does not include checklist columns.
- Runtime worker guards checklist routes with schema detection (`getJobsSchema_`) to avoid 500s.
- You reported production DB now includes checklist columns; this is consistent with checklist route intent.
