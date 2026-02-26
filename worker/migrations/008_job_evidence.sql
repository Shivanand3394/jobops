CREATE TABLE IF NOT EXISTS job_evidence (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL,
  requirement_text TEXT NOT NULL,
  requirement_type TEXT NOT NULL,
  evidence_text TEXT,
  evidence_source TEXT NOT NULL,
  confidence_score INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (job_key) REFERENCES jobs(job_key) ON DELETE CASCADE,
  UNIQUE(job_key, requirement_text, requirement_type)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_job_evidence_job_key
  ON job_evidence(job_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_evidence_req
  ON job_evidence(job_key, requirement_type, matched);
