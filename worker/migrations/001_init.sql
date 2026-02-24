-- jobs
CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY,
  job_url TEXT,
  job_url_raw TEXT,
  source_domain TEXT,
  job_id TEXT,

  company TEXT,
  role_title TEXT,
  location TEXT,
  work_mode TEXT,
  seniority TEXT,
  experience_years_min INTEGER,
  experience_years_max INTEGER,

  skills_json TEXT,
  must_have_keywords_json TEXT,
  nice_to_have_keywords_json TEXT,
  reject_keywords_json TEXT,

  jd_text_clean TEXT,
  jd_source TEXT,
  fetch_status TEXT,
  fetch_debug_json TEXT,

  primary_target_id TEXT,
  score_must INTEGER,
  score_nice INTEGER,
  final_score INTEGER,
  reject_triggered INTEGER,
  reject_reasons_json TEXT,
  reject_evidence TEXT,
  reason_top_matches TEXT,
  next_status TEXT,
  system_status TEXT,

  status TEXT,
  applied_at INTEGER,
  archived_at INTEGER,
  rejected_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  last_scored_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_domain ON jobs(source_domain);

-- targets
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  name TEXT,
  primary_role TEXT,
  seniority_pref TEXT,
  location_pref TEXT,
  must_keywords_json TEXT,
  nice_keywords_json TEXT,
  reject_keywords_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- events
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_type TEXT,
  job_key TEXT,
  payload_json TEXT,
  ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);