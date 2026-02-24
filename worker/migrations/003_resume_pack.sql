CREATE TABLE IF NOT EXISTS resume_profiles (
  id TEXT PRIMARY KEY,
  name TEXT,
  profile_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_drafts (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  pack_json TEXT NOT NULL,
  ats_json TEXT NOT NULL,
  rr_export_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_key, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_resume_drafts_job_key ON resume_drafts(job_key);
CREATE INDEX IF NOT EXISTS idx_resume_drafts_updated_at ON resume_drafts(updated_at);
