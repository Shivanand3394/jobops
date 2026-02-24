# Gmail -> JobOps Bridge

This Worker can ingest Gmail job-alert emails and feed them into existing JobOps ingestion/scoring behavior.

## 1) Google Cloud Setup
1. Create or open a Google Cloud project.
2. Enable **Gmail API**.
3. Configure OAuth consent screen.
4. Create OAuth client type **Web application**.
5. Add redirect URI:
   - `https://get-job.shivanand-shah94.workers.dev/gmail/callback`
   - For local Worker domain, add the corresponding `/gmail/callback` URI.

## 2) Worker Secrets and Vars
Required:
- `GMAIL_CLIENT_ID` (var)
- `GMAIL_CLIENT_SECRET` (secret)
- `TOKEN_ENC_KEY` (secret): base64 for exactly 32 raw bytes (AES-256-GCM key)

Optional (defaults in wrangler):
- `GMAIL_QUERY` default: `in:anywhere newer_than:14d (label:JobOps/Hot OR label:JobOps/Raw)`
- `GMAIL_MAX_PER_RUN` default: `25`
- `MAX_JOBS_PER_EMAIL` default: `3`
- `MAX_JOBS_PER_POLL` default: `10`
- `GMAIL_PROMO_FILTER` default: `1` (heuristic + AI promo/ad reject before ingest)

Example secret commands:
```bash
cd worker
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put TOKEN_ENC_KEY
```

## 3) DB Migration
Apply new schema:
```bash
cd worker
wrangler d1 migrations apply jobops-db --remote
```

Migration file:
- [`worker/migrations/002_gmail.sql`](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/002_gmail.sql)

Tables:
- `gmail_tokens`
- `gmail_state`
- `gmail_ingest_log`

## 4) Connect Gmail (OAuth)
1. Call `GET /gmail/auth` with `x-ui-key`.
2. Complete Google consent.
3. Worker callback stores encrypted refresh token in D1.

Routes:
- `GET /gmail/auth` (UI-authenticated)
- `GET /gmail/callback` (state/cookie validated from auth flow; also allows UI key)

## 5) Polling
- Cron runs every 15 minutes from wrangler trigger.
- Manual poll route:
  - `POST /gmail/poll`
  - Allowed for `x-api-key` callers or Cloudflare cron invocation.

Polling behavior:
1. Loads/decrypts refresh token.
2. Refreshes access token if needed.
3. Lists Gmail messages using query + run limit.
4. Skips already ingested messages (`gmail_ingest_log.msg_id`).
5. Extracts URLs from text/plain and text/html.
6. Classifies URLs using Worker normalization (same `normalizeJobUrl_` pipeline as `/normalize-job`) so tracking links can still canonicalize to job URLs.
7. Rejects promotional/premium/new-feature/ad emails before ingest:
   - heuristic layer always available
   - AI layer applied when `env.AI` is configured
8. Prioritizes normalized candidates (strict detail pages + concrete job_id first).
9. Applies caps:
   - per email via `MAX_JOBS_PER_EMAIL`
   - per poll via `MAX_JOBS_PER_POLL`
   - optional `/gmail/poll` overrides: `max_jobs_per_email`, `max_jobs_per_poll`
10. Reuses internal ingest pipeline (same normalize/resolve/manual behavior).
11. Persists ingest log + advances `gmail_state.last_seen_internal_date`.

Poll response now includes run-level counters for diagnosis:
- `run_id`, `ts`, `query_used`
- `max_jobs_per_email`, `max_jobs_per_poll`
- `scanned`, `processed`, `skipped_already_ingested`
- `urls_found_total`, `urls_unique_total`, `ignored_domains_count`
- `urls_job_domains_total`, `jobs_kept_total`, `jobs_dropped_due_to_caps_total`
- `skipped_promotional`, `skipped_promotional_heuristic`, `skipped_promotional_ai`
- `ingested_count`, `inserted_count`, `updated_count`, `link_only_count`, `ignored_count`
- Back-compat keys remain (`skipped_existing`, `inserted_or_updated`, `link_only`, `ignored`)

Example response shape:
```json
{
  "ok": true,
  "data": {
    "run_id": "uuid",
    "ts": 1700000000000,
    "query_used": "in:anywhere newer_than:7d",
    "scanned": 12,
    "processed": 4,
    "skipped_already_ingested": 8,
    "skipped_existing": 8,
    "urls_found_total": 10,
    "urls_unique_total": 7,
    "ignored_domains_count": 3,
    "skipped_promotional": 1,
    "skipped_promotional_heuristic": 1,
    "skipped_promotional_ai": 0,
    "ingested_count": 2,
    "inserted_or_updated": 2,
    "inserted_count": 1,
    "updated_count": 1,
    "link_only_count": 1,
    "link_only": 1,
    "ignored_count": 0,
    "ignored": 0
  }
}
```

## 6) Debug flow for `scanned=0`
1. Confirm OAuth/token state:
   - `gmail_tokens` should have one row (`id=default`).
2. Use a broad query first:
   - Set `GMAIL_QUERY` to `in:anywhere newer_than:7d`.
   - Or send one-off override in poll body:
     - `{"query":"in:anywhere newer_than:7d","max_per_run":50}`
3. Run `POST /gmail/poll`.
4. Inspect counters:
   - `scanned`: Gmail list returned message IDs.
   - `skipped_already_ingested`: dedupe skipped by `msg_id`.
   - `urls_found_total` / `ignored_domains_count`: extraction vs unsupported domains.
   - `ingested_count` + inserted/updated/link_only/ignored counts: ingest outcomes.
   - `urls_job_domains_total`: canonical job candidates kept after normalization.
   - `ignored_domains_count`: rejected by normalization (`ignored=true`) or unsupported link.

Test-email path (deterministic):
1. Send yourself an email with subject `JobOps Test 1`.
2. Put one supported job URL on its own line in body.
3. Temporarily set query:
   - `in:anywhere newer_than:2d subject:"JobOps Test 1"`
   - Or call poll with override body:
     - `{"query":"in:anywhere newer_than:2d subject:\"JobOps Test 1\"","max_per_run":20}`
4. Run `POST /gmail/poll` and verify:
   - `scanned > 0`
   - `processed > 0`
   - `urls_found_total > 0`
   - job appears in `GET /jobs`.

## 7) Security Notes
- Refresh token is encrypted at rest with AES-GCM using `TOKEN_ENC_KEY`.
- No new external service is introduced; all state is in D1.
- Poll route is not UI-accessible.
