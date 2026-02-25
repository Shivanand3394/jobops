ALTER TABLE resume_drafts ADD COLUMN rr_resume_id TEXT;
ALTER TABLE resume_drafts ADD COLUMN rr_last_pushed_at INTEGER;
ALTER TABLE resume_drafts ADD COLUMN rr_last_push_status TEXT;
ALTER TABLE resume_drafts ADD COLUMN rr_last_push_error TEXT;

CREATE INDEX IF NOT EXISTS idx_resume_drafts_rr_resume_id ON resume_drafts(rr_resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_drafts_rr_last_pushed_at ON resume_drafts(rr_last_pushed_at);
