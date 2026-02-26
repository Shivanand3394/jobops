# JobOps V2 Audit (Latest)

## North Star A-H Status
- A) Intake from alerts (URLs/email): Implemented
  - Evidence: `POST /ingest` parses `raw_urls`, `email_text`, `email_html` in `worker/src/worker.js` and UI ingest action in `ui/app.js`.
- B) Normalize + dedupe by `job_key`: Implemented
  - Evidence: `normalizeJobUrl_` + `ON CONFLICT(job_key)` upsert + deterministic ingest result fields `was_existing`/`action` in `worker/src/worker.js`.
- C) JD resolve/clean/low-quality handling: Implemented
  - Evidence: `resolveJd_`, `extractJdWindow_`, `isLowQualityJd_`, `shouldRequireManualJd_`, and manual recovery route `POST /jobs/:job_key/manual-jd` in `worker/src/worker.js`.
- D) AI extract + target scoring: Implemented
  - Evidence: `extractJdWithModel_`, `scoreJobWithModel_`, `/score-pending`, `/jobs/:job_key/rescore`, `/jobs/:job_key/manual-jd` in `worker/src/worker.js`.
- E) Pipeline statuses + timestamps: Partial
  - Evidence: `applyStatusTransition_` central helper exists, but manual status route writes lifecycle status directly and can leave prior `system_status` untouched.
- F) Android-friendly Pages UI: Implemented
  - Evidence: list/search/filter/clickable detail/status/rescore/manual JD/targets in `ui/index.html`, `ui/app.js`, `ui/styles.css`.
- G) Git-based deploy (Worker + D1 + Pages): Implemented
  - Evidence: Worker config in `worker/wrangler.jsonc` and static UI deploy shape in `ui/`.
- H) Optional resume integration readiness: Partial
  - Evidence: `GET /jobs/:job_key/resume-payload` exists in `worker/src/worker.js`; no direct Reactive Resume push pipeline.

## Evidence Map
- Worker entry + auth + CORS + scheduled Gmail poll: `worker/src/worker.js` (`fetch`, `routeModeFor_`, `requireAuth_`, `corsHeaders_`, `scheduled`).
- Gmail OAuth + polling + encrypted token handling: `worker/src/gmail.js` (`buildGmailAuthUrl_`, `handleGmailOAuthCallback_`, `pollGmailAndIngest_`, `encryptSecret_`, `decryptSecret_`).
- D1 baseline schema + Gmail schema: `worker/migrations/001_init.sql`, `worker/migrations/002_gmail.sql`.
- UI interactions: `ui/app.js` (`api`, `doIngest`, `setActive`, `updateStatus`, `rescoreOne`, `rescorePending`, `saveAndRescoreManualJd`, `loadTargets`, `saveActiveTarget`).

## Runtime Contract Check
- Required bindings:
  - `DB` (declared in `worker/wrangler.jsonc`)
  - `AI` binding or `AI_BINDING` var (referenced by `getAi_` in `worker/src/worker.js`)
- Required vars:
  - `ALLOW_ORIGIN`, `GMAIL_CLIENT_ID`, `GMAIL_QUERY`, `GMAIL_MAX_PER_RUN` (declared in `worker/wrangler.jsonc`)
- Required secrets:
  - `UI_KEY`, `API_KEY`, `GMAIL_CLIENT_SECRET`, `TOKEN_ENC_KEY` (runtime references in `worker/src/worker.js` and `worker/src/gmail.js`)
- Cron trigger:
  - Present in `worker/wrangler.jsonc`: `*/15 * * * *`

## D1 Schema Reality
- `jobs` in `001_init.sql` includes scoring/status fields and `reject_keywords_json`.
- `targets` in `001_init.sql` includes `reject_keywords_json`.
- `jobs` in `001_init.sql` does not include `applied_note`, `follow_up_at`, `referral_status`.
- Runtime checklist guard exists (`getJobsSchema_` in `worker/src/worker.js`) so checklist routes fail safely with 400 when those columns are absent.

## UI Capability Check
- Ingest clears input and renders deterministic result summary/list: implemented (`doIngest`, `renderIngestResultBox` in `ui/app.js`).
- List/search/filter + clickable detail: implemented (`renderJobs`, `.job-card` handlers, `setActive` in `ui/app.js`).
- Status updates: implemented (`updateStatus` -> `POST /jobs/:job_key/status`).
- Rescore single + batch pending: implemented (`rescoreOne`, `rescorePending`).
- Manual JD save/rescore: implemented (`saveAndRescoreManualJd`).
- Targets list/edit/save: implemented (`loadTargets`, `setActiveTarget`, `saveActiveTarget`).
- UI auth headers: all UI API calls use `x-ui-key` in `api()`.

## Top 5 Risks
- `ALLOW_ORIGIN` defaults to `*` in config; production may stay overly permissive if not pinned.
- Checklist columns are not in baseline migration; environments can diverge unless a migration is added.
- Gmail OAuth depends on exact callback URI and dashboard vars/secrets; misconfig blocks polling.
- AI binding absence still blocks scoring/rescore routes (ingest is graceful, scoring is not).
- Docs drift risk remains high due many overlapping audit docs.

## Top 5 Next Actions
1. Pin production `ALLOW_ORIGIN` to `https://getjobs.shivanand-shah94.workers.dev`.
2. Add forward migration for checklist columns (`applied_note`, `follow_up_at`, `referral_status`) to remove environment drift.
3. Consolidate docs into one source for runtime contract (`docs/AUDIT_LATEST.md` + `docs/DEPLOYMENT_NEXT.md`).
4. Add post-deploy smoke gate using existing `docs/SMOKE_TESTS.md` commands.
5. Add a non-sensitive ops endpoint or CI check to validate required binding/var names at deploy time.
