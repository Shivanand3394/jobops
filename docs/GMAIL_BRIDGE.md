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
- `GMAIL_QUERY` default: `label:JobOps newer_than:14d`
- `GMAIL_MAX_PER_RUN` default: `25`

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
5. Extracts URLs + email bodies.
6. Reuses internal ingest pipeline (same normalize/resolve/manual behavior).
7. Persists ingest log + advances `gmail_state.last_seen_internal_date`.

## 6) Security Notes
- Refresh token is encrypted at rest with AES-GCM using `TOKEN_ENC_KEY`.
- No new external service is introduced; all state is in D1.
- Poll route is not UI-accessible.
