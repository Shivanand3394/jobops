# JobOps Goal Audit Report

## What we intended
- Cloudflare Worker API + D1 backend + Cloudflare Pages UI for JobOps V2.
- End-to-end pipeline: ingest URL/email context -> resolve JD -> extract -> score vs targets -> status transitions.
- Mobile-friendly UI for ingest, list/filter/search, detail, status updates, rescore, and manual JD recovery.
- Auth split: `x-ui-key` for UI routes, `x-api-key` for admin/AI routes, with safe CORS for Pages.
- Reliability: ingest should still create usable records even if AI binding is unavailable.

## What exists now
- Worker API and route surface are implemented in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js).
- D1 schema for `jobs`, `targets`, `events` exists in [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql).
- Worker bindings config exists in [worker/wrangler.jsonc](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc) with D1 binding `DB`.
- Static UI exists in [ui/index.html](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html), [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js), [ui/styles.css](/c:/Users/dell/Documents/GitHub/jobops/ui/styles.css).
- Manual JD endpoint exists: `POST /jobs/:job_key/manual-jd`.
- Low-quality JD detection exists (`isLowQualityJd_`) and can drive `NEEDS_MANUAL_JD`.
- Server-side fallback title exists (`display_title`) so UI avoids blank/Untitled entries.

## Gaps / regressions
- Targets management is API-only today; UI has no Targets screen/actions even though Worker supports `/targets` read/update routes.
- Ingest UX does not clear URL input after success and does not show explicit dedupe messaging.
- Two rescore buttons (`Rescore NEW+SCORED`, `Rescore (safe)`) currently call the same function/path.
- Status semantics (`status`, `system_status`, `next_status`) are usable but still partially overlapping.

## Risks
- Auth mismatch risk: reduced by central auth helper, but must keep docs/tests aligned whenever routes are added.
- AI dependency risk: reduced for ingest/manual save path, but scoring actions still require AI binding.
- Status semantics risk: analytics or automation can misread transitions if `status/system_status/next_status` continue to overlap.
- CORS risk: `ALLOW_ORIGIN="*"` remains default in `wrangler.jsonc`; production must pin to Pages origin.
- Pages deploy risk: static config drift (wrong output dir/branch/integration) can still delay deployments.

## Next best actions (ordered)
1. Add explicit Targets UI module (list + edit) against existing `/targets` routes.  
   Effort: `M`
2. Improve ingest UX (`clear input`, `dedupe toast`, `rows inserted vs updated` summary).  
   Effort: `S`
3. Normalize status semantics with one helper and table-driven transitions.  
   Effort: `M`
4. Add a Worker integration smoke test script for auth matrix + manual JD lifecycle.  
   Effort: `M`
5. Lock production CORS and add deploy-time checks for `DB` and `AI` bindings.  
   Effort: `S`
