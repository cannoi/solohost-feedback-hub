import crypto from "node:crypto";
import { normalizeWebhookEndpoint, postWebhook } from "./webhook-security.js";

export const WEBHOOK_EVENT_TYPES = Object.freeze([
  "feedback.created", "feedback.updated", "feedback.replied", "notification.created", "notification.delivered",
  "payment.created", "payment.verified", "payment.completed", "payment.failed", "app.updated",
]);
const MAX_ATTEMPTS = 8;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function cleanCode(error) {
  const code = String(error?.code || "WEBHOOK_DELIVERY_FAILED");
  return /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : "WEBHOOK_DELIVERY_FAILED";
}
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function createWebhookService({ db, secretBox, clock = () => new Date(), resolve }) {
  if (!db || !secretBox) throw new TypeError("db and authenticated encryption secretBox are required");

  async function register({ applicationId, endpoint, events }) {
    if (!Array.isArray(events) || !events.length || events.length > WEBHOOK_EVENT_TYPES.length || events.some((event) => !WEBHOOK_EVENT_TYPES.includes(event))) throw fault("INVALID_WEBHOOK_EVENTS", "Select one or more supported webhook events");
    const normalized = await normalizeWebhookEndpoint(endpoint, { ...(resolve ? { resolve } : {}) });
    const webhookId = `wh_${crypto.randomUUID()}`;
    const secret = `shfh_whsec_${crypto.randomBytes(32).toString("base64url")}`;
    const now = clock().toISOString();
    db.prepare(`INSERT INTO secure_webhook_subscriptions(webhook_id,application_id,endpoint_url,secret_hash,secret_ciphertext,events_json,active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?)`).run(webhookId, applicationId, normalized.url.toString(), crypto.createHash("sha256").update(secret).digest("hex"), secretBox.encrypt(secret), JSON.stringify([...new Set(events)].sort()), now, now);
    return { webhook_id: webhookId, application_id: applicationId, endpoint_url: normalized.url.toString(), events: [...new Set(events)].sort(), active: true, secret, created_at: now };
  }

  function listSubscriptions({ applicationId }) {
    return db.prepare("SELECT webhook_id,application_id,endpoint_url,events_json AS events,active,created_at,updated_at FROM secure_webhook_subscriptions WHERE application_id=? ORDER BY created_at DESC")
      .all(applicationId).map((row) => ({ ...row, events: JSON.parse(row.events), active: Boolean(row.active) }));
  }

  function rotateSecret({ applicationId, webhookId }) {
    const secret = `shfh_whsec_${crypto.randomBytes(32).toString("base64url")}`;
    const now = clock().toISOString();
    const result = db.prepare("UPDATE secure_webhook_subscriptions SET secret_hash=?,secret_ciphertext=?,updated_at=? WHERE webhook_id=? AND application_id=? AND active=1")
      .run(crypto.createHash("sha256").update(secret).digest("hex"), secretBox.encrypt(secret), now, webhookId, applicationId);
    if (!result.changes) throw fault("WEBHOOK_NOT_FOUND", "Webhook subscription was not found");
    return { webhook_id: webhookId, secret, rotated_at: now };
  }

  function disable({ applicationId, webhookId }) {
    const now = clock().toISOString();
    const result = db.prepare("UPDATE secure_webhook_subscriptions SET active=0,updated_at=? WHERE webhook_id=? AND application_id=? AND active=1").run(now, webhookId, applicationId);
    if (!result.changes) throw fault("WEBHOOK_NOT_FOUND", "Webhook subscription was not found");
    db.prepare("UPDATE secure_webhook_deliveries SET status='disabled',lease_expires_at=NULL WHERE webhook_id=? AND application_id=? AND status IN ('pending','processing')").run(webhookId, applicationId);
    return { webhook_id: webhookId, active: false, disabled_at: now };
  }

  function enqueueEventInTransaction({ applicationId, eventType, payload }) {
    if (!WEBHOOK_EVENT_TYPES.includes(eventType)) return null;
    const payloadJson = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(payloadJson) > 128 * 1024) throw fault("WEBHOOK_PAYLOAD_TOO_LARGE", "Webhook payload exceeded limit");
    const eventId = `evt_${crypto.randomUUID()}`;
    const createdAt = clock().toISOString();
    db.prepare("INSERT INTO secure_webhook_events(event_id,application_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)").run(eventId, applicationId, eventType, payloadJson, createdAt);
    const subscriptions = db.prepare("SELECT webhook_id,events_json FROM secure_webhook_subscriptions WHERE application_id=? AND active=1").all(applicationId);
    const addDelivery = db.prepare("INSERT INTO secure_webhook_deliveries(delivery_id,application_id,event_id,webhook_id,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,'pending',0,?,?)");
    for (const subscription of subscriptions) {
      if (JSON.parse(subscription.events_json).includes(eventType)) addDelivery.run(`whd_${crypto.randomUUID()}`, applicationId, eventId, subscription.webhook_id, createdAt, createdAt);
    }
    return eventId;
  }

  function enqueueEvent(input) { return transaction(db, () => enqueueEventInTransaction(input)); }

  function deliveries({ applicationId, limit = 100 }) {
    return db.prepare(`SELECT d.delivery_id,d.application_id,d.event_id,d.webhook_id,d.status,d.attempts,d.next_attempt_at,d.last_status_code,d.last_error_code,d.delivered_at,d.created_at,e.event_type
      FROM secure_webhook_deliveries d JOIN secure_webhook_events e ON e.event_id=d.event_id AND e.application_id=d.application_id
      WHERE d.application_id=? ORDER BY d.created_at DESC LIMIT ?`).all(applicationId, Math.max(1, Math.min(200, Number(limit) || 100)));
  }

  function retryFailed({ applicationId, deliveryId }) {
    const now = clock().toISOString();
    const result = db.prepare(`UPDATE secure_webhook_deliveries SET status='pending',attempts=0,next_attempt_at=?,lease_expires_at=NULL,last_error_code=NULL,last_status_code=NULL
      WHERE delivery_id=? AND application_id=? AND status='failed' AND EXISTS(SELECT 1 FROM secure_webhook_subscriptions s WHERE s.webhook_id=secure_webhook_deliveries.webhook_id AND s.application_id=? AND s.active=1)`)
      .run(now, deliveryId, applicationId, applicationId);
    if (!result.changes) throw fault("WEBHOOK_DELIVERY_NOT_RETRYABLE", "Webhook delivery is not failed or its subscription is disabled");
    return { delivery_id: deliveryId, status: "pending" };
  }

  async function dispatchDue({ deliver = (input) => postWebhook({ ...input, ...(resolve ? { resolve } : {}), clock: () => clock().getTime() }), batchSize = 20 } = {}) {
    const stats = { delivered: 0, retrying: 0, failed: 0, disabled: 0 };
    const size = Math.max(1, Math.min(50, Math.trunc(Number(batchSize) || 20)));
    for (let i = 0; i < size; i += 1) {
      const claim = transaction(db, () => {
        const now = clock().toISOString();
        const row = db.prepare(`SELECT d.delivery_id,d.application_id,d.event_id,d.webhook_id,d.attempts,e.event_type,e.payload_json,e.created_at AS event_created,
          s.endpoint_url,s.secret_ciphertext,s.active
          FROM secure_webhook_deliveries d
          JOIN secure_webhook_events e ON e.event_id=d.event_id AND e.application_id=d.application_id
          JOIN secure_webhook_subscriptions s ON s.webhook_id=d.webhook_id AND s.application_id=d.application_id
          WHERE d.status IN ('pending','processing') AND d.next_attempt_at<=? AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=?)
          ORDER BY d.next_attempt_at,d.delivery_id LIMIT 1`).get(now, now);
        if (!row) return null;
        if (!row.active) {
          db.prepare("UPDATE secure_webhook_deliveries SET status='disabled',lease_expires_at=NULL WHERE delivery_id=?").run(row.delivery_id);
          db.prepare("INSERT INTO secure_webhook_delivery_attempts(attempt_id,application_id,delivery_id,attempt_number,outcome,attempted_at) VALUES(?,?,?,?,'disabled',?)")
            .run(`wha_${crypto.randomUUID()}`, row.application_id, row.delivery_id, row.attempts, now);
          stats.disabled += 1;
          return { skipped: true };
        }
        const attempts = row.attempts + 1;
        db.prepare("UPDATE secure_webhook_deliveries SET status='processing',attempts=?,lease_expires_at=? WHERE delivery_id=?")
          .run(attempts, new Date(clock().getTime() + 30_000).toISOString(), row.delivery_id);
        return { row, attempts };
      });
      if (!claim) break;
      if (claim.skipped) continue;
      const { row, attempts } = claim;
      let statusCode = null;
      let errorCode = null;
      try {
        const secret = secretBox.decrypt(row.secret_ciphertext);
        const event = { id: row.event_id, type: row.event_type, created_at: row.event_created, data: JSON.parse(row.payload_json) };
        const result = await deliver({ endpoint: row.endpoint_url, event, secret });
        statusCode = Number(result?.statusCode) || 0;
        transaction(db, () => {
          const now = clock().toISOString();
          db.prepare("UPDATE secure_webhook_deliveries SET status='delivered',last_status_code=?,last_error_code=NULL,delivered_at=?,lease_expires_at=NULL WHERE delivery_id=? AND status='processing'").run(statusCode, now, row.delivery_id);
          db.prepare("INSERT INTO secure_webhook_delivery_attempts(attempt_id,application_id,delivery_id,attempt_number,outcome,status_code,attempted_at) VALUES(?,?,?,?,'delivered',?,?)")
            .run(`wha_${crypto.randomUUID()}`, row.application_id, row.delivery_id, attempts, statusCode, now);
        });
        stats.delivered += 1;
      } catch (error) {
        errorCode = cleanCode(error);
        statusCode = Number(error?.statusCode) || null;
        transaction(db, () => {
          const now = clock();
          const terminal = attempts >= MAX_ATTEMPTS;
          const outcome = terminal ? "failed" : "retrying";
          const retryAt = new Date(now.getTime() + Math.min(6 * 60 * 60 * 1000, 1000 * 2 ** Math.min(attempts - 1, 12))).toISOString();
          db.prepare("UPDATE secure_webhook_deliveries SET status=?,next_attempt_at=?,lease_expires_at=NULL,last_status_code=?,last_error_code=? WHERE delivery_id=? AND status='processing'")
            .run(terminal ? "failed" : "pending", terminal ? now.toISOString() : retryAt, statusCode, errorCode, row.delivery_id);
          db.prepare("INSERT INTO secure_webhook_delivery_attempts(attempt_id,application_id,delivery_id,attempt_number,outcome,status_code,error_code,attempted_at) VALUES(?,?,?,?,?,?,?,?)")
            .run(`wha_${crypto.randomUUID()}`, row.application_id, row.delivery_id, attempts, outcome, statusCode, errorCode, now.toISOString());
          stats[outcome] += 1;
        });
      }
    }
    return stats;
  }

  return Object.freeze({ register, listSubscriptions, rotateSecret, disable, enqueueEvent, enqueueEventInTransaction, deliveries, retryFailed, dispatchDue });
}

export function startWebhookWorker({ service, intervalMs = 1000, onError = () => {} }) {
  if (!service || intervalMs < 250) throw new TypeError("service and an interval of at least 250ms are required");
  let stopped = false, running = false, current = Promise.resolve();
  const tick = () => {
    if (stopped || running) return current;
    running = true;
    current = service.dispatchDue().catch((error) => onError(String(error?.code || "WEBHOOK_WORKER_FAILED").slice(0, 80))).finally(() => { running = false; });
    return current;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return async () => { stopped = true; clearInterval(timer); await current; };
}
