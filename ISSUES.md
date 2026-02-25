## Backlog Notes

- Reference baseline shipped on `main`: `41ad8a5` (manual JD + low-quality detection) and `12631ae` (manual JD UI + display title fallback).
- Keep issues below as follow-up hardening/UX work unless marked complete in GitHub.
- Current operational choice: `ALLOW_ORIGIN="*"` to avoid recurring UI fetch failures across domains. Track Issue `CORS tightening` below for staged hardening later.

## Issue: Detect low-quality JD fetch and mark NEEDS_MANUAL_JD

**Goal:**
Detect blocked/junk fetched pages (cookie/privacy/enable javascript shells) during ingest and route jobs to manual JD flow.

**Acceptance Criteria:**
- `POST /ingest` inspects fetched text for shell markers (cookie/privacy/enable javascript/captcha).
- If detected, D1 `jobs.fetch_status` is set to `blocked` and `jobs.system_status` is set to `NEEDS_MANUAL_JD`.
- Job is set to `status=LINK_ONLY` for blocked fetch cases.
- AI extraction is skipped when the resolved JD content is low-quality or empty.
- API response clearly indicates blocked/manual-needed outcome for the URL.

**Notes:**
Keep detection deterministic and lightweight; avoid model calls for shell detection.

## Issue: Manual JD endpoint

**Goal:**
Allow users to submit clean JD text manually and trigger normal extract + score pipeline.

**Acceptance Criteria:**
- Add/verify `POST /jobs/:job_key/manual-jd` with `x-ui-key` auth.
- Endpoint accepts `{ jd_text_clean }` and validates minimum useful length.
- D1 updates `jobs.jd_text_clean` and `jobs.jd_source="manual"`.
- Endpoint triggers extraction and scoring (same logic path as automated pipeline).
- D1 updates scoring/status fields (`score_*`, `final_score`, `status`, `system_status`, `last_scored_at`, `updated_at`).
- Response returns updated status/score fields for immediate UI refresh.

**Notes:**
Do not expose `API_KEY` in UI; UI must call with `x-ui-key` only.

## Issue: Prevent Untitled in UI

**Goal:**
Ensure every job row/detail view has a readable title even when `role_title` is missing.

**Acceptance Criteria:**
- Worker list/detail responses provide `display_title` fallback to `(Needs JD)` when `role_title` is null/empty.
- UI list cards and detail header render `display_title` first.
- No empty or untitled labels appear for missing-title jobs.
- D1 data remains unchanged unless explicit extraction/manual update occurs.

**Notes:**
Fallback is presentation-only and should not overwrite source role text.

## Issue: Ingest UX improvements

**Goal:**
Make ingest behavior explicit for success, duplicates, and manual-needed outcomes.

**Acceptance Criteria:**
- After successful ingest, URL input is cleared automatically.
- UI shows duplicate feedback when `job_key` already exists in D1.
- Ingest response includes per-item duplicate/result metadata for display.
- Duplicate URLs do not silently appear as new records.
- UI refreshes list and opens the most relevant ingested item.

**Notes:**
Use `job_key` as dedupe key and keep messaging concise for mobile use.

## Issue: Targets CRUD improvements

**Goal:**
Improve targets management to support reliable scoring configuration.

**Acceptance Criteria:**
- Targets UI supports create/read/update/delete using existing `/targets` routes.
- Must/nice/reject keyword editing is explicit and persisted to D1 target JSON fields.
- Default target selection behavior is documented and visible in UI.
- Optional active toggle is supported if introduced, with D1 persistence and backward compatibility.
- Target updates are reflected in subsequent scoring (`/score-pending`, `/jobs/:job_key/rescore`).

**Notes:**
Prefer minimal schema changes; preserve compatibility with current target table.

## Issue: Rescore consistency

**Goal:**
Standardize single-job and batch rescore behavior with consistent auth and D1 updates.

**Acceptance Criteria:**
- UI uses `x-ui-key` for `POST /score-pending` and `POST /jobs/:job_key/rescore`.
- UI shows clear success/error feedback for both actions.
- Rescore updates D1 consistently (`status`, `system_status`, `final_score`, `last_scored_at`, `updated_at`).
- Error responses are surfaced to user instead of silent failures.
- Batch response includes `picked` and `updated` counts and per-job results.

**Notes:**
Align single-job and batch scoring field updates to avoid drift.

## Issue: CORS tightening

**Goal:**
Restrict production CORS while keeping debug flexibility.

**Acceptance Criteria:**
- Production `ALLOW_ORIGIN` is set to `https://getjobs.shivanand-shah94.workers.dev`.
- `*` is used only in debug/troubleshooting environments.
- Required headers (`Content-Type`, `x-ui-key`, `x-api-key`) remain allowed in preflight.
- Public endpoint (`GET /health`) remains accessible cross-origin as configured.

**Notes:**
Document exact environment values per deployment stage to avoid accidental wildcard rollout.
