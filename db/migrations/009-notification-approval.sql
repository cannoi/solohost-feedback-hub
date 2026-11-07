ALTER TABLE notifications ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'published'
  CHECK(workflow_state IN ('draft','approved','published','cancelled'));
ALTER TABLE notifications ADD COLUMN approved_at TEXT;
ALTER TABLE notifications ADD COLUMN approved_by TEXT;
ALTER TABLE notifications ADD COLUMN published_at TEXT;

UPDATE notifications SET published_at=created_at WHERE workflow_state='published';

CREATE TABLE notification_workflow_events (
  event_id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id),
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('platform_admin','app_owner','application','system')),
  actor_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('created','previewed','updated','approved','published','cancelled')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX notification_workflow_history_idx
  ON notification_workflow_events(application_id,notification_id,created_at DESC);
CREATE TRIGGER notification_workflow_events_no_update
  BEFORE UPDATE ON notification_workflow_events BEGIN SELECT RAISE(ABORT, 'notification workflow history is append-only'); END;
CREATE TRIGGER notification_workflow_events_no_delete
  BEFORE DELETE ON notification_workflow_events BEGIN SELECT RAISE(ABORT, 'notification workflow history is append-only'); END;
