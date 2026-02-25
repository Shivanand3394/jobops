ALTER TABLE targets ADD COLUMN rubric_profile TEXT DEFAULT 'auto';

CREATE INDEX IF NOT EXISTS idx_targets_rubric_profile ON targets(rubric_profile);
