# Alignment Report

## North Star A-H Validation

### A) Intake from alerts (URLs/email)
- Status: **Implemented**
- Evidence:
  - Worker ingest: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:841)
  - UI ingest flow: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:522)
- Gaps:
  - UI dedupe message is still heuristic because API does not return deterministic `was_existing`.

### B) Normalization + dedupe by `job_key`
- Status: **Implemented**
- Evidence:
  - URL normalization hashing: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1258)
  - Upsert on conflict(job_key): [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:898)
  - `job_key` primary key schema: [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql)
- Gaps:
  - No per-row insert-vs-update flag in ingest response.

### C) JD resolution/cleaning/window + low-quality handling
- Status: **Implemented**
- Evidence:
  - Resolver + fallback: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1319)
  - Low-quality detection: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1363)
  - Manual JD endpoint: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:198)
- Gaps:
  - Heuristics remain static and may need tuning from real samples.

### D) AI extraction + scoring against targets
- Status: **Implemented**
- Evidence:
  - Batch score pending: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:729)
  - Single rescore: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:342)
  - Manual JD scoring path: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:241)
  - Admin extract/score APIs: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:679), [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:691)
- Gaps:
  - Score quality is model/prompt dependent.

### E) Pipeline statuses + timestamps
- Status: **Partial**
- Evidence:
  - Status transition helper: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1509)
  - Explicit status updates + lifecycle timestamps: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:161)
- Gaps:
  - Manual status route updates `status` only; policy for `system_status` clearing/preservation is implicit.

### F) Android-friendly UI (jobs + targets)
- Status: **Implemented**
- Evidence:
  - Jobs + Targets tabs: [ui/index.html](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html)
  - Jobs actions and clickable list: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:149)
  - Targets list/edit/save: [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:380)
- Gaps:
  - Checklist UI is not exposed (endpoint exists but no UI form).

### G) Git-based deployment readiness
- Status: **Implemented**
- Evidence:
  - Worker wrangler config: [worker/wrangler.jsonc](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc)
  - Static UI structure for Pages: [ui/index.html](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html), [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js)
- Gaps:
  - Production `ALLOW_ORIGIN` pinning still depends on environment configuration.

### H) Resume integration readiness
- Status: **Partial**
- Evidence:
  - Resume payload route: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:507)
- Gaps:
  - No direct Reactive Resume integration endpoint/workflow.

## Mismatch & Severity
- P0: None found.
- P1:
  1. Ingest dedupe signaling is heuristic (`was_existing` missing).
  2. Checklist columns absent in baseline migration; now guarded at runtime with clear 400 response when unavailable.
- P2:
  1. Root `/` message says "UI authenticated" though route is public.

## Prioritized Fix Plan
1. Add deterministic `was_existing` in `/ingest` results and consume in UI banner.
2. Add migration for checklist columns (`applied_note`,`follow_up_at`,`referral_status`) to fully enable checklist feature.
3. Clarify and document `status/system_status` interaction for manual status changes.
4. Add integration smoke checks in CI for auth matrix and AI-missing recovery.
5. Pin production `ALLOW_ORIGIN` to Pages domain and verify preflight in deploy checklist.

## Critical fixes implemented in this run
- Implemented runtime schema guard for checklist routes:
  - `GET /jobs/:job_key/checklist` and `POST /jobs/:job_key/checklist` now return `400` with clear message when required columns are missing, preventing runtime 500.
  - Evidence: [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:467), [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:480), [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js:1027).
