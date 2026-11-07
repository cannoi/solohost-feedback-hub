CREATE TABLE secure_webhook_subscriptions (
  webhook_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  endpoint_url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(webhook_id, application_id)
);
CREATE INDEX secure_webhook_subscriptions_app_idx ON secure_webhook_subscriptions(application_id, active);

CREATE TABLE secure_webhook_events (
  event_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, application_id)
);
CREATE INDEX secure_webhook_events_app_idx ON secure_webhook_events(application_id, created_at DESC);

CREATE TABLE secure_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  event_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed','disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_expires_at TEXT,
  last_status_code INTEGER,
  last_error_code TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(event_id, application_id) REFERENCES secure_webhook_events(event_id, application_id),
  FOREIGN KEY(webhook_id, application_id) REFERENCES secure_webhook_subscriptions(webhook_id, application_id),
  UNIQUE(event_id, webhook_id)
);
CREATE INDEX secure_webhook_due_idx ON secure_webhook_deliveries(status, next_attempt_at, lease_expires_at);
CREATE INDEX secure_webhook_delivery_history_idx ON secure_webhook_deliveries(application_id, created_at DESC);

CREATE TABLE secure_webhook_delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  delivery_id TEXT NOT NULL REFERENCES secure_webhook_deliveries(delivery_id),
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('delivered','retrying','failed','disabled')),
  status_code INTEGER,
  error_code TEXT,
  attempted_at TEXT NOT NULL
);
CREATE INDEX secure_webhook_attempts_history_idx ON secure_webhook_delivery_attempts(application_id, delivery_id, attempted_at DESC);
