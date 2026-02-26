# Next Step Plan

## Decision
Recommended next step: **Option 1 — Deployment reliability hardening**.

### Why this is recommended now
- Core product loop is implemented and usable.
- Highest operational risk is deploy/config drift (Pages delays, CORS/origin settings, bindings/secrets mismatch), which blocks daily use faster than feature gaps.
- This option has high leverage with low code churn.

## Option 1: Deployment reliability hardening (Recommended)

### Tasks
1. Pin production CORS origin.
- Set Worker `ALLOW_ORIGIN` to the exact Pages URL (`https://getjobs.shivanand-shah94.workers.dev`) in production env.
- Keep `*` only in dev.

2. Add explicit deploy verification checklist execution.
- After each deploy, run `/health`, `/jobs` (UI key), `/score-pending` (UI and API key), `/ingest` smoke.
- Record outcomes in a release note template.

3. Stabilize Pages configuration runbook.
- Ensure Pages settings are fixed: branch `main`, Framework `None`, build command empty, output `ui`.
- Add dashboard screenshots/checklist items to internal ops notes if available.

4. Add a minimal config self-check endpoint policy (doc-only now).
- Define a non-public ops check to verify DB/AI bindings and key env presence before release cut.

### Acceptance criteria
- New production deploy completes for both Worker and Pages without manual retries.
- CORS errors from UI drop to zero for standard flows.
- Smoke tests pass from both browser UI and terminal scripts.
- On-call/debug can resolve “Pages not deploying” in under 10 minutes using docs only.

## Option 2: Scoring quality + observability hardening

### Tasks
- Persist AI extraction/scoring diagnostics (`model`, `prompt_version`, confidence/error traces) in `events`.
- Add deterministic reject-reason taxonomy in API responses.
- Add replay script for failed scoring jobs.

### Acceptance criteria
- Can explain each score/reject decision from persisted traces.
- Failed scoring jobs can be replayed without manual SQL edits.

## Option 3: Resume integration readiness (Reactive Resume)

### Tasks
- Define adapter contract from `/jobs/:job_key/resume-payload` to Reactive Resume schema.
- Add endpoint for prefilled resume draft payload generation per job.
- Define auth + mapping strategy for user identity/profile.

### Acceptance criteria
- One-click generation of a resume payload object accepted by target resume pipeline.
- Documented contract test with example payloads.

## 2-week execution slice (for Option 1)
1. Day 1-2: pin CORS, verify secrets/bindings in production.
2. Day 3-4: automate smoke script execution as release gate.
3. Day 5: finalize Pages triage doc and dry-run incident drill.
4. Week 2: add lightweight ops self-check workflow and release template.
