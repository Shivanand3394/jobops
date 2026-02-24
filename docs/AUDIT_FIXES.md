# Critical Fixes Needed

No open critical fixes at this time after current patch set.

## Resolved in this pass

### 1) `/score-pending` auth consistency
- Symptom: route-level comments/behavior diverged from top-level route gating.
- Root cause: duplicated auth checks in different layers.
- Patch applied: centralized auth via `requireAuth_()` in [worker/src/worker.js](/c:/Users/dell/Documents/GitHub/jobops/worker/src/worker.js) and removed contradictory route-level override logic.
- Residual risk: low; keep matrix docs updated when adding routes.

### 2) AI hard dependency blocking intake/manual save
- Symptom: `/ingest` hard-failed without AI binding.
- Root cause: global `needsAI` included `/ingest` and `/manual-jd` paths.
- Patch applied:
  - removed `/ingest` and `/manual-jd` from global required-AI gate.
  - ingest now stores records and marks manual path when AI is unavailable.
  - manual JD endpoint now persists text and returns a clear `saved_only` response when AI is unavailable.
- Residual risk: scoring endpoints still require AI (expected behavior).
