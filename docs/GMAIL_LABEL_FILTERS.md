# Gmail Label + Filter File (JobOps)

Use this file to import recommended Gmail filters for JobOps:

- `docs/gmail_filters_jobops.xml`

## Labels used by filters

- `JobOps/Hot`
- `JobOps/Raw`
- `JobOps/ManualJD`

If labels do not already exist, Gmail usually creates them on filter import.

## Import steps (Gmail UI)

1. Open Gmail.
2. Go to `Settings` -> `See all settings`.
3. Open tab `Filters and Blocked Addresses`.
4. Click `Import filters`.
5. Select file: `docs/gmail_filters_jobops.xml`.
6. Check imported filters and apply.

## Recommended Worker query after labels are active

Once labels are working, set `GMAIL_QUERY` to label-first mode:

`label:JobOps/Raw newer_than:30d`

Optional tighter mode:

`label:JobOps/Hot newer_than:30d`

## Quick validation

1. Send test email with subject `JobOps Filter Test`.
2. Include one supported URL in body:
   - `https://www.linkedin.com/jobs/view/...`
   - `https://www.iimjobs.com/j/...`
   - `https://www.naukri.com/job-listings-...`
3. Confirm one of the `JobOps/*` labels is applied.
4. Run JobOps poll and verify `query_used` and counters.
