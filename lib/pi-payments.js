import crypto from "node:crypto";
import { createPiPlatformClient } from "./pi-platform.js";

const nowIso = () => new Date().toISOString();
const fail = (code, message) => Object.assign(new Error(message), { code });
function inTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function paymentDto(dto, paymentId) {
  return dto && typeof dto === "object" && dto.identifier === paymentId && typeof dto.user_uid === "string" &&
    typeof dto.amount === "number" && typeof dto.memo === "string" && dto.metadata && typeof dto.metadata === "object" &&
    !Array.isArray(dto.metadata) && dto.direction === "user_to_app" && dto.status && typeof dto.status === "object";
}

export function createPiPaymentService({ db, secretBox, clientForApp, webhookService, feeLedger, clock = () => new Date() } = {}) {
  if (!db || !secretBox) throw new TypeError("db and secretBox are required");
  const getClient = clientForApp || ((applicationId) => {
    const config = db.prepare("SELECT server_key_ciphertext FROM pi_app_configs WHERE application_id=? AND enabled=1").get(applicationId);
    if (!config) throw fail("PI_NOT_CONFIGURED", "Pi payment is not configured for this application");
    return createPiPlatformClient({ apiKey: secretBox.decrypt(config.server_key_ciphertext) });
  });
  function configuration(applicationId) {
    return db.prepare("SELECT application_id,pi_app_id,network,enabled,created_at,updated_at FROM pi_app_configs WHERE application_id=?").get(applicationId) || null;
  }
  function configure({ applicationId, piAppId, serverApiKey, network }) {
    const app = db.prepare("SELECT integration_status FROM applications WHERE application_id=?").get(applicationId);
    if (!app || app.integration_status !== "approved") throw fail("APP_NOT_APPROVED", "Application must be approved before Pi payment configuration");
    if (typeof piAppId !== "string" || !/^[A-Za-z0-9._-]{3,128}$/.test(piAppId) || typeof serverApiKey !== "string" || serverApiKey.length < 8 || serverApiKey.length > 2048 || !["testnet", "mainnet"].includes(network)) throw fail("INVALID_PI_CONFIG", "Pi application configuration is invalid");
    const now = clock().toISOString();
    const ciphertext = secretBox.encrypt(serverApiKey);
    db.prepare(`INSERT INTO pi_app_configs(application_id,pi_app_id,network,server_key_ciphertext,enabled,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?) ON CONFLICT(application_id) DO UPDATE SET pi_app_id=excluded.pi_app_id,network=excluded.network,server_key_ciphertext=excluded.server_key_ciphertext,enabled=1,updated_at=excluded.updated_at`)
      .run(applicationId, piAppId, network, ciphertext, now, now);
    db.prepare("INSERT INTO audit_events(audit_id,application_id,actor_type,action,subject_id,details_json,created_at) VALUES(?,?,'owner','pi.configured',?,'{}',?)")
      .run(crypto.randomUUID(), applicationId, applicationId, now);
    return configuration(applicationId);
  }
  function sessionFor(applicationId, sessionId) {
    const session = db.prepare("SELECT * FROM payment_sessions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
    if (!session) throw fail("PAYMENT_SESSION_NOT_FOUND", "Payment session was not found");
    const config = db.prepare("SELECT enabled,network FROM pi_app_configs WHERE application_id=?").get(applicationId);
    if (!config?.enabled) throw fail("PI_NOT_CONFIGURED", "Pi payment is not configured for this application");
    session.pi_network = config.network === "testnet" ? "Pi Testnet" : "Pi Network";
    return session;
  }
  function validate(dto, session, paymentId, userUid, { allowCancelled = false } = {}) {
    const expectedMetadata = JSON.parse(session.metadata_json || "{}");
    expectedMetadata.hub_session_id = session.session_id;
    if (session.fee_order_id) expectedMetadata.fee_order_id = session.fee_order_id;
    if (!paymentDto(dto, paymentId) || dto.user_uid !== userUid || dto.network !== session.pi_network || Math.round(dto.amount * 10_000_000) !== session.amount_micros || dto.memo !== session.memo || Object.keys(dto.metadata).length !== Object.keys(expectedMetadata).length || Object.entries(expectedMetadata).some(([key, value]) => JSON.stringify(dto.metadata[key]) !== JSON.stringify(value)) || (!allowCancelled && (dto.status.cancelled || dto.status.user_cancelled))) {
      throw fail("PI_PAYMENT_MISMATCH", "Pi payment details do not match the authorized Hub session");
    }
    return dto;
  }
  function audit(applicationId, sessionId, paymentId, action, state, details = {}) {
    db.prepare("INSERT INTO pi_payment_audit(audit_id,application_id,session_id,pi_payment_id,action,state,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), applicationId, sessionId, paymentId, action, state, JSON.stringify(details), clock().toISOString());
  }
  function recordFeePayment({ applicationId, sessionId, paymentId, txid, amountMicros }) {
    const session = db.prepare("SELECT fee_order_id FROM payment_sessions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
    if (!session?.fee_order_id) return;
    if (!feeLedger) throw fail("FEE_LEDGER_DISABLED", "Fee ledger is required for this Pi order");
    const receipt = feeLedger.recordProviderEvent({
      applicationId, orderId: session.fee_order_id, provider: "pi",
      externalEventId: `pi_${crypto.createHash("sha256").update(paymentId).digest("hex")}`,
      providerReference: txid, result: "paid", verified: true,
      amountSubunits: amountMicros, amountScale: 7, currency: "PI",
    });
    feeLedger.reconcile({ eventId: receipt.event_id });
    if (!feeLedger.canDeliver({ applicationId, orderId: session.fee_order_id })) throw fail("FEE_ORDER_NOT_PAID", "Pi payment completed but the linked fee order is not reconciled");
  }
  function recordFeeFailure({ applicationId, sessionId, paymentId, amountMicros }) {
    const session = db.prepare("SELECT fee_order_id FROM payment_sessions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
    if (!session?.fee_order_id) return;
    if (!feeLedger) throw fail("FEE_LEDGER_DISABLED", "Fee ledger is required for this Pi order");
    const receipt = feeLedger.recordProviderEvent({
      applicationId, orderId: session.fee_order_id, provider: "pi",
      externalEventId: `pi_failed_${crypto.createHash("sha256").update(paymentId).digest("hex")}`,
      result: "failed", verified: true, amountSubunits: amountMicros, amountScale: 7, currency: "PI",
    });
    feeLedger.reconcile({ eventId: receipt.event_id });
  }
  async function approve({ applicationId, sessionId, paymentId, userAccessToken }) {
    const session = sessionFor(applicationId, sessionId);
    if (typeof paymentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) throw fail("INVALID_PAYMENT_ID", "Pi payment identifier is invalid");
    if (typeof userAccessToken !== "string" || userAccessToken.length < 1 || userAccessToken.length > 4096) throw fail("INVALID_USER_TOKEN", "Pi user access token is invalid");
    const client = getClient(applicationId);
    const identity = await client.verifyUser(userAccessToken);
    if (!identity || typeof identity.uid !== "string" || !identity.uid) throw fail("PI_USER_UNVERIFIED", "Pi user identity could not be verified");
    const dto = validate(await client.getPayment(paymentId), session, paymentId, identity.uid);
    const current = db.prepare("SELECT * FROM payment_transactions WHERE session_id=?").get(sessionId);
    if (current && current.application_id !== applicationId) throw fail("PAYMENT_SESSION_NOT_FOUND", "Payment session was not found");
    if (current && current.pi_payment_id !== paymentId) throw fail("PI_PAYMENT_CONFLICT", "A different Pi payment is already bound to this session");
    if (current?.status === "completed") {
      recordFeePayment({ applicationId, sessionId, paymentId, txid: current.txid, amountMicros: current.amount_micros });
      return { session_id: sessionId, payment_id: paymentId, status: "completed", verification_state: "verified" };
    }
    if (current?.pi_user_uid && current.pi_user_uid !== identity.uid) throw fail("PI_PAYMENT_CONFLICT", "Pi user does not match the payment session");
    if (current?.status === "approved" && dto.status.developer_approved) return { session_id: sessionId, payment_id: paymentId, status: "approved", verification_state: "unverified" };
    if (current?.status === "completion_pending") return { session_id: sessionId, payment_id: paymentId, status: "completion_pending", verification_state: current.verification_state };
    const now = clock().toISOString();
    let claim = "claimed";
    inTransaction(db, () => {
      const bound = db.prepare("SELECT * FROM payment_transactions WHERE session_id=?").get(sessionId);
      if (bound && (bound.application_id !== applicationId || bound.pi_payment_id !== paymentId || bound.pi_user_uid && bound.pi_user_uid !== identity.uid)) throw fail("PI_PAYMENT_CONFLICT", "A different Pi payment or user is already bound to this session");
      if (bound?.status === "completed") { claim = "completed"; return; }
      if (bound?.status === "completion_pending") { claim = "completion_pending"; return; }
      if (bound?.status === "approving" && bound.lease_expires_at && bound.lease_expires_at > now) { claim = "approving"; return; }
      if (!bound) db.prepare(`INSERT INTO payment_transactions(transaction_id,session_id,application_id,pi_payment_id,status,verification_state,amount_micros,pi_user_uid,lease_expires_at,audit_json,created_at,updated_at)
        VALUES(?,?,?,?,'approving','unverified',?,?,?,'[]',?,?)`).run(`PT-${crypto.randomUUID()}`, sessionId, applicationId, paymentId, session.amount_micros, identity.uid, new Date(clock().getTime() + 30000).toISOString(), now, now);
      else db.prepare("UPDATE payment_transactions SET status='approving',pi_user_uid=?,lease_expires_at=?,updated_at=? WHERE session_id=? AND application_id=? AND status!='completed'").run(identity.uid, new Date(clock().getTime() + 30000).toISOString(), now, sessionId, applicationId);
      audit(applicationId, sessionId, paymentId, "approval.requested", "approving", { pi_user_uid: identity.uid });
    });
    if (claim === "completed") {
      const completed = db.prepare("SELECT txid,amount_micros FROM payment_transactions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
      recordFeePayment({ applicationId, sessionId, paymentId, txid: completed.txid, amountMicros: completed.amount_micros });
      return { session_id: sessionId, payment_id: paymentId, status: "completed", verification_state: "verified" };
    }
    if (claim !== "claimed") return { session_id: sessionId, payment_id: paymentId, status: claim, verification_state: claim === "completion_pending" ? "verified" : "unverified" };
    let approved = dto;
    if (!dto.status.developer_approved) approved = await client.approvePayment(paymentId);
    if (!paymentDto(approved, paymentId) || !approved.status.developer_approved || approved.status.cancelled || approved.status.user_cancelled) throw fail("PI_APPROVAL_UNCONFIRMED", "Pi Platform did not confirm payment approval");
    const at = clock().toISOString();
    inTransaction(db, () => {
      db.prepare("UPDATE payment_transactions SET status='approved',verification_state='unverified',lease_expires_at=NULL,failure_code=NULL,updated_at=? WHERE session_id=? AND application_id=? AND pi_payment_id=?")
        .run(at, sessionId, applicationId, paymentId);
      db.prepare("UPDATE payment_sessions SET status='approved',updated_at=? WHERE session_id=? AND application_id=?").run(at, sessionId, applicationId);
      audit(applicationId, sessionId, paymentId, "approval.confirmed", "approved", { developer_approved: true });
    });
    return { session_id: sessionId, payment_id: paymentId, status: "approved", verification_state: "unverified" };
  }
  async function complete({ applicationId, sessionId, paymentId, txid }) {
    const session = sessionFor(applicationId, sessionId);
    if (typeof txid !== "string" || !/^[a-fA-F0-9]{16,128}$/.test(txid)) throw fail("INVALID_TXID", "Pi transaction identifier is invalid");
    const transaction = db.prepare("SELECT * FROM payment_transactions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
    if (!transaction || transaction.pi_payment_id !== paymentId) throw fail("PAYMENT_NOT_APPROVED", "Payment has not been approved for this application and session");
    if (transaction.txid && transaction.txid.toLowerCase() !== txid.toLowerCase()) throw fail("PI_PAYMENT_CONFLICT", "Pi transaction identifier conflicts with the recorded transaction");
    if (transaction.status === "completed") {
      recordFeePayment({ applicationId, sessionId, paymentId, txid: transaction.txid, amountMicros: transaction.amount_micros });
      return { session_id: sessionId, payment_id: paymentId, txid: transaction.txid, status: "completed", verification_state: "verified" };
    }
    if (!["approved", "completion_pending"].includes(transaction.status)) throw fail("PAYMENT_NOT_APPROVED", "Payment has not been approved for this application and session");
    if (transaction.status === "completion_pending" && transaction.lease_expires_at && transaction.lease_expires_at > clock().toISOString()) return { session_id: sessionId, payment_id: paymentId, txid: transaction.txid, status: "completion_pending", verification_state: transaction.verification_state };
    const client = getClient(applicationId);
    const dto = validate(await client.getPayment(paymentId), session, paymentId, transaction.pi_user_uid);
    if (!dto.status.developer_approved || dto.status.cancelled || dto.status.user_cancelled || dto.status.transaction_verified !== true || dto.transaction?.verified !== true || dto.transaction?.txid?.toLowerCase() !== txid.toLowerCase()) throw fail("PI_TRANSACTION_UNVERIFIED", "Pi Platform has not authoritatively verified this transaction");
    const now = clock().toISOString();
    let claim = "claimed";
    inTransaction(db, () => {
      const bound = db.prepare("SELECT * FROM payment_transactions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
      if (!bound || bound.pi_payment_id !== paymentId) throw fail("PAYMENT_NOT_APPROVED", "Payment has not been approved for this application and session");
      if (bound.txid && bound.txid.toLowerCase() !== txid.toLowerCase()) throw fail("PI_PAYMENT_CONFLICT", "Pi transaction identifier conflicts with the recorded transaction");
      if (bound.status === "completed") { claim = "completed"; return; }
      if (bound.status === "completion_pending" && bound.lease_expires_at && bound.lease_expires_at > now) { claim = "completion_pending"; return; }
      if (!["approved", "completion_pending"].includes(bound.status)) throw fail("PAYMENT_NOT_APPROVED", "Payment has not been approved for this application and session");
      db.prepare("UPDATE payment_transactions SET status='completion_pending',txid=?,verification_state='verified',lease_expires_at=?,updated_at=? WHERE session_id=? AND application_id=?")
        .run(txid, new Date(clock().getTime() + 30000).toISOString(), now, sessionId, applicationId);
      audit(applicationId, sessionId, paymentId, "completion.requested", "completion_pending", { txid });
      const verifiedEvent = db.prepare("SELECT 1 FROM pi_payment_audit WHERE application_id=? AND session_id=? AND action='verification.confirmed' LIMIT 1").get(applicationId, sessionId);
      if (!verifiedEvent) {
        audit(applicationId, sessionId, paymentId, "verification.confirmed", "verified", { txid });
        webhookService?.enqueueEventInTransaction({ applicationId, eventType: "payment.verified", payload: { session_id: sessionId, payment_id: paymentId, txid, verification_state: "verified" } });
      }
    });
    if (claim === "completed") {
      recordFeePayment({ applicationId, sessionId, paymentId, txid, amountMicros: transaction.amount_micros });
      return { session_id: sessionId, payment_id: paymentId, txid, status: "completed", verification_state: "verified" };
    }
    if (claim === "completion_pending") return { session_id: sessionId, payment_id: paymentId, txid, status: "completion_pending", verification_state: "verified" };
    let completed = dto;
    if (!dto.status.developer_completed) completed = await client.completePayment(paymentId, txid);
    if (!paymentDto(completed, paymentId) || !completed.status.developer_completed || completed.status.transaction_verified !== true || completed.transaction?.verified !== true || completed.transaction?.txid?.toLowerCase() !== txid.toLowerCase()) throw fail("PI_COMPLETION_UNCONFIRMED", "Pi Platform did not confirm payment completion");
    const at = clock().toISOString();
    inTransaction(db, () => {
      db.prepare("UPDATE payment_transactions SET status='completed',verification_state='verified',lease_expires_at=NULL,failure_code=NULL,updated_at=? WHERE application_id=? AND session_id=? AND pi_payment_id=? AND txid=?")
        .run(at, applicationId, sessionId, paymentId, txid);
      db.prepare("UPDATE payment_sessions SET status='completed',updated_at=? WHERE application_id=? AND session_id=?").run(at, applicationId, sessionId);
      audit(applicationId, sessionId, paymentId, "completion.confirmed", "completed", { txid, transaction_verified: true, developer_completed: true });
      webhookService?.enqueueEventInTransaction({ applicationId, eventType: "payment.completed", payload: { session_id: sessionId, payment_id: paymentId, txid, status: "completed", verification_state: "verified" } });
    });
    recordFeePayment({ applicationId, sessionId, paymentId, txid, amountMicros: transaction.amount_micros });
    return { session_id: sessionId, payment_id: paymentId, txid, status: "completed", verification_state: "verified" };
  }
  async function reconcile({ limit = 50 } = {}) {
    const rows = db.prepare("SELECT t.*,s.amount_micros FROM payment_transactions t JOIN payment_sessions s ON s.session_id=t.session_id WHERE t.status IN ('approving','completion_pending') AND (t.lease_expires_at IS NULL OR t.lease_expires_at<=?) ORDER BY t.updated_at LIMIT ?").all(clock().toISOString(), Math.min(Math.max(Number(limit) || 50, 1), 200));
    const results = [];
    for (const row of rows) {
      try {
        const session = sessionFor(row.application_id, row.session_id);
        const client = getClient(row.application_id);
        const dto = validate(await client.getPayment(row.pi_payment_id), session, row.pi_payment_id, row.pi_user_uid, { allowCancelled: true });
        if (dto.status.cancelled || dto.status.user_cancelled) {
          const at = clock().toISOString();
          inTransaction(db, () => {
            db.prepare("UPDATE payment_transactions SET status='failed',failure_code='PI_PAYMENT_CANCELLED',lease_expires_at=NULL,last_reconciled_at=?,updated_at=? WHERE transaction_id=?").run(at, at, row.transaction_id);
            db.prepare("UPDATE payment_sessions SET status='failed',updated_at=? WHERE application_id=? AND session_id=?").run(at, row.application_id, row.session_id);
            audit(row.application_id, row.session_id, row.pi_payment_id, "reconciliation.cancelled", "failed");
          });
          recordFeeFailure({ applicationId: row.application_id, sessionId: row.session_id, paymentId: row.pi_payment_id, amountMicros: row.amount_micros });
          webhookService?.enqueueEvent({ applicationId: row.application_id, eventType: "payment.failed", payload: { session_id: row.session_id, payment_id: row.pi_payment_id, status: "failed", failure_code: "PI_PAYMENT_CANCELLED" } });
          results.push({ session_id: row.session_id, status: "failed" }); continue;
        }
        if (row.status === "approving" && dto.status.developer_approved) {
          const at = clock().toISOString();
          db.prepare("UPDATE payment_transactions SET status='approved',lease_expires_at=NULL,last_reconciled_at=?,updated_at=? WHERE transaction_id=?").run(at, at, row.transaction_id);
          db.prepare("UPDATE payment_sessions SET status='approved',updated_at=? WHERE session_id=?").run(at, row.session_id);
          audit(row.application_id, row.session_id, row.pi_payment_id, "reconciliation.approved", "approved");
          results.push({ session_id: row.session_id, status: "approved" }); continue;
        }
        if (row.status === "completion_pending" && dto.status.developer_completed && dto.status.transaction_verified === true && dto.transaction?.verified === true && dto.transaction?.txid?.toLowerCase() === row.txid?.toLowerCase()) {
          const at = clock().toISOString();
          inTransaction(db, () => {
            db.prepare("UPDATE payment_transactions SET status='completed',verification_state='verified',lease_expires_at=NULL,last_reconciled_at=?,updated_at=? WHERE transaction_id=?").run(at, at, row.transaction_id);
            db.prepare("UPDATE payment_sessions SET status='completed',updated_at=? WHERE session_id=?").run(at, row.session_id);
            audit(row.application_id, row.session_id, row.pi_payment_id, "reconciliation.completed", "completed", { txid: row.txid });
            webhookService?.enqueueEventInTransaction({ applicationId: row.application_id, eventType: "payment.completed", payload: { session_id: row.session_id, payment_id: row.pi_payment_id, txid: row.txid, status: "completed", verification_state: "verified" } });
          });
          results.push({ session_id: row.session_id, status: "completed" }); continue;
        }
        const at = clock().toISOString();
        db.prepare("UPDATE payment_transactions SET lease_expires_at=NULL,last_reconciled_at=?,updated_at=? WHERE transaction_id=?").run(at, at, row.transaction_id);
        results.push({ session_id: row.session_id, status: "pending" });
      } catch (error) {
        const at = clock().toISOString();
        db.prepare("UPDATE payment_transactions SET lease_expires_at=NULL,last_reconciled_at=?,failure_code=?,updated_at=? WHERE transaction_id=?").run(at, /^[A-Z_]{3,64}$/.test(error?.code || "") ? error.code : "PI_PLATFORM_UNAVAILABLE", at, row.transaction_id);
        results.push({ session_id: row.session_id, status: "pending", error_code: error?.code || "PI_PLATFORM_UNAVAILABLE" });
      }
    }
    if (feeLedger) {
      const completed = db.prepare(`SELECT t.application_id,t.session_id,t.pi_payment_id,t.txid,t.amount_micros,s.fee_order_id
        FROM payment_transactions t JOIN payment_sessions s ON s.session_id=t.session_id AND s.application_id=t.application_id
        JOIN fee_orders f ON f.order_id=s.fee_order_id
        WHERE t.status='completed' AND s.fee_order_id IS NOT NULL AND f.status IN ('pending','processing')
        ORDER BY t.updated_at LIMIT ?`).all(Math.min(Math.max(Number(limit) || 50, 1), 200));
      for (const row of completed) {
        try {
          recordFeePayment({ applicationId: row.application_id, sessionId: row.session_id, paymentId: row.pi_payment_id, txid: row.txid, amountMicros: row.amount_micros });
          results.push({ session_id: row.session_id, status: "completed", fee_order_status: "paid" });
        } catch (error) {
          results.push({ session_id: row.session_id, status: "completed", fee_order_status: "pending", error_code: error?.code || "FEE_RECONCILIATION_FAILED" });
        }
      }
    }
    return results;
  }
  function transactionHistory(applicationId, { sessionId } = {}) {
    return sessionId
      ? db.prepare("SELECT transaction_id,session_id,pi_payment_id,txid,status,verification_state,amount_micros,pi_user_uid,failure_code,created_at,updated_at,last_reconciled_at FROM payment_transactions WHERE application_id=? AND session_id=?").all(applicationId, sessionId)
      : db.prepare("SELECT transaction_id,session_id,pi_payment_id,txid,status,verification_state,amount_micros,pi_user_uid,failure_code,created_at,updated_at,last_reconciled_at FROM payment_transactions WHERE application_id=? ORDER BY created_at DESC LIMIT 200").all(applicationId);
  }
  function auditHistory(applicationId, sessionId) {
    return db.prepare("SELECT audit_id,session_id,pi_payment_id,action,state,details_json,created_at FROM pi_payment_audit WHERE application_id=? AND session_id=? ORDER BY created_at,audit_id").all(applicationId, sessionId);
  }
  return Object.freeze({ configure, configuration, approve, complete, reconcile, transactionHistory, auditHistory });
}

export function startPiReconciliationWorker({ service, intervalMs = 60_000, onError = () => {} } = {}) {
  if (!service || typeof service.reconcile !== "function") throw new TypeError("A Pi payment service is required");
  let stopped = false, running = false;
  const timer = setInterval(async () => {
    if (stopped || running) return;
    running = true;
    try { await service.reconcile(); } catch (error) { onError(error?.code || "PI_RECONCILIATION_FAILED"); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 5));
  };
}
