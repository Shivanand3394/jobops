CREATE TABLE IF NOT EXISTS scoring_runs (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL,
  source TEXT NOT NULL,
  final_status TEXT NOT NULL,
  heuristic_passed INTEGER NOT NULL DEFAULT 1,
  heuristic_reasons_json TEXT NOT NULL DEFAULT '[]',
  stage_metrics_json TEXT NOT NULL,
  ai_model TEXT,
  ai_tokens_in INTEGER NOT NULL DEFAULT 0,
  ai_tokens_out INTEGER NOT NULL DEFAULT 0,
  ai_tokens_total INTEGER NOT NULL DEFAULT 0,
  ai_latency_ms INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  final_score INTEGER,
  reject_triggered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_key) REFERENCES jobs(job_key) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scoring_runs_job_key
  ON scoring_runs(job_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scoring_runs_created_at
  ON scoring_runs(created_at DESC);
