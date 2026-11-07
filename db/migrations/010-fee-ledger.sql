CREATE TABLE fee_orders (
  order_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  idempotency_key TEXT NOT NULL,
  order_reference TEXT NOT NULL DEFAULT '',
  amount_subunits INTEGER NOT NULL CHECK(amount_subunits > 0),
  amount_scale INTEGER NOT NULL CHECK(amount_scale BETWEEN 0 AND 7),
  currency TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','paid','failed','cancelled')),
  verification_state TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_state IN ('unverified','verified')),
  provider_reference TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  reconciled_at TEXT,
  UNIQUE(application_id,idempotency_key)
);
CREATE INDEX fee_orders_app_created_idx ON fee_orders(application_id,created_at DESC);
CREATE INDEX fee_orders_reconcile_idx ON fee_orders(provider,status,updated_at);
CREATE UNIQUE INDEX fee_orders_provider_reference_idx ON fee_orders(application_id,provider,provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE fee_provider_events (
  event_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  order_id TEXT NOT NULL REFERENCES fee_orders(order_id),
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  provider_reference TEXT,
  result TEXT NOT NULL CHECK(result IN ('paid','failed')),
  verified INTEGER NOT NULL CHECK(verified IN (0,1)),
  amount_subunits INTEGER NOT NULL,
  amount_scale INTEGER NOT NULL,
  currency TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT,
  UNIQUE(application_id,provider,external_event_id)
);
CREATE INDEX fee_provider_events_pending_idx ON fee_provider_events(processed_at,received_at);

CREATE TABLE fee_order_audit (
  audit_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  order_id TEXT NOT NULL REFERENCES fee_orders(order_id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('application','provider','platform_admin','system')),
  action TEXT NOT NULL,
  state TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX fee_order_audit_history_idx ON fee_order_audit(application_id,order_id,created_at);
CREATE TRIGGER fee_order_audit_no_update BEFORE UPDATE ON fee_order_audit BEGIN SELECT RAISE(ABORT, 'fee order audit is append-only'); END;
CREATE TRIGGER fee_order_audit_no_delete BEFORE DELETE ON fee_order_audit BEGIN SELECT RAISE(ABORT, 'fee order audit is append-only'); END;
