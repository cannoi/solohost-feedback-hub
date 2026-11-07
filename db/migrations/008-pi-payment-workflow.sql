CREATE TABLE pi_app_configs (
  application_id TEXT PRIMARY KEY REFERENCES applications(application_id),
  pi_app_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK(network IN ('testnet','mainnet')),
  server_key_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE payment_transactions ADD COLUMN pi_user_uid TEXT;
ALTER TABLE payment_transactions ADD COLUMN failure_code TEXT;
ALTER TABLE payment_transactions ADD COLUMN lease_expires_at TEXT;
ALTER TABLE payment_transactions ADD COLUMN last_reconciled_at TEXT;
CREATE INDEX payment_transactions_reconcile_idx ON payment_transactions(status, updated_at);

CREATE TABLE pi_payment_audit (
  audit_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  session_id TEXT NOT NULL REFERENCES payment_sessions(session_id),
  pi_payment_id TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX pi_payment_audit_session_idx ON pi_payment_audit(application_id, session_id, created_at);
CREATE TRIGGER pi_payment_audit_no_update BEFORE UPDATE ON pi_payment_audit BEGIN SELECT RAISE(ABORT, 'payment audit is append-only'); END;
CREATE TRIGGER pi_payment_audit_no_delete BEFORE DELETE ON pi_payment_audit BEGIN SELECT RAISE(ABORT, 'payment audit is append-only'); END;
