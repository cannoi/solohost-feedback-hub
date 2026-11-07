CREATE TABLE applications (
  application_id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  application_url TEXT NOT NULL DEFAULT '',
  backend_api_url TEXT NOT NULL DEFAULT '',
  integration_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (integration_status IN ('pending', 'approved', 'disabled', 'rejected')),
  allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  enabled_features_json TEXT NOT NULL DEFAULT '[]',
  legacy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE api_credentials (
  credential_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  secret_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_credentials_app_idx ON api_credentials(application_id, revoked_at);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'P2',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  record_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX feedback_app_created_idx ON feedback(application_id, created_at DESC);
CREATE INDEX feedback_app_status_idx ON feedback(application_id, status, created_at DESC);

CREATE TABLE updates (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX updates_app_created_idx ON updates(application_id, created_at DESC);

CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX notices_app_created_idx ON notices(application_id, created_at DESC);

CREATE TABLE payments_legacy (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  created_at TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'legacy_unverified'
    CHECK (verification_state = 'legacy_unverified'),
  record_json TEXT NOT NULL
);
CREATE INDEX legacy_payments_app_created_idx ON payments_legacy(application_id, created_at DESC);
