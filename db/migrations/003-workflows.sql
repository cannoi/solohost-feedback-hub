CREATE TABLE feedback_messages (
  message_id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  author_type TEXT NOT NULL CHECK(author_type IN ('customer','application','admin','system')),
  is_private INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0,1)),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_messages_feedback_idx ON feedback_messages(application_id, feedback_id, created_at);

CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  scheduled_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'application'
);
CREATE INDEX notifications_app_schedule_idx ON notifications(application_id, scheduled_at DESC);

CREATE TABLE notification_recipients (
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id),
  recipient_id TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(notification_id, recipient_id)
);

CREATE TABLE webhook_subscriptions (
  webhook_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  endpoint_url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
CREATE INDEX webhook_subscriptions_app_idx ON webhook_subscriptions(application_id, active);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_events(event_id),
  webhook_id TEXT NOT NULL REFERENCES webhook_subscriptions(webhook_id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  UNIQUE(event_id, webhook_id)
);
CREATE INDEX webhook_delivery_due_idx ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE payment_sessions (
  session_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  idempotency_key TEXT NOT NULL,
  amount_micros INTEGER NOT NULL CHECK(amount_micros > 0),
  memo TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  order_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(application_id, idempotency_key)
);
CREATE TABLE payment_transactions (
  transaction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES payment_sessions(session_id),
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  pi_payment_id TEXT UNIQUE,
  txid TEXT UNIQUE,
  status TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  amount_micros INTEGER NOT NULL CHECK(amount_micros > 0),
  audit_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  audit_id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(application_id),
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_events_app_idx ON audit_events(application_id, created_at DESC);
