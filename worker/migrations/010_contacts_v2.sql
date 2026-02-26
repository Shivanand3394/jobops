-- Contacts CRM baseline
-- Sprint F Step 2: contact adapter persistence (dedupe + touchpoint linkage)

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  company_name TEXT,
  linkedin_url TEXT UNIQUE,
  email TEXT UNIQUE,
  confidence INTEGER,
  source TEXT,
  notes TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS contact_touchpoints (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  channel TEXT CHECK(channel IN ('LINKEDIN', 'EMAIL', 'OTHER')),
  status TEXT DEFAULT 'DRAFT',
  content TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (job_key) REFERENCES jobs(job_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_name);
CREATE INDEX IF NOT EXISTS idx_contacts_linkedin ON contacts(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_touchpoints_job ON contact_touchpoints(job_key);
CREATE INDEX IF NOT EXISTS idx_touchpoints_contact ON contact_touchpoints(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_touchpoints_contact_job_channel
  ON contact_touchpoints(contact_id, job_key, channel);
