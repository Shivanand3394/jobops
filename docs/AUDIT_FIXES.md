# Critical Fixes Needed

No P0 issues were found in current `main` during this verification pass.

## P1 issues to address next

### 1) Checklist schema drift
- Symptom: checklist columns are absent on baseline DB.
- Root cause: `001_init.sql` does not include `applied_note`, `follow_up_at`, `referral_status`.
- Current protection in code: worker now checks schema and returns clear `400 Checklist fields not enabled in DB schema` for checklist routes instead of runtime 500.
- Remaining action: add a forward migration with these columns to enable checklist functionality everywhere.

### 2) Ingest dedupe signal is non-deterministic
- Symptom: UI dedupe message relies on repeated keys heuristic.
- Root cause: ingest response does not return per-row `was_existing`.
- Minimal patch suggestion:
  - In `/ingest`, detect insert vs update from D1 result and return `was_existing` boolean per row.
- Risk if not fixed: operator may misinterpret whether a row was newly created or updated.
