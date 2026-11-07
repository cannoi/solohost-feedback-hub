import crypto from "node:crypto";

const fail = (code, message) => Object.assign(new Error(message), { code });

function bounded(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function identifier(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value) ? value : "";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function toOrder(row) {
  return row ? {
    order_id: row.order_id,
    application_id: row.application_id,
    order_reference: row.order_reference,
    amount_subunits: row.amount_subunits,
    amount_scale: row.amount_scale,
    currency: row.currency,
    description: row.description,
    provider: row.provider,
    status: row.status,
    verification_state: row.verification_state,
    provider_reference: row.provider_reference,
    metadata: JSON.parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at,
    reconciled_at: row.reconciled_at,
  } : null;
}

export function createFeeLedgerService({ db, webhookService, clock = () => new Date(), mockPaymentsEnabled = false } = {}) {
  if (!db) throw new TypeError("db is required");

  function audit({ applicationId, orderId, actorType, action, state, details = {} }) {
    db.prepare("INSERT INTO fee_order_audit(audit_id,application_id,order_id,actor_type,action,state,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(`FOA-${crypto.randomUUID()}`, applicationId, orderId, actorType, action, state, JSON.stringify(details), clock().toISOString());
  }

  function createOrder(input) {
    const applicationId = bounded(input.applicationId, 64);
    const idempotencyKey = identifier(input.idempotencyKey, 8, 128);
    const orderReference = bounded(input.orderReference, 128);
    const description = bounded(input.description, 500);
    const currency = bounded(input.currency, 12).toUpperCase();
    const provider = bounded(input.provider || "mock", 32).toLowerCase();
    const amountSubunits = input.amountSubunits;
    const amountScale = input.amountScale;
    const metadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {};
    let metadataJson;
    try { metadataJson = canonicalJson(metadata); JSON.parse(metadataJson); } catch { throw fail("INVALID_ORDER", "Order metadata is invalid"); }
    if (!applicationId || !idempotencyKey || !/^[A-Z]{2,12}$/.test(currency) ||
      !/^[a-z][a-z0-9_-]{1,31}$/.test(provider) || !Number.isSafeInteger(amountSubunits) || amountSubunits <= 0 ||
      !Number.isInteger(amountScale) || amountScale < 0 || amountScale > 7 || Buffer.byteLength(metadataJson) > 16 * 1024) {
      throw fail("INVALID_ORDER", "Order amount, currency, provider, metadata, or idempotency key is invalid");
    }
    const app = db.prepare("SELECT integration_status FROM applications WHERE application_id=?").get(applicationId);
    if (!app || app.integration_status !== "approved") throw fail("APP_NOT_APPROVED", "An approved application is required");
    const now = clock().toISOString(), orderId = `FO-${crypto.randomUUID()}`;
    return transaction(db, () => {
      const existing = db.prepare("SELECT * FROM fee_orders WHERE application_id=? AND idempotency_key=?").get(applicationId, idempotencyKey);
      if (existing) {
        const same = existing.order_reference === orderReference && existing.amount_subunits === amountSubunits &&
          existing.amount_scale === amountScale && existing.currency === currency && existing.description === description &&
          existing.provider === provider && existing.metadata_json === metadataJson;
        if (!same) throw fail("IDEMPOTENCY_CONFLICT", "Idempotency key is already used for a different order");
        return { order: toOrder(existing), status: "replayed" };
      }
      db.prepare(`INSERT INTO fee_orders(order_id,application_id,idempotency_key,order_reference,amount_subunits,amount_scale,currency,description,provider,status,verification_state,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending','unverified',?,?,?)`)
        .run(orderId, applicationId, idempotencyKey, orderReference, amountSubunits, amountScale, currency, description, provider, metadataJson, now, now);
      audit({ applicationId, orderId, actorType: "application", action: "order.created", state: "pending", details: { provider, currency, amount_subunits: amountSubunits, amount_scale: amountScale } });
      webhookService?.enqueueEventInTransaction({ applicationId, eventType: "payment.created", payload: { order_id: orderId, order_reference: orderReference, amount_subunits: amountSubunits, amount_scale: amountScale, currency, provider, status: "pending", verification_state: "unverified" } });
      return { order: toOrder(db.prepare("SELECT * FROM fee_orders WHERE order_id=?").get(orderId)), status: "created" };
    });
  }

  function recordProviderEvent(input) {
    const applicationId = bounded(input.applicationId, 64), orderId = bounded(input.orderId, 80);
    const provider = bounded(input.provider, 32).toLowerCase(), externalEventId = identifier(input.externalEventId, 1, 128);
    const providerReference = input.providerReference == null ? "" : identifier(input.providerReference, 1, 256);
    const result = input.result, verified = input.verified === true ? 1 : 0;
    const amountSubunits = input.amountSubunits, amountScale = input.amountScale;
    const currency = bounded(input.currency, 12).toUpperCase();
    if (!applicationId || !/^FO-[A-Za-z0-9-]{36}$/.test(orderId) || !/^[a-z][a-z0-9_-]{1,31}$/.test(provider) ||
      !externalEventId || (input.providerReference != null && !providerReference) || !["paid", "failed"].includes(result) ||
      (verified && result === "paid" && !providerReference) ||
      !Number.isSafeInteger(amountSubunits) || amountSubunits <= 0 || !Number.isInteger(amountScale) || amountScale < 0 || amountScale > 7 || !/^[A-Z]{2,12}$/.test(currency)) {
      throw fail("INVALID_PROVIDER_EVENT", "Provider event fields are invalid");
    }
    return transaction(db, () => {
      const order = db.prepare("SELECT * FROM fee_orders WHERE application_id=? AND order_id=?").get(applicationId, orderId);
      if (!order) throw fail("ORDER_NOT_FOUND", "Order was not found");
      if (order.provider !== provider) throw fail("PROVIDER_MISMATCH", "Payment provider does not match the order");
      const existing = db.prepare("SELECT * FROM fee_provider_events WHERE application_id=? AND provider=? AND external_event_id=?").get(applicationId, provider, externalEventId);
      if (existing) {
        const same = existing.order_id === orderId && existing.result === result && existing.verified === verified &&
          existing.amount_subunits === amountSubunits && existing.amount_scale === amountScale && existing.currency === currency &&
          existing.provider_reference === (providerReference || null);
        if (!same) throw fail("PROVIDER_EVENT_CONFLICT", "Provider event ID is already bound to different data");
        return { event_id: existing.event_id, status: existing.processed_at ? "replayed" : "pending" };
      }
      const eventId = `FPE-${crypto.randomUUID()}`;
      const now = clock().toISOString();
      db.prepare(`INSERT INTO fee_provider_events(event_id,application_id,order_id,provider,external_event_id,provider_reference,result,verified,amount_subunits,amount_scale,currency,received_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(eventId, applicationId, orderId, provider, externalEventId, providerReference || null, result, verified, amountSubunits, amountScale, currency, now);
      if (order.status === "pending") db.prepare("UPDATE fee_orders SET status='processing',updated_at=? WHERE application_id=? AND order_id=?").run(now, applicationId, orderId);
      audit({ applicationId, orderId, actorType: "provider", action: "provider.event_received", state: "processing", details: { provider, external_event_id: externalEventId, result } });
      return { event_id: eventId, status: "pending" };
    });
  }

  function mockSettle({ applicationId, orderId, result = "paid" }) {
    if (!mockPaymentsEnabled) throw fail("MOCK_PROVIDER_DISABLED", "Mock payment settlement is disabled");
    if (!["paid", "failed"].includes(result)) throw fail("INVALID_PROVIDER_EVENT", "Mock result is invalid");
    const order = db.prepare("SELECT * FROM fee_orders WHERE application_id=? AND order_id=? AND provider='mock'").get(applicationId, orderId);
    if (!order) throw fail("ORDER_NOT_FOUND", "Mock order was not found");
    if (!["pending", "processing"].includes(order.status)) throw fail("ORDER_TERMINAL", "Order is already in a terminal state");
    const providerReference = `mock_pay_${crypto.randomUUID()}`;
    const receipt = recordProviderEvent({
      applicationId, orderId, provider: "mock", externalEventId: `mock_evt_${crypto.randomUUID()}`,
      providerReference, result, verified: true, amountSubunits: order.amount_subunits,
      amountScale: order.amount_scale, currency: order.currency,
    });
    const reconciled = reconcile({ eventId: receipt.event_id });
    return { ...receipt, reconciliation: reconciled[0] || null, order: getOrder({ applicationId, orderId }) };
  }

  function reconcile({ limit = 50, eventId = null } = {}) {
    const events = db.prepare("SELECT * FROM fee_provider_events WHERE processed_at IS NULL AND (? IS NULL OR event_id=?) ORDER BY received_at,event_id LIMIT ?")
      .all(eventId, eventId, Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50))));
    const outcomes = [];
    for (const event of events) {
      const outcome = transaction(db, () => {
        const current = db.prepare("SELECT * FROM fee_orders WHERE application_id=? AND order_id=?").get(event.application_id, event.order_id);
        const now = clock().toISOString();
        let errorCode = null;
        if (!current || current.provider !== event.provider || current.amount_subunits !== event.amount_subunits ||
          current.amount_scale !== event.amount_scale || current.currency !== event.currency) errorCode = "PROVIDER_AMOUNT_MISMATCH";
        else if (event.verified !== 1) errorCode = "PROVIDER_RESULT_UNVERIFIED";
        else if (!["pending", "processing"].includes(current.status)) errorCode = "ORDER_ALREADY_TERMINAL";
        else if (event.provider_reference && db.prepare("SELECT 1 FROM fee_orders WHERE application_id=? AND provider=? AND provider_reference=? AND order_id<>?").get(event.application_id, event.provider, event.provider_reference, event.order_id)) errorCode = "PROVIDER_REFERENCE_REUSED";
        if (errorCode) {
          db.prepare("UPDATE fee_provider_events SET processed_at=?,error_code=? WHERE event_id=? AND processed_at IS NULL").run(now, errorCode, event.event_id);
          audit({ applicationId: event.application_id, orderId: event.order_id, actorType: "system", action: "provider.event_rejected", state: current?.status || "missing", details: { error_code: errorCode } });
          return { order_id: event.order_id, status: current?.status || "missing", error_code: errorCode };
        }
        const paid = event.result === "paid";
        const state = paid ? "paid" : "failed";
        db.prepare("UPDATE fee_orders SET status=?,verification_state='verified',provider_reference=?,updated_at=?,paid_at=?,reconciled_at=? WHERE application_id=? AND order_id=? AND status IN ('pending','processing')")
          .run(state, event.provider_reference, now, paid ? now : null, now, event.application_id, event.order_id);
        db.prepare("UPDATE fee_provider_events SET processed_at=? WHERE event_id=? AND processed_at IS NULL").run(now, event.event_id);
        audit({ applicationId: event.application_id, orderId: event.order_id, actorType: "system", action: paid ? "payment.confirmed" : "payment.failed", state, details: { provider: event.provider, provider_reference: event.provider_reference, verification_state: "verified" } });
        webhookService?.enqueueEventInTransaction({ applicationId: event.application_id, eventType: paid ? "payment.completed" : "payment.failed", payload: { order_id: event.order_id, order_reference: current.order_reference, provider: event.provider, provider_reference: event.provider_reference, status: state, verification_state: "verified" } });
        return { order_id: event.order_id, status: state, verification_state: "verified" };
      });
      outcomes.push(outcome);
    }
    return outcomes;
  }

  function getOrder({ applicationId, orderId }) {
    return toOrder(db.prepare("SELECT * FROM fee_orders WHERE application_id=? AND order_id=?").get(applicationId, orderId));
  }

  function listOrders({ applicationId, limit = 100 }) {
    return db.prepare("SELECT * FROM fee_orders WHERE application_id=? ORDER BY created_at DESC LIMIT ?")
      .all(applicationId, Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)))).map(toOrder);
  }

  function history({ applicationId, orderId }) {
    if (!getOrder({ applicationId, orderId })) throw fail("ORDER_NOT_FOUND", "Order was not found");
    return db.prepare("SELECT actor_type,action,state,details_json,created_at FROM fee_order_audit WHERE application_id=? AND order_id=? ORDER BY rowid")
      .all(applicationId, orderId).map((event) => ({ ...event, details: JSON.parse(event.details_json) }));
  }

  function canDeliver({ applicationId, orderId }) {
    const order = db.prepare("SELECT status,verification_state FROM fee_orders WHERE application_id=? AND order_id=?").get(applicationId, orderId);
    return order?.status === "paid" && order.verification_state === "verified";
  }

  function providerEvents({ applicationId, orderId }) {
    return db.prepare("SELECT event_id,provider,external_event_id,result,verified,received_at,processed_at,error_code FROM fee_provider_events WHERE application_id=? AND order_id=? ORDER BY received_at,event_id")
      .all(applicationId, orderId).map((event) => ({ ...event, verified: Boolean(event.verified) }));
  }

  return Object.freeze({ createOrder, recordProviderEvent, mockSettle, reconcile, getOrder, listOrders, history, canDeliver, providerEvents });
}

export function startFeeReconciliationWorker({ service, intervalMs = 5_000, onError = () => {} } = {}) {
  if (!service || typeof service.reconcile !== "function" || intervalMs < 250) throw new TypeError("A fee ledger service and an interval of at least 250ms are required");
  let stopped = false, running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    try { service.reconcile(); } catch (error) { onError(error?.code || "FEE_RECONCILIATION_FAILED"); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 5));
  };
}
