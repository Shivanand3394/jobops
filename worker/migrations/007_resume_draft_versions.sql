CREATE TABLE IF NOT EXISTS resume_draft_versions (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  source_action TEXT NOT NULL,
  pack_json TEXT NOT NULL,
  ats_json TEXT NOT NULL,
  rr_export_json TEXT NOT NULL,
  controls_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error_text TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resume_draft_versions_job_profile_created
  ON resume_draft_versions(job_key, profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_resume_draft_versions_draft_version
  ON resume_draft_versions(draft_id, version_no DESC);
