ALTER TABLE notifications ADD COLUMN audience TEXT NOT NULL DEFAULT 'selected' CHECK(audience IN ('all','selected'));
ALTER TABLE notifications ADD COLUMN channel TEXT NOT NULL DEFAULT 'in_app' CHECK(channel IN ('in_app','email','telegram'));
ALTER TABLE notifications ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX notifications_app_idempotency_idx ON notifications(application_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE notifications ADD COLUMN cancelled_at TEXT;

ALTER TABLE notification_recipients ADD COLUMN channel TEXT NOT NULL DEFAULT 'in_app' CHECK(channel IN ('in_app','email','telegram'));
ALTER TABLE notification_recipients ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_recipients ADD COLUMN next_attempt_at TEXT;
ALTER TABLE notification_recipients ADD COLUMN lease_expires_at TEXT;
ALTER TABLE notification_recipients ADD COLUMN last_error TEXT;
CREATE UNIQUE INDEX notification_delivery_once_idx ON notification_recipients(notification_id, recipient_id, channel);
CREATE INDEX notification_due_idx ON notification_recipients(delivery_status, next_attempt_at, lease_expires_at);

CREATE TABLE notification_reads (
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id),
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  recipient_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(notification_id, recipient_id)
);
CREATE INDEX notification_reads_user_idx ON notification_reads(application_id, recipient_id, read_at DESC);

CREATE TABLE notification_attempts (
  attempt_id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id),
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  recipient_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('delivered','retrying','failed','expired','cancelled')),
  error_code TEXT,
  attempted_at TEXT NOT NULL
);
CREATE INDEX notification_attempts_history_idx ON notification_attempts(application_id, notification_id, attempted_at DESC);

CREATE TABLE notification_templates (
  template_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  template_key TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(application_id, template_key, locale)
);
