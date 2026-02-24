CREATE TABLE IF NOT EXISTS gmail_tokens (
  id TEXT PRIMARY KEY,
  refresh_token_enc TEXT,
  access_token TEXT,
  access_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_state (
  id TEXT PRIMARY KEY,
  last_seen_internal_date INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_ingest_log (
  msg_id TEXT PRIMARY KEY,
  thread_id TEXT,
  internal_date INTEGER,
  subject TEXT,
  from_email TEXT,
  urls_json TEXT,
  job_keys_json TEXT,
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gmail_ingest_internal_date ON gmail_ingest_log(internal_date);
