ALTER TABLE resume_drafts ADD COLUMN rr_pdf_url TEXT;
ALTER TABLE resume_drafts ADD COLUMN rr_pdf_last_exported_at INTEGER;
ALTER TABLE resume_drafts ADD COLUMN rr_pdf_last_export_status TEXT;
ALTER TABLE resume_drafts ADD COLUMN rr_pdf_last_export_error TEXT;

CREATE INDEX IF NOT EXISTS idx_resume_drafts_rr_pdf_last_exported_at ON resume_drafts(rr_pdf_last_exported_at);
