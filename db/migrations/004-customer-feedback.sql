ALTER TABLE feedback ADD COLUMN deleted_at TEXT;
CREATE INDEX feedback_app_deleted_created_idx ON feedback(application_id, deleted_at, created_at DESC);

CREATE TABLE feedback_access_tokens (
  token_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX feedback_access_tokens_lookup_idx ON feedback_access_tokens(token_hash, revoked_at, expires_at);

CREATE TABLE feedback_attachments (
  attachment_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp','application/pdf')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 5242880),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_attachments_feedback_idx ON feedback_attachments(application_id, feedback_id, created_at);
