-- Job-level profile preference
-- Option B: Multi-Profile Identity baseline

CREATE TABLE IF NOT EXISTS job_profile_preferences (
  job_key TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (job_key) REFERENCES jobs(job_key) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES resume_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_profile_preferences_profile
  ON job_profile_preferences(profile_id);
