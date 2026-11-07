import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createFeeLedgerService } from "../lib/fee-ledger.js";

function withLedger(run, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-fees-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  const apps = createAppService(opened.db);
  apps.requestRegistration({ app_id: "fee-app", app_name: "Fee App" });
  apps.approveApp("fee-app");
  const service = createFeeLedgerService({ db: opened.db, mockPaymentsEnabled: true, ...options });
  try { return run({ db: opened.db, service, apps }); }
  finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

function order(service, overrides = {}) {
  return service.createOrder({
    applicationId: "fee-app", idempotencyKey: "client-order-0001", orderReference: "invoice-1",
    amountSubunits: 1250, amountScale: 2, currency: "USD", description: "Test order", provider: "mock",
    metadata: { b: 2, a: 1 }, ...overrides,
  });
}

test("fee orders are tenant-bound, idempotent, and reject idempotency conflicts", () => withLedger(({ service }) => {
  const first = order(service);
  const replay = order(service, { metadata: { a: 1, b: 2 } });
  assert.equal(first.status, "created");
  assert.equal(replay.status, "replayed");
  assert.equal(replay.order.order_id, first.order.order_id);
  assert.throws(() => order(service, { amountSubunits: 1200 }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(service.getOrder({ applicationId: "other-app", orderId: first.order.order_id }), null);
  assert.equal(service.canDeliver({ applicationId: "fee-app", orderId: first.order.order_id }), false);
}));

test("only verified matching provider results can mark an order paid", () => withLedger(({ service }) => {
  const created = order(service);
  service.recordProviderEvent({
    applicationId: "fee-app", orderId: created.order.order_id, provider: "mock",
    externalEventId: "unverified-payment-event", providerReference: "mock-reference-unverified",
    result: "paid", verified: false, amountSubunits: 1250, amountScale: 2, currency: "USD",
  });
  assert.deepEqual(service.reconcile(), [{
    order_id: created.order.order_id, status: "processing", error_code: "PROVIDER_RESULT_UNVERIFIED",
  }]);
  assert.equal(service.canDeliver({ applicationId: "fee-app", orderId: created.order.order_id }), false);

  service.recordProviderEvent({
    applicationId: "fee-app", orderId: created.order.order_id, provider: "mock",
    externalEventId: "verified-payment-event", providerReference: "mock-reference-verified",
    result: "paid", verified: true, amountSubunits: 1250, amountScale: 2, currency: "USD",
  });
  assert.equal(service.reconcile()[0].status, "paid");
  assert.equal(service.canDeliver({ applicationId: "fee-app", orderId: created.order.order_id }), true);
  assert.deepEqual(service.history({ applicationId: "fee-app", orderId: created.order.order_id }).map(({ action }) => action), [
    "order.created", "provider.event_received", "provider.event_rejected", "provider.event_received", "payment.confirmed",
  ]);
  assert.throws(() => service.history({ applicationId: "other-app", orderId: created.order.order_id }), { code: "ORDER_NOT_FOUND" });
}));

test("mock settlements reconcile an order and emit only server-confirmed paid state", () => withLedger(({ service, db }) => {
  const created = order(service);
  const settled = service.mockSettle({ applicationId: "fee-app", orderId: created.order.order_id });
  assert.equal(settled.order.status, "paid");
  assert.equal(settled.order.verification_state, "verified");
  assert.equal(settled.reconciliation.verification_state, "verified");
  assert.equal(service.canDeliver({ applicationId: "fee-app", orderId: created.order.order_id }), true);
  assert.throws(() => service.mockSettle({ applicationId: "fee-app", orderId: created.order.order_id }), { code: "ORDER_TERMINAL" });
  assert.throws(() => db.prepare("UPDATE fee_order_audit SET state='changed'").run(), /append-only/);
}));

test("reconciliation rejects mismatched amounts and reused provider references", () => withLedger(({ service }) => {
  const first = order(service);
  const event = {
    applicationId: "fee-app", orderId: first.order.order_id, provider: "mock",
    externalEventId: "amount-mismatch-event", providerReference: "shared-provider-reference",
    result: "paid", verified: true, amountSubunits: 1251, amountScale: 2, currency: "USD",
  };
  const pending = service.recordProviderEvent(event);
  assert.equal(service.recordProviderEvent(event).event_id, pending.event_id);
  assert.deepEqual(service.reconcile()[0], {
    order_id: first.order.order_id, status: "processing", error_code: "PROVIDER_AMOUNT_MISMATCH",
  });
  const verified = { ...event, externalEventId: "first-valid-event", amountSubunits: 1250 };
  service.recordProviderEvent(verified);
  assert.equal(service.reconcile()[0].status, "paid");

  const second = order(service, { idempotencyKey: "client-order-0002", orderReference: "invoice-2" });
  service.recordProviderEvent({ ...verified, orderId: second.order.order_id, externalEventId: "reference-reuse-event" });
  assert.equal(service.reconcile()[0].error_code, "PROVIDER_REFERENCE_REUSED");
  assert.equal(service.canDeliver({ applicationId: "fee-app", orderId: second.order.order_id }), false);
}));

test("mock payments require explicit enablement", () => withLedger(({ db, service }) => {
  const created = order(service);
  const disabled = createFeeLedgerService({ db });
  assert.throws(() => disabled.mockSettle({ applicationId: "fee-app", orderId: created.order.order_id }), { code: "MOCK_PROVIDER_DISABLED" });
}));
