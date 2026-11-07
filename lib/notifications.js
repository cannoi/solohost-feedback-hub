import crypto from "node:crypto";

const CHANNELS = new Set(["in_app", "email", "telegram"]);
const TYPES = new Set(["update", "release", "maintenance", "security", "payment", "order", "feedback", "announcement"]);
const MAX_ATTEMPTS = 8;
const MAX_BATCH = 50;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function bounded(value, max) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function safeCode(error) {
  const code = String(error?.code || "DELIVERY_FAILED");
  return /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : "DELIVERY_FAILED";
}

export function createNotificationService({ db, webhookService, clock = () => new Date() }) {
  function prepare(input) {
    const appId = bounded(input.applicationId, 64);
    const type = bounded(input.type || "announcement", 32), locale = bounded(input.locale || "en", 16);
    const channel = bounded(input.channel || "in_app", 16);
    let title = bounded(input.title, 160), body = bounded(input.body, 4000);
    if (input.templateKey) {
      const key = bounded(input.templateKey, 80), variables = input.variables && typeof input.variables === "object" && !Array.isArray(input.variables) ? input.variables : {};
      const template = db.prepare("SELECT title,body FROM notification_templates WHERE application_id=? AND template_key=? AND locale IN (?, 'en') ORDER BY CASE WHEN locale=? THEN 0 ELSE 1 END LIMIT 1").get(appId, key, locale, locale);
      if (!template) throw fail("NOTIFICATION_TEMPLATE_NOT_FOUND", "Notification template was not found for this application");
      const render = (text) => text.replace(/\{\{([A-Za-z0-9_.-]{1,64})\}\}/g, (_, name) => {
        if (!Object.hasOwn(variables, name) || !["string", "number", "boolean"].includes(typeof variables[name])) throw fail("INVALID_NOTIFICATION_TEMPLATE", `Template variable ${name} is required`);
        return bounded(variables[name], 500);
      });
      title = render(template.title); body = render(template.body);
    }
    if (!db.prepare("SELECT 1 FROM applications WHERE application_id=?").get(appId)) throw fail("APP_NOT_FOUND", "Application was not found");
    const audience = input.audience;
    const recipients = [...new Set((input.recipientIds || []).map((id) => bounded(id, 160)).filter(Boolean))].sort();
    if (!appId || !title || !body || !TYPES.has(type) || !CHANNELS.has(channel)) throw fail("INVALID_NOTIFICATION", "Notification fields are invalid");
    if (!(["all", "selected"].includes(audience)) || (audience === "selected" && (!recipients.length || recipients.length > 1000)) || (audience === "all" && recipients.length)) throw fail("INVALID_RECIPIENTS", "Specify all recipients or 1 to 1,000 selected recipients");
    const scheduledAt = new Date(input.scheduledAt || clock());
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (!Number.isFinite(scheduledAt.getTime()) || (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= scheduledAt))) throw fail("INVALID_SCHEDULE", "Notification schedule is invalid");
    return { appId, type, locale, channel, title, body, audience, recipients, scheduledAt, expiresAt };
  }
  function recordWorkflowEvent({ applicationId, notificationId, actorType = "system", actorId = null, action, details = {} }) {
    db.prepare("INSERT INTO notification_workflow_events(event_id,notification_id,application_id,actor_type,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(`NWE-${crypto.randomUUID()}`, notificationId, applicationId, actorType, actorId, action, JSON.stringify(details), clock().toISOString());
  }
  function saveTemplate({ applicationId, key, locale = "en", title, body }) {
    const appId = bounded(applicationId, 64), templateKey = bounded(key, 80), language = bounded(locale, 16);
    const templateTitle = bounded(title, 160), templateBody = bounded(body, 4000);
    if (!appId || !/^[A-Za-z0-9._-]{2,80}$/.test(templateKey) || !/^[A-Za-z0-9-]{2,16}$/.test(language) || !templateTitle || !templateBody) throw fail("INVALID_NOTIFICATION_TEMPLATE", "Notification template fields are invalid");
    if (!db.prepare("SELECT 1 FROM applications WHERE application_id=?").get(appId)) throw fail("APP_NOT_FOUND", "Application was not found");
    const now = clock().toISOString(), id = `TPL-${appId}-${templateKey}-${language}`;
    db.prepare(`INSERT INTO notification_templates(template_id,application_id,template_key,locale,title,body,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(application_id,template_key,locale) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`)
      .run(id, appId, templateKey, language, templateTitle, templateBody, now);
    return { template_id: id, application_id: appId, key: templateKey, locale: language, title: templateTitle, body: templateBody, updated_at: now };
  }
  function listTemplates({ applicationId }) {
    return db.prepare("SELECT template_id,application_id,template_key AS key,locale,title,body,updated_at FROM notification_templates WHERE application_id=? ORDER BY template_key,locale").all(bounded(applicationId, 64));
  }
  function create(input) {
    const prepared = prepare(input);
    const { appId, type, locale, channel, title, body, audience, recipients, scheduledAt, expiresAt } = prepared;
    const key = bounded(input.idempotencyKey, 128);
    const workflowState = input.workflowState || "draft";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key) || !["draft", "published"].includes(workflowState)) throw fail("INVALID_NOTIFICATION", "Notification workflow or idempotency key is invalid");
    return transaction(db, () => {
      const existing = db.prepare("SELECT * FROM notifications WHERE application_id=? AND idempotency_key=?").get(appId, key);
      if (existing) {
        const priorRecipients = db.prepare("SELECT recipient_id FROM notification_recipients WHERE notification_id=? AND recipient_id<>'*' ORDER BY recipient_id").all(existing.notification_id).map((row) => row.recipient_id);
        const identical = existing.title === title && existing.body === body && existing.notification_type === type && existing.locale === locale && existing.audience === audience && existing.channel === channel && existing.scheduled_at === scheduledAt.toISOString() && existing.expires_at === (expiresAt?.toISOString() || null) && JSON.stringify(priorRecipients) === JSON.stringify(recipients);
        if (!identical) throw fail("IDEMPOTENCY_CONFLICT", "Notification idempotency key is already in use");
        return { notification_id: existing.notification_id, application_id: appId, scheduled_at: existing.scheduled_at, workflow_state: existing.workflow_state, status: "replayed" };
      }
      const now = clock().toISOString();
      const id = `NT-${crypto.randomUUID()}`;
      const publishedAt = workflowState === "published" ? now : null;
      db.prepare(`INSERT INTO notifications(notification_id, application_id, title, body, notification_type, locale, scheduled_at, expires_at, created_at, audience, channel, idempotency_key, workflow_state, published_at, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, appId, title, body, type, locale, scheduledAt.toISOString(), expiresAt?.toISOString() || null, now, audience, channel, key, workflowState, publishedAt, input.createdBy || "application");
      const insert = db.prepare("INSERT INTO notification_recipients(notification_id, recipient_id, channel, delivery_status, next_attempt_at) VALUES(?,?,?,'pending',?)");
      const deliveryRecipients = audience === "all" ? ["*"] : recipients;
      for (const recipient of deliveryRecipients) insert.run(id, recipient, channel, scheduledAt.toISOString());
      recordWorkflowEvent({ applicationId: appId, notificationId: id, actorType: input.actorType || "application", actorId: input.actorId || null, action: "created", details: { workflow_state: workflowState } });
      if (workflowState === "published") webhookService?.enqueueEventInTransaction({ applicationId: appId, eventType: "notification.created", payload: { notification_id: id, type, audience, scheduled_at: scheduledAt.toISOString() } });
      return { notification_id: id, application_id: appId, scheduled_at: scheduledAt.toISOString(), workflow_state: workflowState, status: workflowState === "draft" ? "draft" : scheduledAt > clock() ? "scheduled" : "pending" };
    });
  }

  function preview(input) {
    const prepared = prepare(input);
    return {
      application_id: prepared.appId,
      title: prepared.title,
      body: prepared.body,
      type: prepared.type,
      locale: prepared.locale,
      audience: prepared.audience,
      recipient_count: prepared.audience === "all" ? null : prepared.recipients.length,
      scheduled_at: prepared.scheduledAt.toISOString(),
      expires_at: prepared.expiresAt?.toISOString() || null,
      channel: prepared.channel,
      delivered: false,
    };
  }

  function updateDraft({ applicationId, notificationId, input, actorType = "platform_admin", actorId = null }) {
    const prepared = prepare({ ...input, applicationId });
    return transaction(db, () => {
      const existing = db.prepare("SELECT workflow_state FROM notifications WHERE notification_id=? AND application_id=?").get(notificationId, prepared.appId);
      if (!existing) throw fail("NOTIFICATION_NOT_FOUND", "Notification was not found");
      if (existing.workflow_state !== "draft") throw fail("NOTIFICATION_NOT_EDITABLE", "Only drafts can be edited");
      db.prepare(`UPDATE notifications SET title=?,body=?,notification_type=?,locale=?,scheduled_at=?,expires_at=?,audience=?,channel=? WHERE notification_id=? AND application_id=?`)
        .run(prepared.title, prepared.body, prepared.type, prepared.locale, prepared.scheduledAt.toISOString(), prepared.expiresAt?.toISOString() || null, prepared.audience, prepared.channel, notificationId, prepared.appId);
      db.prepare("DELETE FROM notification_recipients WHERE notification_id=?").run(notificationId);
      const insert = db.prepare("INSERT INTO notification_recipients(notification_id,recipient_id,channel,delivery_status,next_attempt_at) VALUES(?,?,?,'pending',?)");
      for (const recipient of prepared.audience === "all" ? ["*"] : prepared.recipients) insert.run(notificationId, recipient, prepared.channel, prepared.scheduledAt.toISOString());
      recordWorkflowEvent({ applicationId: prepared.appId, notificationId, actorType, actorId, action: "updated" });
      return { notification_id: notificationId, application_id: prepared.appId, workflow_state: "draft", updated_at: clock().toISOString() };
    });
  }

  function previewDraft({ applicationId, notificationId, actorType = "platform_admin", actorId = null }) {
    const row = db.prepare("SELECT notification_id,title,body,notification_type AS type,locale,audience,channel,scheduled_at,expires_at,workflow_state FROM notifications WHERE notification_id=? AND application_id=?").get(notificationId, applicationId);
    if (!row) throw fail("NOTIFICATION_NOT_FOUND", "Notification was not found");
    if (row.workflow_state !== "draft" && row.workflow_state !== "approved") throw fail("NOTIFICATION_NOT_PREVIEWABLE", "Only draft or approved notices can be previewed");
    const recipientCount = db.prepare("SELECT count(*) AS total FROM notification_recipients WHERE notification_id=? AND recipient_id<>'*'").get(notificationId).total;
    recordWorkflowEvent({ applicationId, notificationId, actorType, actorId, action: "previewed" });
    return { ...row, application_id: applicationId, recipient_count: row.audience === "all" ? null : recipientCount, delivered: false };
  }

  function approve({ applicationId, notificationId, actorType = "platform_admin", actorId = null }) {
    return transaction(db, () => {
      const now = clock().toISOString();
      const result = db.prepare("UPDATE notifications SET workflow_state='approved',approved_at=?,approved_by=? WHERE notification_id=? AND application_id=? AND workflow_state='draft' AND cancelled_at IS NULL")
        .run(now, actorId, notificationId, applicationId);
      if (!result.changes) throw fail("NOTIFICATION_NOT_APPROVABLE", "Only an active draft can be approved");
      recordWorkflowEvent({ applicationId, notificationId, actorType, actorId, action: "approved" });
      return { notification_id: notificationId, workflow_state: "approved", approved_at: now };
    });
  }

  function publish({ applicationId, notificationId, actorType = "platform_admin", actorId = null }) {
    return transaction(db, () => {
      const now = clock().toISOString();
      const result = db.prepare("UPDATE notifications SET workflow_state='published',published_at=? WHERE notification_id=? AND application_id=? AND workflow_state='approved' AND cancelled_at IS NULL")
        .run(now, notificationId, applicationId);
      if (!result.changes) throw fail("NOTIFICATION_NOT_PUBLISHABLE", "An approved draft is required before publishing");
      recordWorkflowEvent({ applicationId, notificationId, actorType, actorId, action: "published" });
      webhookService?.enqueueEventInTransaction({ applicationId, eventType: "notification.created", payload: { notification_id: notificationId, status: "published" } });
      return { notification_id: notificationId, workflow_state: "published", published_at: now };
    });
  }

  function history({ applicationId, notificationId }) {
    if (!db.prepare("SELECT 1 FROM notifications WHERE notification_id=? AND application_id=?").get(notificationId, applicationId)) throw fail("NOTIFICATION_NOT_FOUND", "Notification was not found");
    return db.prepare("SELECT actor_type,actor_id,action,details_json,created_at FROM notification_workflow_events WHERE notification_id=? AND application_id=? ORDER BY rowid").all(notificationId, applicationId).map((event) => ({ ...event, details: JSON.parse(event.details_json) }));
  }

  function list({ applicationId, recipientId, limit = 50, unreadOnly = false }) {
    const appId = bounded(applicationId, 64), recipient = bounded(recipientId, 160);
    if (!appId || !recipient || recipient === "*") throw fail("INVALID_RECIPIENT", "recipient_id is required");
    const now = clock().toISOString();
    const unread = unreadOnly ? "AND r.read_at IS NULL" : "";
    const items = db.prepare(`SELECT n.notification_id, n.application_id, n.title, n.body, n.notification_type AS type, n.locale, n.scheduled_at, n.expires_at, n.created_at,
        CASE WHEN r.read_at IS NULL THEN 0 ELSE 1 END AS is_read
      FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id=n.notification_id AND r.application_id=n.application_id AND r.recipient_id=?
      WHERE n.application_id=? AND n.workflow_state='published' AND n.cancelled_at IS NULL AND n.scheduled_at<=? AND (n.expires_at IS NULL OR n.expires_at>?)
        AND (EXISTS(SELECT 1 FROM notification_recipients nr WHERE nr.notification_id=n.notification_id AND nr.delivery_status='delivered' AND (nr.recipient_id=? OR nr.recipient_id='*')))
        ${unread}
      ORDER BY n.scheduled_at DESC, n.notification_id LIMIT ?`).all(recipient, appId, now, now, recipient, Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50))));
    return { items: items.map((item) => ({ ...item, is_read: Boolean(item.is_read) })) };
  }

  function markRead({ applicationId, notificationId, recipientId }) {
    const appId = bounded(applicationId, 64), recipient = bounded(recipientId, 160), now = clock().toISOString();
    const exists = db.prepare(`SELECT 1 FROM notifications n WHERE n.notification_id=? AND n.application_id=? AND n.cancelled_at IS NULL AND n.scheduled_at<=?
      AND (n.expires_at IS NULL OR n.expires_at>?) AND EXISTS(SELECT 1 FROM notification_recipients d WHERE d.notification_id=n.notification_id AND d.delivery_status='delivered' AND (d.recipient_id=? OR d.recipient_id='*'))`).get(notificationId, appId, now, now, recipient);
    if (!exists) throw fail("NOTIFICATION_NOT_FOUND", "Notification was not found");
    db.prepare("INSERT INTO notification_reads(notification_id,application_id,recipient_id,read_at) VALUES(?,?,?,?) ON CONFLICT(notification_id,recipient_id) DO UPDATE SET read_at=excluded.read_at")
      .run(notificationId, appId, recipient, now);
    return { notification_id: notificationId, recipient_id: recipient, read_at: now };
  }

  function cancel({ applicationId, notificationId, actorType = "platform_admin", actorId = null }) {
    return transaction(db, () => {
      const now = clock().toISOString();
      const result = db.prepare("UPDATE notifications SET cancelled_at=?,workflow_state='cancelled' WHERE notification_id=? AND application_id=? AND cancelled_at IS NULL AND workflow_state<>'cancelled'").run(now, notificationId, applicationId);
      if (!result.changes) throw fail("NOTIFICATION_NOT_FOUND", "Notification was not found");
      db.prepare("UPDATE notification_recipients SET delivery_status='cancelled', lease_expires_at=NULL, last_error=NULL WHERE notification_id=? AND delivery_status IN ('pending','processing')").run(notificationId);
      recordWorkflowEvent({ applicationId, notificationId, actorType, actorId, action: "cancelled" });
      return { notification_id: notificationId, cancelled_at: now };
    });
  }

  function retryFailed({ applicationId, notificationId }) {
    const result = db.prepare(`UPDATE notification_recipients SET delivery_status='pending', attempts=0, next_attempt_at=?, lease_expires_at=NULL, last_error=NULL
      WHERE notification_id=? AND delivery_status='failed' AND EXISTS(SELECT 1 FROM notifications n WHERE n.notification_id=? AND n.application_id=? AND n.workflow_state='published' AND n.cancelled_at IS NULL AND (n.expires_at IS NULL OR n.expires_at>?))`)
      .run(clock().toISOString(), notificationId, notificationId, applicationId, clock().toISOString());
    if (!result.changes) throw fail("NO_FAILED_DELIVERIES", "No failed deliveries can be retried");
    return { notification_id: notificationId, queued: result.changes };
  }

  async function dispatchDue({ adapters = {}, batchSize = 20 } = {}) {
    const stats = { delivered: 0, retrying: 0, failed: 0, expired: 0, cancelled: 0 };
    const batch = Math.min(MAX_BATCH, Math.max(1, Math.trunc(batchSize)));
    for (let index = 0; index < batch; index += 1) {
      const claim = transaction(db, () => {
        const now = clock().toISOString();
        const row = db.prepare(`SELECT r.notification_id, r.recipient_id, r.channel, r.attempts, n.application_id, n.title, n.body, n.notification_type, n.locale, n.expires_at, n.cancelled_at
          FROM notification_recipients r JOIN notifications n USING(notification_id)
          WHERE n.workflow_state='published' AND r.delivery_status IN ('pending','processing') AND COALESCE(r.next_attempt_at,n.scheduled_at)<=?
            AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=?) ORDER BY COALESCE(r.next_attempt_at,n.scheduled_at), r.notification_id LIMIT 1`).get(now, now);
        if (!row) return null;
        const expires = row.expires_at && Date.parse(row.expires_at) <= clock().getTime();
        if (row.cancelled_at || expires) {
          const outcome = row.cancelled_at ? "cancelled" : "expired";
          db.prepare("UPDATE notification_recipients SET delivery_status=?, lease_expires_at=NULL WHERE notification_id=? AND recipient_id=? AND channel=?").run(outcome, row.notification_id, row.recipient_id, row.channel);
          db.prepare("INSERT INTO notification_attempts(attempt_id,notification_id,application_id,recipient_id,channel,attempt_number,outcome,error_code,attempted_at) VALUES(?,?,?,?,?,?,?,NULL,?)")
            .run(`NTA-${crypto.randomUUID()}`, row.notification_id, row.application_id, row.recipient_id, row.channel, row.attempts, outcome, now);
          stats[outcome] += 1;
          return { skipped: true };
        }
        const attempts = row.attempts + 1;
        const lease = new Date(clock().getTime() + 30_000).toISOString();
        db.prepare("UPDATE notification_recipients SET delivery_status='processing', attempts=?, lease_expires_at=? WHERE notification_id=? AND recipient_id=? AND channel=?")
          .run(attempts, lease, row.notification_id, row.recipient_id, row.channel);
        return { row, attempts, idempotencyKey: `${row.notification_id}:${row.recipient_id}:${row.channel}` };
      });
      if (!claim) break;
      if (claim.skipped) continue;
      const { row, attempts, idempotencyKey } = claim;
      let errorCode = null;
      try {
        if (row.channel === "in_app") await Promise.resolve();
        else if (typeof adapters[row.channel] === "function") await adapters[row.channel]({ applicationId: row.application_id, recipientId: row.recipient_id, title: row.title, body: row.body, type: row.notification_type, locale: row.locale, idempotencyKey });
        else throw fail("PROVIDER_NOT_CONFIGURED", "No provider is configured");
        transaction(db, () => {
          const now = clock().toISOString();
          db.prepare("UPDATE notification_recipients SET delivery_status='delivered', delivered_at=?, lease_expires_at=NULL, next_attempt_at=NULL, last_error=NULL WHERE notification_id=? AND recipient_id=? AND channel=? AND delivery_status='processing'")
            .run(now, row.notification_id, row.recipient_id, row.channel);
          db.prepare("INSERT INTO notification_attempts(attempt_id,notification_id,application_id,recipient_id,channel,attempt_number,outcome,error_code,attempted_at) VALUES(?,?,?,?,?,?,'delivered',NULL,?)")
            .run(`NTA-${crypto.randomUUID()}`, row.notification_id, row.application_id, row.recipient_id, row.channel, attempts, now);
          webhookService?.enqueueEventInTransaction({ applicationId: row.application_id, eventType: "notification.delivered", payload: { notification_id: row.notification_id, recipient_id: row.recipient_id === "*" ? null : row.recipient_id, channel: row.channel, delivered_at: now } });
        });
        stats.delivered += 1;
      } catch (error) {
        errorCode = safeCode(error);
        transaction(db, () => {
          const now = clock();
          const terminal = attempts >= MAX_ATTEMPTS;
          const retryAt = new Date(now.getTime() + Math.min(6 * 60 * 60 * 1000, 1000 * 2 ** Math.min(attempts - 1, 12))).toISOString();
          const outcome = terminal ? "failed" : "retrying";
          db.prepare("UPDATE notification_recipients SET delivery_status=?, next_attempt_at=?, lease_expires_at=NULL, last_error=? WHERE notification_id=? AND recipient_id=? AND channel=? AND delivery_status='processing'")
            .run(terminal ? "failed" : "pending", terminal ? null : retryAt, errorCode, row.notification_id, row.recipient_id, row.channel);
          db.prepare("INSERT INTO notification_attempts(attempt_id,notification_id,application_id,recipient_id,channel,attempt_number,outcome,error_code,attempted_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(`NTA-${crypto.randomUUID()}`, row.notification_id, row.application_id, row.recipient_id, row.channel, attempts, outcome, errorCode, now.toISOString());
          stats[outcome] += 1;
        });
      }
    }
    return stats;
  }

  return Object.freeze({ create, preview, updateDraft, previewDraft, approve, publish, history, list, markRead, cancel, retryFailed, dispatchDue, saveTemplate, listTemplates });
}

export function startNotificationWorker({ service, intervalMs = 1000, adapters = {}, onError = () => {} }) {
  if (!service || intervalMs < 250) throw new TypeError("service and an interval of at least 250ms are required");
  let running = false, stopped = false, current = Promise.resolve();
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    current = service.dispatchDue({ adapters }).catch((error) => onError(String(error?.code || "NOTIFICATION_WORKER_FAILED").slice(0, 80))).finally(() => { running = false; });
    await current;
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return async () => { stopped = true; clearInterval(timer); await current; };
}
