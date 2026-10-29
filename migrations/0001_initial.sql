CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  source_host TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  received INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  reserved INTEGER NOT NULL,
  content_type TEXT,
  etag TEXT,
  modified TEXT,
  error TEXT,
  download_token TEXT NOT NULL,
  object_key TEXT NOT NULL,
  upload_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  cleaned_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
