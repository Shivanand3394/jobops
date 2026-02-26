## Backlog Notes

- Reference baseline shipped on `main`: `41ad8a5` (manual JD + low-quality detection) and `12631ae` (manual JD UI + display title fallback).
- Keep issues below as follow-up hardening/UX work unless marked complete in GitHub.
- Current operational choice: `ALLOW_ORIGIN="*"` to avoid recurring UI fetch failures across domains. Track Issue `CORS tightening` below for staged hardening later.

## Issue: WhatsApp media OCR lands as LINK_ONLY (deferred tuning)

**Status:** Deferred (pipeline wiring complete, quality tuning pending)

**Current state (verified):**
- Inbound WhatsApp media now reaches extractor reliably (media id/url captured, queued, extracted).
- Latest verified media run (`message_id=4ed61109-8a96-4f2a-9321-edd5f29235ac`) returned `WHATSAPP_VONAGE_MEDIA_EXTRACT_INGESTED` with `extracted_text_len=563`.
- Result still downgraded to `status=LINK_ONLY` (`manual_needed=1`, `low_quality=1`) for the created record.

**Goal:**
Reduce false `LINK_ONLY` outcomes for media-only job screenshots/docs where OCR text is usable for scoring.

**Acceptance Criteria:**
- Media-only WhatsApp ingests with usable OCR text should progress to normal scored flow (not `LINK_ONLY` by default).
- Keep deterministic safeguards against junk OCR/noise.
- Maintain event observability for decisions (`ingest_decision`, `signal_hits`, extraction status).

**Notes:**
- Keep this separate from webhook/transport reliability (already fixed).
- Tuning should target quality gates and/or OCR extraction prompt behavior only.

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

## Issue: ALLOW_ORIGIN wildcard rollback plan

**Goal:**
Treat `ALLOW_ORIGIN="*"` as temporary and migrate to pinned origin(s) without breaking UI access.

**Acceptance Criteria:**
- Current runtime using wildcard is documented as temporary risk acceptance.
- Production worker is updated to explicit Pages origin allowlist (at minimum `https://jobops-ui.pages.dev` and active custom UI domain if used).
- Preflight (`OPTIONS`) continues to allow `Content-Type`, `x-ui-key`, `x-api-key`.
- Smoke tests pass for `GET /jobs` and `POST /ingest` from the production UI after tightening.
- Backout procedure is documented (temporary rollback to `*` only during incident).

**Notes:**
Do not tighten until final UI domain is confirmed stable in Pages settings.

## Issue: Reactive Resume profile sync on generate

**Goal:**
When a user generates a resume/application pack, persist the generated RR JSON back to the selected profile as a saved version.

**Acceptance Criteria:**
- `POST /jobs/:job_key/generate-application-pack` (UI key) stores generated `rr_export_json` in `resume_drafts` as today.
- Generation flow also updates the selected profile with a versioned snapshot of generated RR JSON (no destructive overwrite of historical versions).
- UI shows confirmation that profile snapshot was saved with generation timestamp.
- User can still regenerate with different templates without losing prior generated profile snapshots.
- If generation fails, profile snapshot is not partially written.

**Notes:**
Use versioned profile snapshots (append-only strategy preferred) to avoid accidental data loss from iterative generation.

## Risk: Reactive Resume API key exposure and rotation

**Risk statement:**
An RR API key was shared in plaintext during setup/testing. Treat this key as compromised.

**Required actions:**
1. Rotate/revoke the exposed RR key in Reactive Resume immediately.
2. Update Worker secret `RR_KEY` with the newly issued key.
3. Verify bridge health via `GET /resume/rr/health` (UI auth).
4. Confirm no RR key values are present in repo files, docs, or command history snapshots.

**Acceptance criteria:**
- Old key no longer works against RR.
- Worker `RR_KEY` is updated and `/resume/rr/health` returns `ready`.
- This risk remains open until rotation is verified in production.
