import crypto from "node:crypto";
import { authorizeCredential, parseBearer } from "./api-auth.js";
import { createFeedbackAttachmentService } from "./feedback-attachments.js";

const CATEGORIES = new Set(["bug", "feature_request", "question", "complaint", "suggestion", "general"]);
const STATUSES = new Set(["new", "pending", "in_progress", "resolved", "closed"]);
const NOTIFICATION_TYPES = new Set(["update", "release", "maintenance", "security", "payment", "order", "feedback", "announcement"]);
const MAX_BODY = 160 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 100;

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

function send(res, status, body, requestId, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function errorResponse(res, status, code, message, requestId, details) {
  return send(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) }, request_id: requestId }, requestId);
}

async function bodyJson(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json"), { http: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body is too large"), { http: 413, code: "PAYLOAD_TOO_LARGE" });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Request body must be valid JSON"), { http: 400, code: "INVALID_JSON" }); }
}

async function bodyBuffer(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw Object.assign(new Error("Attachment is too large"), { http: 413, code: "PAYLOAD_TOO_LARGE" });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Attachment is too large"), { http: 413, code: "PAYLOAD_TOO_LARGE" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validId(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function normalizeMessage(value) {
  return String(value || "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function apiFeedback(row) {
  const record = JSON.parse(row.record_json || "{}");
  return {
    id: row.id,
    application_id: row.application_id,
    app_id: row.application_id,
    category: row.category,
    title: row.title,
    message: row.message,
    rating: row.rating,
    status: row.status,
    priority: row.priority,
    anonymous: record.anonymous !== false,
    contact_name: record.contact_name || "",
    contact_email: record.contact_email || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function keyFromRequest(req) {
  const value = req.socket?.remoteAddress || req.headers["x-forwarded-for"] || "unknown";
  return String(value).split(",")[0].trim().slice(0, 100);
}

function scopedAuth(req, appService, scope) {
  const context = appService.authenticateCredential(parseBearer(req));
  if (!context) return { status: 401, context: null };
  if (!authorizeCredential(context, scope)) return { status: 403, context: null };
  return { status: 200, context };
}

function createLimiter(clock, { max, windowMs }) {
  const attempts = new Map();
  return (key) => {
    const now = clock().getTime();
    const current = (attempts.get(key) || []).filter((time) => now - time < windowMs);
    current.push(now);
    attempts.set(key, current);
    if (attempts.size > 2000) {
      for (const [item, times] of attempts) if (!times.some((time) => now - time < windowMs)) attempts.delete(item);
    }
    return current.length > max;
  };
}

export function createApiV1({ db, appService, notificationService, webhookService, ownerService, piPaymentService, feeLedger, isPlatformAdmin = () => false, clock = () => new Date(), uploadDir }) {
  const limited = createLimiter(clock, { max: 30, windowMs: 60 * 60 * 1000 });
  const registrationLimited = createLimiter(clock, { max: 3, windowMs: 24 * 60 * 60 * 1000 });
  const paymentLimited = createLimiter(clock, { max: 60, windowMs: 60 * 1000 });
  const ownerLoginLimited = createLimiter(clock, { max: 8, windowMs: 15 * 60 * 1000 });
  const attachmentService = uploadDir ? createFeedbackAttachmentService({ db, uploadDir, clock }) : null;
  function eraseFeedback({ applicationId, feedbackId, actorType }) {
    const feedback = db.prepare("SELECT id FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(feedbackId, applicationId);
    if (!feedback) return false;
    const keys = attachmentService?.storageKeys({ applicationId, feedbackId }) || [];
    withTransaction(db, () => {
      db.prepare("DELETE FROM feedback_messages WHERE feedback_id=? AND application_id=?").run(feedbackId, applicationId);
      db.prepare("DELETE FROM feedback_access_tokens WHERE feedback_id=? AND application_id=?").run(feedbackId, applicationId);
      db.prepare("DELETE FROM feedback_attachments WHERE feedback_id=? AND application_id=?").run(feedbackId, applicationId);
      db.prepare("DELETE FROM feedback WHERE id=? AND application_id=?").run(feedbackId, applicationId);
      db.prepare("INSERT INTO audit_events(audit_id,application_id,actor_type,action,subject_id,details_json,created_at) VALUES(?,?,?,?,?,'{}',?)")
        .run(`AUD-${crypto.randomUUID()}`, applicationId, actorType, "feedback.deleted", feedbackId, clock().toISOString());
      webhookService?.enqueueEventInTransaction({ applicationId, eventType: "feedback.updated", payload: { feedback_id: feedbackId, status: "deleted" } });
    });
    attachmentService?.removeStorageKeys(keys);
    return true;
  }

  return async function apiV1(req, res, url) {
    const pathname = url.pathname;
    const requestId = crypto.randomUUID();
    try {
      if (req.method === "GET" && pathname === "/api/v1/integration/health") {
        db.prepare("SELECT 1 AS ready").get();
        const gatewayOn = String(process.env.HTTPS_GATEWAY || "0") !== "0" && String(process.env.HTTPS_GATEWAY || "").toLowerCase() !== "false";
        const httpsStatus = {
          gateway: gatewayOn ? "active" : "disabled",
          listen_host: process.env.LISTEN_HOST || "0.0.0.0",
          https_port: Number(process.env.HTTPS_PORT || 8443),
          http_port: Number(process.env.HTTP_PORT || 8080),
          public_hostname: process.env.PUBLIC_HOSTNAME || null,
          certificate_mode: process.env.CADDY_EMAIL && process.env.PUBLIC_HOSTNAME ? "public_acme" : "internal_ca",
        };
        return send(res, 200, { ok: true, data: { status: "ok", database: "ready", api_version: "v1", https: httpsStatus }, request_id: requestId }, requestId), true;
      }

      if (pathname.startsWith("/api/v1/owner/") && !ownerService) return errorResponse(res, 503, "OWNER_ACCOUNTS_DISABLED", "Application owner accounts are not configured", requestId), true;
      if (req.method === "POST" && pathname === "/api/v1/owner/claim") {
        if (limited(`owner-claim:${keyFromRequest(req)}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many account claim attempts", requestId), true;
        const input = await bodyJson(req);
        const user = await ownerService.claimInvite({ token: input.token, email: input.email, password: input.password });
        return send(res, 201, { ok: true, data: user }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/owner/login") {
        if (ownerLoginLimited(`owner-login:${keyFromRequest(req)}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many login attempts", requestId), true;
        const input = await bodyJson(req);
        const session = await ownerService.login({ email: input.email, password: input.password });
        const maxAge = Math.floor((Date.parse(session.expires_at) - clock().getTime()) / 1000);
        const cookie = `SHFH_OWNER=${encodeURIComponent(session.sessionToken)}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/owner; Max-Age=${maxAge}`;
        return send(res, 200, { ok: true, data: { user_id: session.user_id, email: session.email, csrf_token: session.csrfToken, expires_at: session.expires_at } }, requestId, { "Set-Cookie": cookie }), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/owner/password-reset") {
        if (ownerLoginLimited(`owner-reset:${keyFromRequest(req)}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many password reset attempts", requestId), true;
        const input = await bodyJson(req);
        const result = await ownerService.completePasswordReset({ token: input.token, password: input.password });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/owner/logout") {
        const owner = ownerService.authenticate(req, { mutation: true });
        ownerService.logout(req);
        return send(res, 200, { ok: true, data: { logged_out: true } }, requestId, { "Set-Cookie": "SHFH_OWNER=; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/owner; Max-Age=0" }), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/apps/owners/password-reset") {
        if (!isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required", requestId), true;
        const input = await bodyJson(req);
        const email = String(input.email || "").trim().toLowerCase();
        const user = db.prepare("SELECT user_id FROM owner_users WHERE email=? COLLATE NOCASE AND status='active'").get(email);
        const member = user && db.prepare("SELECT 1 FROM application_memberships WHERE user_id=?").get(user.user_id);
        const result = member ? ownerService.createPasswordReset({ email }) : { token: null };
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const ownerInvite = pathname.match(/^\/api\/v1\/apps\/([^/]+)\/owners\/invite$/);
      if (req.method === "POST" && ownerInvite) {
        if (!isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required", requestId), true;
        const input = await bodyJson(req);
        const result = ownerService.createInvite({ applicationId: validId(ownerInvite[1]), email: input.email, role: input.role || "owner" });
        return send(res, 201, { ok: true, data: result }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/apps/register") {
        if (limited(`register:${keyFromRequest(req)}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many application registration requests", requestId), true;
        const registrationKey = keyFromRequest(req);
        if (registrationLimited(registrationKey)) return errorResponse(res, 429, "RATE_LIMITED", "New application registrations are limited to three per day", requestId), true;
        const pending = db.prepare("SELECT count(*) AS total FROM applications WHERE integration_status='pending'").get().total;
        if (pending >= 100) return errorResponse(res, 429, "PENDING_QUEUE_FULL", "The application approval queue is full", requestId), true;
        const input = await bodyJson(req);
        const app = appService.requestRegistration(input);
        return send(res, 202, { ok: true, data: app }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/apps") {
        if (!isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required", requestId), true;
        const items = db.prepare("SELECT application_id, app_name, category, description, application_url, backend_api_url, integration_status, created_at, updated_at FROM applications ORDER BY created_at DESC").all();
        return send(res, 200, { ok: true, data: { items } }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/owner/apps") {
        const user = ownerService.authenticate(req);
        return send(res, 200, { ok: true, data: { items: ownerService.listApps({ userId: user.user_id }) } }, requestId), true;
      }

      const ownerAnalytics = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/analytics$/);
      if (req.method === "GET" && ownerAnalytics) {
        const user = ownerService.authenticate(req), applicationId = validId(ownerAnalytics[1]);
        ownerService.membership({ userId: user.user_id, applicationId });
        const statuses = db.prepare("SELECT status,count(*) AS total FROM feedback WHERE application_id=? AND deleted_at IS NULL GROUP BY status ORDER BY status").all(applicationId);
        const categories = db.prepare("SELECT category,count(*) AS total,AVG(NULLIF(rating,0)) AS average_rating FROM feedback WHERE application_id=? AND deleted_at IS NULL GROUP BY category ORDER BY total DESC,category").all(applicationId).map((row) => ({ ...row, average_rating: row.average_rating == null ? null : Number(row.average_rating.toFixed(2)) }));
        const months = db.prepare("SELECT strftime('%Y-%m',created_at) AS month,count(*) AS total,AVG(NULLIF(rating,0)) AS average_rating FROM feedback WHERE application_id=? AND deleted_at IS NULL AND created_at>=datetime('now','-6 months') GROUP BY month ORDER BY month").all(applicationId).map((row) => ({ ...row, average_rating: row.average_rating == null ? null : Number(row.average_rating.toFixed(2)) }));
        const deliveries = db.prepare("SELECT channel,outcome,count(*) AS total FROM notification_attempts WHERE application_id=? GROUP BY channel,outcome ORDER BY channel,outcome").all(applicationId);
        const webhook = webhookService ? webhookService.deliveries({ applicationId, limit: 200 }) : [];
        const payment = db.prepare("SELECT status,count(*) AS total,SUM(amount_micros) AS amount_micros FROM payment_transactions WHERE application_id=? GROUP BY status ORDER BY status").all(applicationId);
        return send(res, 200, { ok: true, data: { feedback: { statuses, categories, months }, notifications: { deliveries }, webhooks: { deliveries: webhook.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}) }, payments: { transactions: payment } } }, requestId), true;
      }

      const ownerSettings = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/settings$/);
      if (ownerSettings && ["GET", "PUT"].includes(req.method)) {
        const mutation = req.method === "PUT", user = ownerService.authenticate(req, { mutation });
        const applicationId = validId(ownerSettings[1]);
        ownerService.membership({ userId: user.user_id, applicationId, ...(mutation ? { minimumRole: "admin" } : {}) });
        const row = db.prepare("SELECT application_id,app_name,category,description,application_url,backend_api_url,integration_status,updated_at FROM applications WHERE application_id=?").get(applicationId);
        if (!mutation) return send(res, 200, { ok: true, data: { application: row } }, requestId), true;
        const input = await bodyJson(req);
        const appName = clean(input.app_name, 120), description = clean(input.description, 1000);
        const applicationUrl = clean(input.application_url, 500), backendApiUrl = clean(input.backend_api_url, 500);
        const validHttpUrl = (value) => { if (!value) return true; try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash; } catch { return false; } };
        if (!appName || !validHttpUrl(applicationUrl) || !validHttpUrl(backendApiUrl)) return errorResponse(res, 400, "VALIDATION_ERROR", "Application name or URL is invalid", requestId), true;
        const now = clock().toISOString();
        withTransaction(db, () => {
          db.prepare("UPDATE applications SET app_name=?,description=?,application_url=?,backend_api_url=?,updated_at=? WHERE application_id=?").run(appName, description, applicationUrl, backendApiUrl, now, applicationId);
          db.prepare("INSERT INTO audit_events(audit_id,application_id,actor_type,action,subject_id,details_json,created_at) VALUES(?,?,'owner','app.settings.updated',?,'{}',?)").run(`AUD-${crypto.randomUUID()}`, applicationId, applicationId, now);
          webhookService?.enqueueEventInTransaction({ applicationId, eventType: "app.updated", payload: { application_id: applicationId, updated_at: now } });
        });
        return send(res, 200, { ok: true, data: { application: db.prepare("SELECT application_id,app_name,category,description,application_url,backend_api_url,integration_status,updated_at FROM applications WHERE application_id=?").get(applicationId) } }, requestId), true;
      }

      const ownerApp = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)$/);
      if (req.method === "GET" && ownerApp) {
        const user = ownerService.authenticate(req);
        const applicationId = validId(ownerApp[1]);
        const role = ownerService.membership({ userId: user.user_id, applicationId });
        const app = db.prepare("SELECT application_id,app_name,category,description,application_url,integration_status,created_at,updated_at FROM applications WHERE application_id=?").get(applicationId);
        const feedback = db.prepare("SELECT count(*) AS total,SUM(CASE WHEN status IN ('new','pending','in_progress') THEN 1 ELSE 0 END) AS open,AVG(NULLIF(rating,0)) AS rating FROM feedback WHERE application_id=? AND deleted_at IS NULL").get(applicationId);
        const notices = db.prepare("SELECT count(*) AS total,SUM(CASE WHEN cancelled_at IS NULL THEN 1 ELSE 0 END) AS active FROM notifications WHERE application_id=?").get(applicationId);
        const webhooks = webhookService ? webhookService.listSubscriptions({ applicationId }) : [];
        const deliveries = webhookService ? webhookService.deliveries({ applicationId, limit: 20 }) : [];
        const credentials = db.prepare("SELECT credential_id,scopes_json,created_at,last_used_at,expires_at,revoked_at FROM api_credentials WHERE application_id=? ORDER BY created_at DESC").all(applicationId).map((row) => ({ ...row, scopes: JSON.parse(row.scopes_json), scopes_json: undefined }));
        const recentActivity = db.prepare("SELECT actor_type,action,subject_id,created_at FROM audit_events WHERE application_id=? ORDER BY created_at DESC LIMIT 30").all(applicationId);
        const transactions = db.prepare("SELECT count(*) AS total,SUM(CASE WHEN verification_state='verified' THEN 1 ELSE 0 END) AS verified FROM payment_transactions WHERE application_id=?").get(applicationId);
        return send(res, 200, { ok: true, data: { app, role, stats: { feedback_total: feedback.total, feedback_open: feedback.open || 0, average_rating: feedback.rating == null ? null : Number(feedback.rating.toFixed(2)), notifications_total: notices.total, notifications_active: notices.active || 0, webhooks_active: webhooks.filter((hook) => hook.active).length, webhook_deliveries: deliveries.length, payments_total: transactions.total, payments_verified: transactions.verified || 0 }, credentials, webhooks, recent_deliveries: deliveries, activity: recentActivity } }, requestId), true;
      }

      const ownerFeedbackList = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/feedback$/);
      if (req.method === "GET" && ownerFeedbackList) {
        const user = ownerService.authenticate(req);
        const applicationId = validId(ownerFeedbackList[1]);
        ownerService.membership({ userId: user.user_id, applicationId });
        const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
        const limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get("limit")) || 25)));
        const filter = clean(url.searchParams.get("status"), 32);
        if (filter && !STATUSES.has(filter)) return errorResponse(res, 400, "VALIDATION_ERROR", "status is not supported", requestId), true;
        const q = clean(url.searchParams.get("q"), 100).toLocaleLowerCase();
        const conditions = ["application_id=?", "deleted_at IS NULL"];
        const params = [applicationId];
        if (filter) { conditions.push("status=?"); params.push(filter); }
        if (q) { conditions.push("(instr(lower(title),lower(?))>0 OR instr(lower(message),lower(?))>0)"); params.push(q, q); }
        const where = conditions.join(" AND ");
        const total = db.prepare(`SELECT count(*) AS total FROM feedback WHERE ${where}`).get(...params).total;
        const items = db.prepare(`SELECT * FROM feedback WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit).map(apiFeedback);
        return send(res, 200, { ok: true, data: { items }, meta: { page, limit, total, pages: Math.ceil(total / limit) } }, requestId), true;
      }

      const ownerFeedbackRead = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/feedback\/([^/]+)$/);
      if (req.method === "GET" && ownerFeedbackRead) {
        const user = ownerService.authenticate(req);
        const applicationId = validId(ownerFeedbackRead[1]), feedbackId = validId(ownerFeedbackRead[2]);
        const role = ownerService.membership({ userId: user.user_id, applicationId });
        const row = db.prepare("SELECT * FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(feedbackId, applicationId);
        if (!row) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        const messages = db.prepare(`SELECT message_id,author_type,is_private,body,created_at FROM feedback_messages WHERE feedback_id=? AND application_id=? ${role === "member" ? "AND is_private=0" : ""} ORDER BY created_at,message_id`).all(feedbackId, applicationId).map((item) => ({ ...item, is_private: Boolean(item.is_private) }));
        const attachments = db.prepare("SELECT attachment_id,original_name,mime_type,size_bytes,created_at FROM feedback_attachments WHERE feedback_id=? AND application_id=? ORDER BY created_at").all(feedbackId, applicationId);
        return send(res, 200, { ok: true, data: { ...apiFeedback(row), messages, attachments } }, requestId), true;
      }

      const ownerAttachment = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/feedback\/([^/]+)\/attachments(?:\/([^/]+))?$/);
      if (ownerAttachment && ["GET", "POST"].includes(req.method)) {
        const mutation = req.method === "POST", user = ownerService.authenticate(req, { mutation });
        const applicationId = validId(ownerAttachment[1]), feedbackId = validId(ownerAttachment[2]);
        ownerService.membership({ userId: user.user_id, applicationId, ...(mutation ? { minimumRole: "admin" } : {}) });
        if (!attachmentService) return errorResponse(res, 503, "UPLOADS_DISABLED", "Attachment storage is not configured", requestId), true;
        if (!db.prepare("SELECT 1 FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(feedbackId, applicationId)) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        if (mutation) {
          const declaredMime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          const bytes = await bodyBuffer(req, MAX_ATTACHMENT_BYTES);
          const saved = attachmentService.store({ applicationId, feedbackId, originalName: url.searchParams.get("filename"), declaredMime, bytes });
          return send(res, 201, { ok: true, data: saved }, requestId), true;
        }
        if (!ownerAttachment[3]) return errorResponse(res, 404, "ATTACHMENT_NOT_FOUND", "Attachment was not found", requestId), true;
        const attachment = attachmentService.read({ applicationId, feedbackId, attachmentId: validId(ownerAttachment[3]) });
        res.writeHead(200, { "Content-Type": attachment.mime_type, "Content-Length": attachment.bytes.length, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId });
        res.end(attachment.bytes);
        return true;
      }

      const ownerFeedbackMessages = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/feedback\/([^/]+)\/messages$/);
      if (ownerFeedbackMessages && ["GET", "POST"].includes(req.method)) {
        const mutating = req.method === "POST";
        const user = ownerService.authenticate(req, { mutation: mutating });
        const applicationId = validId(ownerFeedbackMessages[1]), feedbackId = validId(ownerFeedbackMessages[2]);
        const role = ownerService.membership({ userId: user.user_id, applicationId });
        if (!db.prepare("SELECT 1 FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(feedbackId, applicationId)) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        if (req.method === "GET") {
          const rows = db.prepare(`SELECT message_id,author_type,is_private,body,created_at FROM feedback_messages WHERE feedback_id=? AND application_id=? ${role === "member" ? "AND is_private=0" : ""} ORDER BY created_at,message_id`).all(feedbackId, applicationId).map((row) => ({ ...row, is_private: Boolean(row.is_private) }));
          return send(res, 200, { ok: true, data: { items: rows } }, requestId), true;
        }
        const input = await bodyJson(req), body = clean(input.body, 4000), privateNote = input.private === true;
        if (!body) return errorResponse(res, 400, "VALIDATION_ERROR", "A message body is required", requestId), true;
        if (privateNote && !["owner", "admin"].includes(role)) return errorResponse(res, 403, "ROLE_REQUIRED", "Only application owners and administrators can add private notes", requestId), true;
        const messageId = `MSG-${crypto.randomUUID()}`, createdAt = clock().toISOString();
        withTransaction(db, () => {
          db.prepare("INSERT INTO feedback_messages(message_id,feedback_id,application_id,author_type,is_private,body,created_at) VALUES(?,?,?,?,?,?,?)").run(messageId, feedbackId, applicationId, privateNote ? "admin" : "application", privateNote ? 1 : 0, body, createdAt);
          if (!privateNote) webhookService?.enqueueEventInTransaction({ applicationId, eventType: "feedback.replied", payload: { feedback_id: feedbackId, message_id: messageId, author_type: "application", created_at: createdAt } });
        });
        return send(res, 201, { ok: true, data: { message_id: messageId, feedback_id: feedbackId, body, private: privateNote, created_at: createdAt } }, requestId), true;
      }

      const ownerMembers = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/members$/);
      if (req.method === "GET" && ownerMembers) {
        const user = ownerService.authenticate(req);
        return send(res, 200, { ok: true, data: { items: ownerService.listMembers({ userId: user.user_id, applicationId: validId(ownerMembers[1]) }) } }, requestId), true;
      }

      const ownerMemberRevoke = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/members\/([^/]+)\/revoke$/);
      if (req.method === "POST" && ownerMemberRevoke) {
        const user = ownerService.authenticate(req, { mutation: true });
        const result = ownerService.revokeMember({ actorId: user.user_id, applicationId: validId(ownerMemberRevoke[1]), targetUserId: validId(ownerMemberRevoke[2]) });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const ownerNotifications = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/notifications$/);
      if (ownerNotifications && ["GET", "POST"].includes(req.method)) {
        const user = ownerService.authenticate(req, { mutation: req.method === "POST" });
        const applicationId = validId(ownerNotifications[1]);
        ownerService.membership({ userId: user.user_id, applicationId });
        if (req.method === "GET") {
          const recipientId = url.searchParams.get("recipient_id");
          const items = recipientId ? notificationService.list({ applicationId, recipientId, unreadOnly: url.searchParams.get("unread") === "true" }).items : db.prepare(`SELECT n.notification_id,n.title,n.body,n.notification_type AS type,n.locale,n.scheduled_at,n.expires_at,n.audience,n.channel,n.cancelled_at,n.workflow_state,n.approved_at,n.published_at,
            (SELECT count(*) FROM notification_recipients r WHERE r.notification_id=n.notification_id) AS recipients_total,
            (SELECT count(*) FROM notification_recipients r WHERE r.notification_id=n.notification_id AND r.delivery_status='delivered') AS delivered_total,
            (SELECT count(*) FROM notification_recipients r WHERE r.notification_id=n.notification_id AND r.delivery_status='failed') AS failed_total,
            (SELECT last_error FROM notification_recipients r WHERE r.notification_id=n.notification_id AND r.last_error IS NOT NULL LIMIT 1) AS last_error
            FROM notifications n WHERE n.application_id=? ORDER BY n.created_at DESC LIMIT 100`).all(applicationId).map((item) => ({
              ...item,
              recipient_ids: db.prepare("SELECT recipient_id FROM notification_recipients WHERE notification_id=? AND recipient_id<>'*' ORDER BY recipient_id").all(item.notification_id).map((recipient) => recipient.recipient_id),
              history: notificationService.history({ applicationId, notificationId: item.notification_id }),
            }));
          return send(res, 200, { ok: true, data: { items } }, requestId), true;
        }
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        const input = await bodyJson(req);
        const created = notificationService.create({ applicationId, title: input.title, body: input.body, templateKey: input.template_key, variables: input.variables, type: input.type, locale: input.locale, channel: input.channel || "in_app", audience: input.audience || "all", recipientIds: input.recipient_ids, scheduledAt: input.scheduled_at, expiresAt: input.expires_at, idempotencyKey: input.idempotency_key || `owner-${crypto.randomUUID()}`, workflowState: "draft", actorType: "app_owner", actorId: user.user_id, createdBy: user.user_id });
        return send(res, created.status === "replayed" ? 200 : 201, { ok: true, data: created }, requestId), true;
      }

      const ownerNotificationEdit = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/notifications\/(?!templates$)([^/]+)$/);
      if (req.method === "PUT" && ownerNotificationEdit) {
        const user = ownerService.authenticate(req, { mutation: true }), applicationId = validId(ownerNotificationEdit[1]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        const input = await bodyJson(req);
        const result = notificationService.updateDraft({ applicationId, notificationId: validId(ownerNotificationEdit[2]), input: { title: input.title, body: input.body, templateKey: input.template_key, variables: input.variables, type: input.type, locale: input.locale, channel: input.channel || "in_app", audience: input.audience || "all", recipientIds: input.recipient_ids, scheduledAt: input.scheduled_at, expiresAt: input.expires_at }, actorType: "app_owner", actorId: user.user_id });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const ownerNotificationHistory = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/notifications\/([^/]+)\/history$/);
      if (req.method === "GET" && ownerNotificationHistory) {
        const user = ownerService.authenticate(req), applicationId = validId(ownerNotificationHistory[1]);
        ownerService.membership({ userId: user.user_id, applicationId });
        return send(res, 200, { ok: true, data: { items: notificationService.history({ applicationId, notificationId: validId(ownerNotificationHistory[2]) }) } }, requestId), true;
      }

      const ownerNotificationTemplates = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/notifications\/templates$/);
      if (ownerNotificationTemplates && ["GET", "PUT"].includes(req.method)) {
        const mutation = req.method === "PUT", user = ownerService.authenticate(req, { mutation });
        const applicationId = validId(ownerNotificationTemplates[1]);
        ownerService.membership({ userId: user.user_id, applicationId, ...(mutation ? { minimumRole: "admin" } : {}) });
        if (!notificationService) return errorResponse(res, 503, "NOTIFICATION_WORKER_UNAVAILABLE", "Notification service is unavailable", requestId), true;
        if (!mutation) return send(res, 200, { ok: true, data: { items: notificationService.listTemplates({ applicationId }) } }, requestId), true;
        const input = await bodyJson(req);
        const template = notificationService.saveTemplate({ applicationId, key: input.key, locale: input.locale, title: input.title, body: input.body });
        return send(res, 200, { ok: true, data: template }, requestId), true;
      }

      const ownerNotificationAction = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/notifications\/([^/]+)\/(preview|approve|publish|cancel|retry)$/);
      if (req.method === "POST" && ownerNotificationAction) {
        const user = ownerService.authenticate(req, { mutation: true }), applicationId = validId(ownerNotificationAction[1]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        if (!notificationService) return errorResponse(res, 503, "NOTIFICATION_WORKER_UNAVAILABLE", "Notification service is unavailable", requestId), true;
        const notificationId = validId(ownerNotificationAction[2]);
        const action = ownerNotificationAction[3];
        const result = action === "preview" ? notificationService.previewDraft({ applicationId, notificationId, actorType: "app_owner", actorId: user.user_id })
          : action === "approve" ? notificationService.approve({ applicationId, notificationId, actorType: "app_owner", actorId: user.user_id })
            : action === "publish" ? notificationService.publish({ applicationId, notificationId, actorType: "app_owner", actorId: user.user_id })
              : action === "cancel" ? notificationService.cancel({ applicationId, notificationId, actorType: "app_owner", actorId: user.user_id })
                : notificationService.retryFailed({ applicationId, notificationId });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const ownerWebhooks = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/webhooks$/);
      if (ownerWebhooks && ["GET", "POST"].includes(req.method)) {
        const user = ownerService.authenticate(req, { mutation: req.method === "POST" }); const applicationId = validId(ownerWebhooks[1]); ownerService.membership({ userId: user.user_id, applicationId });
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        if (req.method === "GET") return send(res, 200, { ok: true, data: { items: webhookService.listSubscriptions({ applicationId }) } }, requestId), true;
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        const input = await bodyJson(req);
        return send(res, 201, { ok: true, data: await webhookService.register({ applicationId, endpoint: input.endpoint, events: input.events }) }, requestId), true;
      }

      const ownerWebhookAction = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/webhooks\/([^/]+)\/(rotate|disable)$/);
      if (req.method === "POST" && ownerWebhookAction) {
        const user = ownerService.authenticate(req, { mutation: true }); const applicationId = validId(ownerWebhookAction[1]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        const result = ownerWebhookAction[3] === "rotate" ? webhookService.rotateSecret({ applicationId, webhookId: validId(ownerWebhookAction[2]) }) : webhookService.disable({ applicationId, webhookId: validId(ownerWebhookAction[2]) });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const ownerWebhookDeliveries = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/deliveries$/);
      if (req.method === "GET" && ownerWebhookDeliveries) {
        const user = ownerService.authenticate(req); const applicationId = validId(ownerWebhookDeliveries[1]); ownerService.membership({ userId: user.user_id, applicationId });
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        return send(res, 200, { ok: true, data: { items: webhookService.deliveries({ applicationId, limit: url.searchParams.get("limit") }) } }, requestId), true;
      }

      const ownerDeliveryRetry = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/deliveries\/([^/]+)\/retry$/);
      if (req.method === "POST" && ownerDeliveryRetry) {
        const user = ownerService.authenticate(req, { mutation: true }); const applicationId = validId(ownerDeliveryRetry[1]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        return send(res, 200, { ok: true, data: webhookService.retryFailed({ applicationId, deliveryId: validId(ownerDeliveryRetry[2]) }) }, requestId), true;
      }

      const ownerPayments = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/payments$/);
      if (req.method === "GET" && ownerPayments) {
        const user = ownerService.authenticate(req); const applicationId = validId(ownerPayments[1]); ownerService.membership({ userId: user.user_id, applicationId });
        const items = db.prepare("SELECT s.session_id,s.amount_micros,s.memo,s.order_reference,s.status,s.created_at,s.updated_at,t.pi_payment_id,t.txid,t.status AS transaction_status,t.verification_state,t.failure_code FROM payment_sessions s LEFT JOIN payment_transactions t ON t.session_id=s.session_id WHERE s.application_id=? ORDER BY s.created_at DESC LIMIT 200").all(applicationId).map((row) => ({ session_id: row.session_id, amount: row.amount_micros / 10_000_000, amount_unit: "Pi", memo: row.memo, order_reference: row.order_reference, status: row.transaction_status || row.status, payment_id: row.pi_payment_id, txid: row.txid, verification_state: row.verification_state || "unverified", failure_code: row.failure_code, created_at: row.created_at, updated_at: row.updated_at }));
        return send(res, 200, { ok: true, data: { items } }, requestId), true;
      }

      const ownerPiConfig = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/pi-config$/);
      if (ownerPiConfig && ["GET", "PUT"].includes(req.method)) {
        const mutation = req.method === "PUT";
        const user = ownerService.authenticate(req, { mutation });
        const applicationId = validId(ownerPiConfig[1]);
        ownerService.membership({ userId: user.user_id, applicationId, ...(mutation ? { minimumRole: "admin" } : {}) });
        if (!piPaymentService) return errorResponse(res, 503, "PI_PAYMENTS_DISABLED", "Encrypted Pi payment configuration is unavailable", requestId), true;
        if (!mutation) return send(res, 200, { ok: true, data: { configuration: piPaymentService.configuration(applicationId) } }, requestId), true;
        const input = await bodyJson(req);
        const configuration = piPaymentService.configure({ applicationId, piAppId: input.pi_app_id, serverApiKey: input.server_api_key, network: input.network });
        return send(res, 200, { ok: true, data: { configuration } }, requestId), true;
      }

      const ownerFeedback = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/feedback\/([^/]+)$/);
      if (ownerFeedback && ["PATCH", "DELETE"].includes(req.method)) {
        const user = ownerService.authenticate(req, { mutation: true });
        const applicationId = validId(ownerFeedback[1]), feedbackId = validId(ownerFeedback[2]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        if (req.method === "DELETE") {
          if (!eraseFeedback({ applicationId, feedbackId, actorType: "owner" })) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
          return send(res, 200, { ok: true, data: { deleted: true } }, requestId), true;
        }
        const input = await bodyJson(req);
        if ((input.status != null && !STATUSES.has(input.status)) || (input.priority != null && !["P1", "P2", "P3"].includes(input.priority))) return errorResponse(res, 400, "VALIDATION_ERROR", "status or priority is invalid", requestId), true;
        const row = db.prepare("SELECT * FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(feedbackId, applicationId);
        if (!row) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        const status = input.status ?? row.status, priority = input.priority ?? row.priority, now = clock().toISOString();
        const record = JSON.parse(row.record_json || "{}"); record.status = status.toUpperCase(); record.priority = priority;
        withTransaction(db, () => {
          db.prepare("UPDATE feedback SET status=?,priority=?,updated_at=?,record_json=? WHERE id=? AND application_id=? AND deleted_at IS NULL").run(status, priority, now, JSON.stringify(record), feedbackId, applicationId);
          webhookService?.enqueueEventInTransaction({ applicationId, eventType: "feedback.updated", payload: { feedback_id: feedbackId, status, priority, updated_at: now } });
        });
        return send(res, 200, { ok: true, data: apiFeedback(db.prepare("SELECT * FROM feedback WHERE id=? AND application_id=?").get(feedbackId, applicationId)) }, requestId), true;
      }

      const ownerCredentials = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/credentials$/);
      if (req.method === "POST" && ownerCredentials) {
        const user = ownerService.authenticate(req, { mutation: true });
        const applicationId = validId(ownerCredentials[1]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        const input = await bodyJson(req);
        return send(res, 201, { ok: true, data: appService.issueCredential(applicationId, input.scopes) }, requestId), true;
      }

      const ownerCredentialRevoke = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/credentials\/([^/]+)\/revoke$/);
      if (req.method === "POST" && ownerCredentialRevoke) {
        const user = ownerService.authenticate(req, { mutation: true });
        const applicationId = validId(ownerCredentialRevoke[1]), credentialId = validId(ownerCredentialRevoke[2]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "admin" });
        if (!db.prepare("SELECT 1 FROM api_credentials WHERE credential_id=? AND application_id=?").get(credentialId, applicationId) || !appService.revokeCredential(credentialId)) return errorResponse(res, 404, "CREDENTIAL_NOT_FOUND", "Credential was not found or already revoked", requestId), true;
        return send(res, 200, { ok: true, data: { revoked: true } }, requestId), true;
      }

      const ownerInviteMember = pathname.match(/^\/api\/v1\/owner\/apps\/([^/]+)\/members\/invite$/);
      if (req.method === "POST" && ownerInviteMember) {
        const user = ownerService.authenticate(req, { mutation: true });
        const applicationId = validId(ownerInviteMember[1]);
        ownerService.membership({ userId: user.user_id, applicationId, minimumRole: "owner" });
        const input = await bodyJson(req);
        return send(res, 201, { ok: true, data: ownerService.createInvite({ applicationId, email: input.email, role: input.role || "member" }) }, requestId), true;
      }

      const appDelete = pathname.match(/^\/api\/v1\/apps\/([^/]+)$/);
      if (req.method === "DELETE" && appDelete) {
        if (!isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required", requestId), true;
        const applicationId = validId(appDelete[1]);
        const app = appService.disableApp(applicationId);
        return send(res, 200, { ok: true, data: { deleted: true, application: app } }, requestId), true;
      }

      const appAction = pathname.match(/^\/api\/v1\/apps\/([^/]+)\/(approve|credentials)$/);
      if (req.method === "POST" && appAction) {
        if (!isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required", requestId), true;
        const applicationId = validId(appAction[1]);
        if (!applicationId) return errorResponse(res, 400, "INVALID_APP_ID", "Application ID is invalid", requestId), true;
        if (appAction[2] === "approve") {
          const app = appService.approveApp(applicationId);
          webhookService?.enqueueEvent({ applicationId, eventType: "app.updated", payload: { application_id: applicationId, integration_status: app.integration_status } });
          return send(res, 200, { ok: true, data: app }, requestId), true;
        }
        const input = await bodyJson(req);
        const credential = appService.issueCredential(applicationId, input.scopes);
        return send(res, 201, { ok: true, data: credential }, requestId), true;
      }

      const revoke = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/revoke$/);
      if (req.method === "POST" && revoke) {
        if (!isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required", requestId), true;
        const revoked = appService.revokeCredential(validId(revoke[1]));
        if (!revoked) return errorResponse(res, 404, "CREDENTIAL_NOT_FOUND", "Credential not found or already revoked", requestId), true;
        return send(res, 200, { ok: true, data: { revoked: true } }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/feedback") {
        const scoped = scopedAuth(req, appService, "feedback:write");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED",
          scoped.status === 401 ? "A valid application credential is required" : "Credential does not include feedback:write scope", requestId), true;
        const auth = scoped.context;
        if (limited(`feedback:${auth.applicationId}:${keyFromRequest(req)}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many feedback submissions", requestId), true;
        const input = await bodyJson(req);
        const category = clean(input.category, 40).toLowerCase();
        const title = clean(input.title, 160);
        const message = clean(input.message, 4000);
        const rating = input.rating == null ? 0 : Number(input.rating);
        const contactEmail = clean(input.contact_email, 254);
        if (!CATEGORIES.has(category)) return errorResponse(res, 400, "VALIDATION_ERROR", "category is not supported", requestId, { field: "category" }), true;
        if (!title) return errorResponse(res, 400, "VALIDATION_ERROR", "title is required", requestId, { field: "title" }), true;
        if (!message) return errorResponse(res, 400, "VALIDATION_ERROR", "message is required", requestId, { field: "message" }), true;
        if (!Number.isInteger(rating) || (input.rating != null && (rating < 1 || rating > 5))) return errorResponse(res, 400, "VALIDATION_ERROR", "rating must be an integer from 1 to 5 when provided", requestId, { field: "rating" }), true;
        if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return errorResponse(res, 400, "VALIDATION_ERROR", "contact_email is invalid", requestId, { field: "contact_email" }), true;
        if (input.anonymous != null && typeof input.anonymous !== "boolean") return errorResponse(res, 400, "VALIDATION_ERROR", "anonymous must be boolean", requestId, { field: "anonymous" }), true;
        if (input.follow_up != null && typeof input.follow_up !== "boolean") return errorResponse(res, 400, "VALIDATION_ERROR", "follow_up must be boolean", requestId, { field: "follow_up" }), true;
        const anonymous = input.anonymous !== false;
        if (input.follow_up === true && (anonymous || !contactEmail)) return errorResponse(res, 400, "VALIDATION_ERROR", "follow_up requires a non-anonymous submission with contact_email", requestId), true;
        const followUpToken = input.follow_up === true ? `fhcust_${crypto.randomBytes(32).toString("base64url")}` : null;
        const normalizedMessage = normalizeMessage(message);
        const item = withTransaction(db, () => {
          const recent = db.prepare("SELECT message, created_at FROM feedback WHERE application_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 30")
            .all(auth.applicationId, new Date(clock().getTime() - 10 * 60 * 1000).toISOString());
          if (recent.some((row) => normalizeMessage(row.message) === normalizedMessage)) throw Object.assign(new Error("Duplicate feedback"), { code: "DUPLICATE_FEEDBACK" });
          const id = `FB-${clock().getTime().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
          const createdAt = clock().toISOString();
          const row = {
            id, schema_version: "1.0", app_id: auth.applicationId, category, type: category,
            title, message, rating, status: "NEW", priority: "P2", severity: "normal",
            anonymous, contact_name: clean(input.contact_name, 120), contact_email: anonymous ? "" : contactEmail,
            created_at: createdAt,
          };
          db.prepare(`INSERT INTO feedback(id, application_id, category, title, message, rating, status, priority, created_at, record_json)
            VALUES (?, ?, ?, ?, ?, ?, 'new', 'P2', ?, ?)`)
            .run(id, auth.applicationId, category, title, message, rating, createdAt, JSON.stringify(row));
          if (followUpToken) db.prepare("INSERT INTO feedback_access_tokens(token_id, application_id, feedback_id, token_hash, created_at, expires_at) VALUES(?,?,?,?,?,?)")
            .run(`fat_${crypto.randomUUID()}`, auth.applicationId, id, crypto.createHash("sha256").update(followUpToken).digest("hex"), createdAt, new Date(clock().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString());
          webhookService?.enqueueEventInTransaction({ applicationId: auth.applicationId, eventType: "feedback.created", payload: { feedback_id: id, category, title, status: "new", created_at: createdAt } });
          return row;
        });
        return send(res, 201, { ok: true, data: { ...item, application_id: auth.applicationId, ...(followUpToken ? { follow_up_token: followUpToken, follow_up_url: "/feedback/track" } : {}) } }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/feedback") {
        const scoped = scopedAuth(req, appService, "feedback:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED",
          scoped.status === 401 ? "A valid application credential is required" : "Credential does not include feedback:read scope", requestId), true;
        const auth = scoped.context;
        const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
        const limit = Math.max(1, Math.min(PAGE_SIZE, Math.floor(Number(url.searchParams.get("limit")) || 25)));
        const conditions = ["application_id=?", "deleted_at IS NULL"];
        const values = [auth.applicationId];
        const category = url.searchParams.get("category");
        const status = url.searchParams.get("status");
        if (category) {
          if (!CATEGORIES.has(category)) return errorResponse(res, 400, "VALIDATION_ERROR", "category is not supported", requestId, { field: "category" }), true;
          conditions.push("category=?"); values.push(category);
        }
        if (status) {
          if (!STATUSES.has(status)) return errorResponse(res, 400, "VALIDATION_ERROR", "status is not supported", requestId, { field: "status" }), true;
          conditions.push("status=?"); values.push(status);
        }
        const priority = url.searchParams.get("priority");
        if (priority) {
          if (!["P1", "P2", "P3"].includes(priority)) return errorResponse(res, 400, "VALIDATION_ERROR", "priority is not supported", requestId), true;
          conditions.push("priority=?"); values.push(priority);
        }
        const query = clean(url.searchParams.get("q"), 100).toLocaleLowerCase();
        if (url.searchParams.has("q") && !query) return errorResponse(res, 400, "VALIDATION_ERROR", "q must not be empty", requestId), true;
        if (query) { conditions.push("(instr(lower(title),lower(?))>0 OR instr(lower(message),lower(?))>0)"); values.push(query, query); }
        const sortFields = { created_at: "created_at", updated_at: "COALESCE(updated_at,created_at)", rating: "rating", priority: "priority", status: "status", title: "title" };
        const sort = url.searchParams.get("sort") || "created_at";
        const direction = String(url.searchParams.get("order") || "desc").toLowerCase();
        if (!sortFields[sort] || !["asc", "desc"].includes(direction)) return errorResponse(res, 400, "VALIDATION_ERROR", "sort or order is not supported", requestId), true;
        const where = conditions.join(" AND ");
        const count = db.prepare(`SELECT count(*) AS total FROM feedback WHERE ${where}`).get(...values).total;
        const rows = db.prepare(`SELECT id, application_id, category, title, message, rating, status, priority, created_at, updated_at, record_json
          FROM feedback WHERE ${where} ORDER BY ${sortFields[sort]} ${direction.toUpperCase()}, id ${direction.toUpperCase()} LIMIT ? OFFSET ?`).all(...values, limit, (page - 1) * limit);
        return send(res, 200, { ok: true, data: { items: rows.map(apiFeedback) }, meta: { page, limit, total: count, pages: Math.ceil(count / limit) } }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/analytics/feedback") {
        const scoped = scopedAuth(req, appService, "feedback:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback read permission is required", requestId), true;
        const applicationId = scoped.context.applicationId;
        const totals = db.prepare("SELECT count(*) AS total, SUM(CASE WHEN status IN ('new','pending','in_progress') THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved, AVG(NULLIF(rating,0)) AS average_rating FROM feedback WHERE application_id=? AND deleted_at IS NULL").get(applicationId);
        const statuses = db.prepare("SELECT status,count(*) AS count FROM feedback WHERE application_id=? AND deleted_at IS NULL GROUP BY status ORDER BY status").all(applicationId);
        const categories = db.prepare("SELECT category,count(*) AS count FROM feedback WHERE application_id=? AND deleted_at IS NULL GROUP BY category ORDER BY category").all(applicationId);
        return send(res, 200, { ok: true, data: { total: totals.total, open: totals.open || 0, resolved: totals.resolved || 0, average_rating: totals.average_rating == null ? null : Number(totals.average_rating.toFixed(2)), statuses, categories } }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/feedback/export") {
        const scoped = scopedAuth(req, appService, "feedback:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback export permission is required", requestId), true;
        const format = url.searchParams.get("format") || "json";
        if (!["json", "csv"].includes(format)) return errorResponse(res, 400, "VALIDATION_ERROR", "format must be json or csv", requestId), true;
        const rows = db.prepare("SELECT id,application_id,category,title,message,rating,status,priority,created_at,updated_at,record_json FROM feedback WHERE application_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 10000").all(scoped.context.applicationId).map(apiFeedback);
        if (format === "json") return send(res, 200, { ok: true, data: { items: rows, truncated: rows.length === 10000 } }, requestId), true;
        const cell = (value) => {
          let text = String(value ?? "");
          if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
          return `"${text.replace(/"/g, '""')}"`;
        };
        const fields = ["id", "category", "title", "message", "rating", "status", "priority", "created_at", "updated_at"];
        const csv = [fields.join(","), ...rows.map((row) => fields.map((field) => cell(row[field])).join(","))].join("\r\n");
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=feedback-export.csv", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId });
        res.end(csv);
        return true;
      }

      const feedbackItem = pathname.match(/^\/api\/v1\/feedback\/([^/]+)$/);
      if (req.method === "DELETE" && feedbackItem) {
        const scoped = scopedAuth(req, appService, "feedback:manage");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback management permission is required", requestId), true;
        const deleted = eraseFeedback({ applicationId: scoped.context.applicationId, feedbackId: validId(feedbackItem[1]), actorType: "application" });
        if (!deleted) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        return send(res, 200, { ok: true, data: { deleted: true, feedback_id: validId(feedbackItem[1]) } }, requestId), true;
      }
      if (req.method === "PATCH" && feedbackItem) {
        const scoped = scopedAuth(req, appService, "feedback:manage");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback management permission is required", requestId), true;
        const id = validId(feedbackItem[1]);
        const input = await bodyJson(req);
        if ((input.status != null && !STATUSES.has(input.status)) || (input.priority != null && !["P1", "P2", "P3"].includes(input.priority))) return errorResponse(res, 400, "VALIDATION_ERROR", "status or priority is invalid", requestId), true;
        if (!Object.hasOwn(input, "status") && !Object.hasOwn(input, "priority")) return errorResponse(res, 400, "VALIDATION_ERROR", "status or priority is required", requestId), true;
        const current = db.prepare("SELECT * FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(id, scoped.context.applicationId);
        if (!current) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        const record = JSON.parse(current.record_json || "{}");
        const status = input.status ?? current.status;
        const priority = input.priority ?? current.priority;
        const now = clock().toISOString();
        record.status = status.toUpperCase(); record.priority = priority;
        withTransaction(db, () => {
          db.prepare("UPDATE feedback SET status=?, priority=?, updated_at=?, record_json=? WHERE id=? AND application_id=? AND deleted_at IS NULL")
            .run(status, priority, now, JSON.stringify(record), id, scoped.context.applicationId);
          webhookService?.enqueueEventInTransaction({ applicationId: scoped.context.applicationId, eventType: "feedback.updated", payload: { feedback_id: id, status, priority, updated_at: now } });
        });
        const row = db.prepare("SELECT * FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(id, scoped.context.applicationId);
        return send(res, 200, { ok: true, data: apiFeedback(row) }, requestId), true;
      }

      const messagesRoute = pathname.match(/^\/api\/v1\/feedback\/([^/]+)\/messages$/);
      if (messagesRoute && ["GET", "POST"].includes(req.method)) {
        const id = validId(messagesRoute[1]);
        const input = req.method === "POST" ? await bodyJson(req) : null;
        const privateNote = input?.private === true;
        const scoped = privateNote ? { context: null } : scopedAuth(req, appService, req.method === "POST" ? "feedback:manage" : "feedback:read");
        if (privateNote && !isPlatformAdmin(req)) return errorResponse(res, 401, "AUTH_REQUIRED", "Platform administrator access is required for private notes", requestId), true;
        if (!privateNote && !scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback conversation permission is required", requestId), true;
        const feedback = privateNote
          ? db.prepare("SELECT application_id FROM feedback WHERE id=? AND deleted_at IS NULL").get(id)
          : db.prepare("SELECT application_id FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(id, scoped.context.applicationId);
        if (!feedback) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        if (req.method === "GET") {
          const items = db.prepare("SELECT message_id, author_type, body, created_at FROM feedback_messages WHERE feedback_id=? AND application_id=? AND is_private=0 ORDER BY created_at, message_id").all(id, scoped.context.applicationId);
          return send(res, 200, { ok: true, data: { items } }, requestId), true;
        }
        const body = clean(input.body, 4000);
        if (!body) return errorResponse(res, 400, "VALIDATION_ERROR", "A message body is required", requestId), true;
        const messageId = `MSG-${crypto.randomUUID()}`;
        const createdAt = clock().toISOString();
        withTransaction(db, () => {
          db.prepare("INSERT INTO feedback_messages(message_id, feedback_id, application_id, author_type, is_private, body, created_at) VALUES(?,?,?,?,?,?,?)")
            .run(messageId, id, feedback.application_id, privateNote ? "admin" : "application", privateNote ? 1 : 0, body, createdAt);
          if (!privateNote) webhookService?.enqueueEventInTransaction({ applicationId: feedback.application_id, eventType: "feedback.replied", payload: { feedback_id: id, message_id: messageId, author_type: "application", created_at: createdAt } });
        });
        return send(res, 201, { ok: true, data: { message_id: messageId, feedback_id: id, body, private: privateNote, created_at: createdAt } }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/notifications") {
        const scoped = scopedAuth(req, appService, "notifications:write");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Notification write permission is required", requestId), true;
        const input = await bodyJson(req);
        const title = clean(input.title, 160), body = clean(input.body, 4000), type = clean(input.type || "announcement", 32);
        const locale = clean(input.locale || "en", 16);
        if ((!title || !body) && !input.template_key || !NOTIFICATION_TYPES.has(type)) return errorResponse(res, 400, "VALIDATION_ERROR", "title, body, or a valid template_key and a supported notification type are required", requestId), true;
        const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : clock();
        const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
        if (!Number.isFinite(scheduledAt.getTime()) || (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= scheduledAt))) return errorResponse(res, 400, "VALIDATION_ERROR", "Notification schedule or expiration is invalid", requestId), true;
        if (!notificationService) return errorResponse(res, 503, "NOTIFICATION_WORKER_UNAVAILABLE", "Notification delivery is not configured", requestId), true;
        const created = notificationService.create({ applicationId: scoped.context.applicationId, title, body, templateKey: input.template_key, variables: input.variables, type, locale, scheduledAt: scheduledAt.toISOString(), expiresAt: expiresAt?.toISOString() || null, idempotencyKey: input.idempotency_key || req.headers["idempotency-key"] || `auto-${crypto.randomUUID()}`, audience: input.audience || (Array.isArray(input.recipient_ids) && input.recipient_ids.length ? "selected" : "all"), recipientIds: input.recipient_ids, channel: input.channel || "in_app", workflowState: "draft", actorType: "application" });
        return send(res, created.status === "replayed" ? 200 : 201, { ok: true, data: created }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/notifications") {
        const scoped = scopedAuth(req, appService, "notifications:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Notification read permission is required", requestId), true;
        const recipientId = url.searchParams.get("recipient_id");
        const now = clock().toISOString();
        const items = recipientId && notificationService
          ? notificationService.list({ applicationId: scoped.context.applicationId, recipientId, unreadOnly: url.searchParams.get("unread") === "true" }).items
          : db.prepare("SELECT n.notification_id, n.application_id, n.title, n.body, n.notification_type AS type, n.locale, n.scheduled_at, n.expires_at, n.created_at, n.audience, n.channel, n.cancelled_at FROM notifications n WHERE n.application_id=? AND n.workflow_state='published' AND n.scheduled_at<=? AND (n.expires_at IS NULL OR n.expires_at>?) AND n.cancelled_at IS NULL ORDER BY n.scheduled_at DESC LIMIT 100")
            .all(scoped.context.applicationId, now, now);
        return send(res, 200, { ok: true, data: { items } }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/webhooks/register") {
        const scoped = scopedAuth(req, appService, "webhooks:manage");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Webhook management permission is required", requestId), true;
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        const input = await bodyJson(req);
        const created = await webhookService.register({ applicationId: scoped.context.applicationId, endpoint: input.endpoint, events: input.events });
        return send(res, 201, { ok: true, data: created }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/webhooks") {
        const scoped = scopedAuth(req, appService, "webhooks:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Webhook read permission is required", requestId), true;
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        return send(res, 200, { ok: true, data: { items: webhookService.listSubscriptions({ applicationId: scoped.context.applicationId }) } }, requestId), true;
      }

      const webhookAction = pathname.match(/^\/api\/v1\/webhooks\/([^/]+)\/(rotate|disable)$/);
      if (req.method === "POST" && webhookAction) {
        const scoped = scopedAuth(req, appService, "webhooks:manage");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Webhook management permission is required", requestId), true;
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        const webhookId = validId(webhookAction[1]);
        const result = webhookAction[2] === "rotate" ? webhookService.rotateSecret({ applicationId: scoped.context.applicationId, webhookId }) : webhookService.disable({ applicationId: scoped.context.applicationId, webhookId });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/webhooks/deliveries") {
        const scoped = scopedAuth(req, appService, "webhooks:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Webhook read permission is required", requestId), true;
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        return send(res, 200, { ok: true, data: { items: webhookService.deliveries({ applicationId: scoped.context.applicationId, limit: url.searchParams.get("limit") }) } }, requestId), true;
      }

      if (pathname === "/api/v1/fees/orders" && ["GET", "POST"].includes(req.method)) {
        const scope = req.method === "POST" ? "fees:create" : "fees:read";
        const scoped = scopedAuth(req, appService, scope);
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Fee order access is required", requestId), true;
        if (!feeLedger) return errorResponse(res, 503, "FEE_LEDGER_DISABLED", "Fee ledger is not configured", requestId), true;
        const applicationId = scoped.context.applicationId;
        if (req.method === "GET") return send(res, 200, { ok: true, data: { items: feeLedger.listOrders({ applicationId, limit: url.searchParams.get("limit") }) } }, requestId), true;
        if (paymentLimited(`fee-create:${applicationId}`)) return errorResponse(res, 429, "RATE_LIMITED", "Fee order creation rate limit exceeded", requestId), true;
        const input = await bodyJson(req);
        const created = feeLedger.createOrder({
          applicationId,
          idempotencyKey: input.idempotency_key || req.headers["idempotency-key"],
          orderReference: input.order_reference,
          amountSubunits: input.amount_subunits,
          amountScale: input.amount_scale,
          currency: input.currency,
          description: input.description,
          provider: input.provider,
          metadata: input.metadata,
        });
        return send(res, created.status === "replayed" ? 200 : 201, { ok: true, data: created }, requestId), true;
      }

      const feeHistory = pathname.match(/^\/api\/v1\/fees\/orders\/([^/]+)\/history$/);
      if (req.method === "GET" && feeHistory) {
        const scoped = scopedAuth(req, appService, "fees:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Fee history read permission is required", requestId), true;
        if (!feeLedger) return errorResponse(res, 503, "FEE_LEDGER_DISABLED", "Fee ledger is not configured", requestId), true;
        return send(res, 200, { ok: true, data: { items: feeLedger.history({ applicationId: scoped.context.applicationId, orderId: validId(feeHistory[1]) }) } }, requestId), true;
      }

      const feeOrder = pathname.match(/^\/api\/v1\/fees\/orders\/([^/]+)$/);
      if (req.method === "GET" && feeOrder) {
        const scoped = scopedAuth(req, appService, "fees:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Fee order read permission is required", requestId), true;
        if (!feeLedger) return errorResponse(res, 503, "FEE_LEDGER_DISABLED", "Fee ledger is not configured", requestId), true;
        const order = feeLedger.getOrder({ applicationId: scoped.context.applicationId, orderId: validId(feeOrder[1]) });
        if (!order) return errorResponse(res, 404, "FEE_ORDER_NOT_FOUND", "Fee order was not found", requestId), true;
        return send(res, 200, { ok: true, data: { order, service_delivery_allowed: feeLedger.canDeliver({ applicationId: scoped.context.applicationId, orderId: order.order_id }) } }, requestId), true;
      }

      const mockFeeSettlement = pathname.match(/^\/api\/v1\/fees\/orders\/([^/]+)\/settle-mock$/);
      if (req.method === "POST" && mockFeeSettlement) {
        const scoped = scopedAuth(req, appService, "fees:simulate");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Mock settlement permission is required", requestId), true;
        if (!feeLedger) return errorResponse(res, 503, "FEE_LEDGER_DISABLED", "Fee ledger is not configured", requestId), true;
        if (paymentLimited(`fee-settle:${scoped.context.applicationId}`)) return errorResponse(res, 429, "RATE_LIMITED", "Mock settlement rate limit exceeded", requestId), true;
        const input = await bodyJson(req);
        const result = feeLedger.mockSettle({ applicationId: scoped.context.applicationId, orderId: validId(mockFeeSettlement[1]), result: input.result || "paid" });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const webhookRetry = pathname.match(/^\/api\/v1\/webhooks\/deliveries\/([^/]+)\/retry$/);
      if (req.method === "POST" && webhookRetry) {
        const scoped = scopedAuth(req, appService, "webhooks:manage");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Webhook management permission is required", requestId), true;
        if (!webhookService) return errorResponse(res, 503, "WEBHOOKS_DISABLED", "Webhook encryption is not configured", requestId), true;
        return send(res, 200, { ok: true, data: webhookService.retryFailed({ applicationId: scoped.context.applicationId, deliveryId: validId(webhookRetry[1]) }) }, requestId), true;
      }

      const notificationAction = pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/(read|cancel|retry)$/);
      if (notificationAction && req.method === "POST") {
        const action = notificationAction[2];
        const scope = action === "read" ? "notifications:read" : "notifications:write";
        const scoped = scopedAuth(req, appService, scope);
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Notification access is required", requestId), true;
        if (!notificationService) return errorResponse(res, 503, "NOTIFICATION_WORKER_UNAVAILABLE", "Notification delivery is not configured", requestId), true;
        const id = validId(notificationAction[1]);
        const input = action === "read" ? await bodyJson(req) : {};
        const result = action === "read"
          ? notificationService.markRead({ applicationId: scoped.context.applicationId, notificationId: id, recipientId: input.recipient_id })
          : action === "cancel" ? notificationService.cancel({ applicationId: scoped.context.applicationId, notificationId: id })
            : notificationService.retryFailed({ applicationId: scoped.context.applicationId, notificationId: id });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const attachmentUpload = pathname.match(/^\/api\/v1\/feedback\/([^/]+)\/attachments$/);
      if (req.method === "POST" && attachmentUpload) {
        const scoped = scopedAuth(req, appService, "feedback:manage");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback attachment upload permission is required", requestId), true;
        if (!attachmentService) return errorResponse(res, 503, "UPLOADS_DISABLED", "Attachment storage is not configured", requestId), true;
        if (limited(`attachment:${scoped.context.applicationId}:${keyFromRequest(req)}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many attachments", requestId), true;
        const declaredMime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const bytes = await bodyBuffer(req, MAX_ATTACHMENT_BYTES);
        const saved = attachmentService.store({ applicationId: scoped.context.applicationId, feedbackId: validId(attachmentUpload[1]), originalName: url.searchParams.get("filename"), declaredMime, bytes });
        return send(res, 201, { ok: true, data: saved }, requestId), true;
      }

      const attachmentDownload = pathname.match(/^\/api\/v1\/feedback\/([^/]+)\/attachments\/([^/]+)$/);
      if (req.method === "GET" && attachmentDownload) {
        const scoped = scopedAuth(req, appService, "feedback:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Feedback attachment read permission is required", requestId), true;
        if (!attachmentService) return errorResponse(res, 503, "UPLOADS_DISABLED", "Attachment storage is not configured", requestId), true;
        const attachment = attachmentService.read({ applicationId: scoped.context.applicationId, feedbackId: validId(attachmentDownload[1]), attachmentId: validId(attachmentDownload[2]) });
        res.writeHead(200, { "Content-Type": attachment.mime_type, "Content-Length": attachment.bytes.length, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId });
        res.end(attachment.bytes);
        return true;
      }

      if (req.method === "GET" && feedbackItem) {
        const scoped = scopedAuth(req, appService, "feedback:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED",
          scoped.status === 401 ? "A valid application credential is required" : "Credential does not include feedback:read scope", requestId), true;
        const auth = scoped.context;
        const id = validId(feedbackItem[1]);
        const row = id && db.prepare(`SELECT id, application_id, category, title, message, rating, status, priority, created_at, updated_at, record_json
          FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL`).get(id, auth.applicationId);
        if (!row) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        return send(res, 200, { ok: true, data: apiFeedback(row) }, requestId), true;
      }

      if (req.method === "POST" && pathname === "/api/v1/payments/create") {
        const scoped = scopedAuth(req, appService, "payments:create");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Payment session creation permission is required", requestId), true;
        const input = await bodyJson(req);
        const amount = Number(input.amount);
        const amountMicros = Math.round(amount * 10_000_000);
        const memo = clean(input.memo, 256);
        const orderReference = clean(input.order_reference, 128);
        const idempotencyKey = String(input.idempotency_key || req.headers["idempotency-key"] || "").trim();
        const feeOrderId = input.fee_order_id == null ? null : clean(input.fee_order_id, 80);
        const metadata = input.metadata == null ? {} : input.metadata;
        const metadataJson = JSON.stringify(metadata);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 || Math.abs(amount * 10_000_000 - amountMicros) > 0.00001 || !memo || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) || feeOrderId && !/^FO-[A-Za-z0-9-]{36}$/.test(feeOrderId) || !metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.hasOwn(metadata, "hub_session_id") || Object.hasOwn(metadata, "fee_order_id") || Buffer.byteLength(metadataJson) > 8192) return errorResponse(res, 400, "VALIDATION_ERROR", "amount, memo, fee_order_id, idempotency_key, or metadata is invalid", requestId), true;
        if (feeOrderId && !feeLedger) return errorResponse(res, 503, "FEE_LEDGER_DISABLED", "Fee ledger is not configured", requestId), true;
        const appId = scoped.context.applicationId;
        const session = withTransaction(db, () => {
          const existing = db.prepare("SELECT * FROM payment_sessions WHERE application_id=? AND idempotency_key=?").get(appId, idempotencyKey);
          if (existing) {
            if (existing.amount_micros !== amountMicros || existing.memo !== memo || existing.order_reference !== orderReference || existing.metadata_json !== metadataJson || existing.fee_order_id !== feeOrderId) throw Object.assign(new Error("Idempotency key was already used with different payment details"), { code: "IDEMPOTENCY_CONFLICT" });
            return { row: existing, replay: true };
          }
          if (feeOrderId) {
            const order = feeLedger.getOrder({ applicationId: appId, orderId: feeOrderId });
            if (!order) throw Object.assign(new Error("Fee order was not found"), { code: "FEE_ORDER_NOT_FOUND" });
            if (order.provider !== "pi" || order.status !== "pending" || order.currency !== "PI" || order.amount_scale !== 7 || order.amount_subunits !== amountMicros) throw Object.assign(new Error("Pi payment must exactly match an unbound pending Pi fee order"), { code: "FEE_ORDER_MISMATCH" });
            if (db.prepare("SELECT 1 FROM payment_sessions WHERE application_id=? AND fee_order_id=?").get(appId, feeOrderId)) throw Object.assign(new Error("Fee order is already bound to a Pi session"), { code: "FEE_ORDER_MISMATCH" });
          }
          const now = clock().toISOString();
          const sessionId = `PS-${crypto.randomUUID()}`;
          db.prepare("INSERT INTO payment_sessions(session_id, application_id, idempotency_key, amount_micros, memo, metadata_json, order_reference, status, created_at, updated_at, fee_order_id) VALUES(?,?,?,?,?,?,?,'created',?,?,?)")
            .run(sessionId, appId, idempotencyKey, amountMicros, memo, metadataJson, orderReference, now, now, feeOrderId);
          webhookService?.enqueueEventInTransaction({ applicationId: appId, eventType: "payment.created", payload: { session_id: sessionId, fee_order_id: feeOrderId, amount: amountMicros / 10_000_000, order_reference: orderReference, status: "created", verification_state: "unverified" } });
          return { row: db.prepare("SELECT * FROM payment_sessions WHERE session_id=?").get(sessionId), replay: false };
        });
        const configured = piPaymentService?.configuration(appId);
        const data = { session_id: session.row.session_id, application_id: appId, fee_order_id: session.row.fee_order_id || null, amount: session.row.amount_micros / 10_000_000, amount_unit: "Pi", memo: session.row.memo, metadata: { ...JSON.parse(session.row.metadata_json), hub_session_id: session.row.session_id, ...(session.row.fee_order_id ? { fee_order_id: session.row.fee_order_id } : {}) }, pi: configured?.enabled ? { configured: true, app_id: configured.pi_app_id, network: configured.network } : { configured: false }, order_reference: session.row.order_reference, status: session.row.status, verification_state: "unverified", created_at: session.row.created_at };
        return send(res, session.replay ? 200 : 201, { ok: true, data }, requestId), true;
      }

      const paymentApproval = pathname.match(/^\/api\/v1\/payments\/([^/]+)\/approve$/);
      if (req.method === "POST" && paymentApproval) {
        const scoped = scopedAuth(req, appService, "payments:create");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Payment approval permission is required", requestId), true;
        if (paymentLimited(`pi-approval:${scoped.context.applicationId}`)) return errorResponse(res, 429, "RATE_LIMITED", "Pi payment approval rate limit exceeded", requestId), true;
        if (!piPaymentService) return errorResponse(res, 503, "PI_PAYMENTS_DISABLED", "Pi payment verification is not configured", requestId), true;
        const input = await bodyJson(req);
        const result = await piPaymentService.approve({ applicationId: scoped.context.applicationId, sessionId: validId(paymentApproval[1]), paymentId: input.payment_id, userAccessToken: input.user_access_token });
        return send(res, 200, { ok: true, data: result }, requestId), true;
      }

      const paymentCompletion = pathname.match(/^\/api\/v1\/payments\/([^/]+)\/complete$/);
      if (req.method === "POST" && paymentCompletion) {
        const scoped = scopedAuth(req, appService, "payments:create");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Payment completion permission is required", requestId), true;
        if (paymentLimited(`pi-completion:${scoped.context.applicationId}`)) return errorResponse(res, 429, "RATE_LIMITED", "Pi payment completion rate limit exceeded", requestId), true;
        if (!piPaymentService) return errorResponse(res, 503, "PI_PAYMENTS_DISABLED", "Pi payment verification is not configured", requestId), true;
        const input = await bodyJson(req);
        const applicationId = scoped.context.applicationId, sessionId = validId(paymentCompletion[1]);
        const result = await piPaymentService.complete({ applicationId, sessionId, paymentId: input.payment_id, txid: input.txid });
        const session = db.prepare("SELECT fee_order_id FROM payment_sessions WHERE application_id=? AND session_id=?").get(applicationId, sessionId);
        const serviceDeliveryAllowed = session?.fee_order_id
          ? Boolean(feeLedger?.canDeliver({ applicationId, orderId: session.fee_order_id }))
          : result.status === "completed" && result.verification_state === "verified";
        return send(res, 200, { ok: true, data: { ...result, fee_order_id: session?.fee_order_id || null, service_delivery_allowed: serviceDeliveryAllowed } }, requestId), true;
      }

      const paymentSession = pathname.match(/^\/api\/v1\/payments\/([^/]+)$/);
      if (req.method === "GET" && paymentSession) {
        const scoped = scopedAuth(req, appService, "payments:read");
        if (!scoped.context) return errorResponse(res, scoped.status, scoped.status === 401 ? "AUTH_REQUIRED" : "SCOPE_REQUIRED", "Payment read permission is required", requestId), true;
        const session = db.prepare("SELECT * FROM payment_sessions WHERE session_id=? AND application_id=?").get(validId(paymentSession[1]), scoped.context.applicationId);
        if (!session) return errorResponse(res, 404, "PAYMENT_SESSION_NOT_FOUND", "Payment session was not found", requestId), true;
        const transaction = db.prepare("SELECT pi_payment_id,txid,status,verification_state,failure_code FROM payment_transactions WHERE application_id=? AND session_id=?").get(scoped.context.applicationId, session.session_id);
        const deliveryAllowed = session.fee_order_id
          ? Boolean(feeLedger?.canDeliver({ applicationId: scoped.context.applicationId, orderId: session.fee_order_id }))
          : transaction?.status === "completed" && transaction?.verification_state === "verified";
        return send(res, 200, { ok: true, data: { session_id: session.session_id, application_id: session.application_id, fee_order_id: session.fee_order_id || null, amount: session.amount_micros / 10_000_000, amount_unit: "Pi", memo: session.memo, metadata: { ...JSON.parse(session.metadata_json), hub_session_id: session.session_id, ...(session.fee_order_id ? { fee_order_id: session.fee_order_id } : {}) }, order_reference: session.order_reference, payment_id: transaction?.pi_payment_id || null, txid: transaction?.txid || null, status: transaction?.status || session.status, verification_state: transaction?.verification_state || "unverified", service_delivery_allowed: Boolean(deliveryAllowed), failure_code: transaction?.failure_code || null, created_at: session.created_at, updated_at: session.updated_at } }, requestId), true;
      }

      if (req.method === "GET" && pathname === "/api/v1/customer/feedback") {
        const token = parseBearer(req);
        if (!/^fhcust_[A-Za-z0-9_-]{40,60}$/.test(token || "")) return errorResponse(res, 401, "CUSTOMER_AUTH_REQUIRED", "A valid feedback follow-up token is required", requestId), true;
        const digest = crypto.createHash("sha256").update(token).digest("hex");
        const access = db.prepare(`SELECT t.token_id,t.application_id,t.feedback_id,f.category,f.title,f.message,f.rating,f.status,f.created_at,f.updated_at FROM feedback_access_tokens t JOIN feedback f ON f.id=t.feedback_id AND f.application_id=t.application_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND f.deleted_at IS NULL`).get(digest, clock().toISOString());
        if (!access) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        db.prepare("UPDATE feedback_access_tokens SET last_used_at=? WHERE token_id=?").run(clock().toISOString(), access.token_id);
        const messages = db.prepare("SELECT message_id,author_type,body,created_at FROM feedback_messages WHERE feedback_id=? AND application_id=? AND is_private=0 ORDER BY created_at,message_id").all(access.feedback_id, access.application_id);
        const attachments = db.prepare("SELECT attachment_id,original_name,mime_type,size_bytes,created_at FROM feedback_attachments WHERE feedback_id=? AND application_id=? ORDER BY created_at").all(access.feedback_id, access.application_id);
        return send(res, 200, { ok: true, data: { id: access.feedback_id, category: access.category, title: access.title, message: access.message, rating: access.rating, status: access.status, created_at: access.created_at, updated_at: access.updated_at, messages, attachments } }, requestId), true;
      }

      const customerFeedbackRoute = pathname.match(/^\/api\/v1\/customer\/feedback\/([^/]+)(?:\/(messages|attachments\/([^/]+)))?$/);
      if (customerFeedbackRoute && ["GET", "POST", "DELETE"].includes(req.method)) {
        const id = validId(customerFeedbackRoute[1]);
        const token = parseBearer(req);
        if (!/^fhcust_[A-Za-z0-9_-]{40,60}$/.test(token || "")) return errorResponse(res, 401, "CUSTOMER_AUTH_REQUIRED", "A valid feedback follow-up token is required", requestId), true;
        const digest = crypto.createHash("sha256").update(token).digest("hex");
        const access = db.prepare(`SELECT t.token_id, t.application_id, t.feedback_id, f.category, f.title, f.message, f.rating, f.status, f.created_at, f.updated_at
          FROM feedback_access_tokens t JOIN feedback f ON f.id=t.feedback_id AND f.application_id=t.application_id
          WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND f.deleted_at IS NULL`).get(digest, clock().toISOString());
        if (!access || access.feedback_id !== id) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
        db.prepare("UPDATE feedback_access_tokens SET last_used_at=? WHERE token_id=?").run(clock().toISOString(), access.token_id);
        const messagesPath = Boolean(customerFeedbackRoute[2]);
        if (req.method === "DELETE") {
          if (messagesPath) return errorResponse(res, 405, "METHOD_NOT_ALLOWED", "Only the feedback record can be deleted", requestId), true;
          if (!eraseFeedback({ applicationId: access.application_id, feedbackId: id, actorType: "customer" })) return errorResponse(res, 404, "FEEDBACK_NOT_FOUND", "Feedback was not found", requestId), true;
          return send(res, 200, { ok: true, data: { deleted: true } }, requestId), true;
        }
        if (req.method === "GET" && customerFeedbackRoute[3]) {
          if (!attachmentService) return errorResponse(res, 503, "UPLOADS_DISABLED", "Attachment storage is not configured", requestId), true;
          const attachment = attachmentService.readForCustomer({ feedbackId: id, attachmentId: validId(customerFeedbackRoute[3]) });
          res.writeHead(200, { "Content-Type": attachment.mime_type, "Content-Length": attachment.bytes.length, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId });
          res.end(attachment.bytes);
          return true;
        }
        if (req.method === "GET") {
          const items = db.prepare("SELECT message_id, author_type, body, created_at FROM feedback_messages WHERE feedback_id=? AND application_id=? AND is_private=0 ORDER BY created_at, message_id").all(id, access.application_id);
          if (messagesPath) return send(res, 200, { ok: true, data: { items } }, requestId), true;
          const attachments = db.prepare("SELECT attachment_id,original_name,mime_type,size_bytes,created_at FROM feedback_attachments WHERE feedback_id=? AND application_id=? ORDER BY created_at").all(id, access.application_id);
          return send(res, 200, { ok: true, data: { id, category: access.category, title: access.title, message: access.message, rating: access.rating, status: access.status, created_at: access.created_at, updated_at: access.updated_at, messages: items, attachments } }, requestId), true;
        }
        if (!messagesPath) return errorResponse(res, 405, "METHOD_NOT_ALLOWED", "Customer feedback only accepts replies at the messages route", requestId), true;
        if (limited(`customer-reply:${access.token_id}`)) return errorResponse(res, 429, "RATE_LIMITED", "Too many replies", requestId), true;
        const input = await bodyJson(req);
        const body = clean(input.body, 4000);
        if (!body) return errorResponse(res, 400, "VALIDATION_ERROR", "A message body is required", requestId), true;
        const messageId = `MSG-${crypto.randomUUID()}`;
        const createdAt = clock().toISOString();
        withTransaction(db, () => {
          db.prepare("INSERT INTO feedback_messages(message_id, feedback_id, application_id, author_type, is_private, body, created_at) VALUES(?,?,?,'customer',0,?,?)")
            .run(messageId, id, access.application_id, body, createdAt);
          webhookService?.enqueueEventInTransaction({ applicationId: access.application_id, eventType: "feedback.replied", payload: { feedback_id: id, message_id: messageId, author_type: "customer", created_at: createdAt } });
        });
        return send(res, 201, { ok: true, data: { message_id: messageId, feedback_id: id, body, created_at: createdAt } }, requestId), true;
      }

      if (pathname.startsWith("/api/v1/")) return errorResponse(res, 404, "NOT_FOUND", "API endpoint was not found", requestId), true;
      return false;
    } catch (error) {
      const status = Number(error?.http) || ({ APP_EXISTS: 409, APP_NOT_FOUND: 404, APP_NOT_APPROVED: 409, APP_NOT_APPROVABLE: 409, INVALID_APP: 400, INVALID_SCOPES: 400, DUPLICATE_FEEDBACK: 409, IDEMPOTENCY_CONFLICT: 409, FEEDBACK_NOT_FOUND: 404, ATTACHMENT_NOT_FOUND: 404, UNSAFE_ATTACHMENT: 400, INVALID_WEBHOOK_URL: 400, UNSAFE_WEBHOOK_DESTINATION: 400, INVALID_WEBHOOK_EVENTS: 400, WEBHOOK_NOT_FOUND: 404, WEBHOOK_DELIVERY_NOT_RETRYABLE: 409, INVALID_NOTIFICATION: 400, INVALID_NOTIFICATION_TEMPLATE: 400, NOTIFICATION_TEMPLATE_NOT_FOUND: 404, INVALID_RECIPIENTS: 400, INVALID_SCHEDULE: 400, NOTIFICATION_NOT_FOUND: 404, NO_FAILED_DELIVERIES: 409, INVALID_EMAIL: 400, INVALID_PASSWORD: 400, INVALID_ROLE: 400, INVITE_INVALID: 401, OWNER_LOGIN_FAILED: 401, OWNER_SESSION_INVALID: 401, OWNER_SESSION_EXPIRED: 401, OWNER_DISABLED: 403, CSRF_REJECTED: 403, ROLE_REQUIRED: 403, APP_ACCESS_DENIED: 404, APP_NOT_AVAILABLE: 404, RESET_INVALID: 401, MEMBER_NOT_FOUND: 404, LAST_OWNER: 409, PI_NOT_CONFIGURED: 409, PI_PAYMENT_MISMATCH: 409, PI_PAYMENT_CONFLICT: 409, PI_APPROVAL_UNCONFIRMED: 502, PI_TRANSACTION_UNVERIFIED: 409, PI_COMPLETION_UNCONFIRMED: 502, PI_PLATFORM_ERROR: 502, PI_PLATFORM_TIMEOUT: 502, PI_PLATFORM_UNAVAILABLE: 502, PAYMENT_SESSION_NOT_FOUND: 404, PAYMENT_NOT_APPROVED: 409, INVALID_PI_CONFIG: 400, INVALID_PAYMENT_ID: 400, INVALID_TXID: 400, INVALID_USER_TOKEN: 401, PI_USER_UNVERIFIED: 401, INVALID_ORDER: 400, INVALID_PROVIDER_EVENT: 400, FEE_ORDER_NOT_FOUND: 404, ORDER_NOT_FOUND: 404, ORDER_TERMINAL: 409, FEE_ORDER_MISMATCH: 409, FEE_ORDER_NOT_PAID: 409, PROVIDER_EVENT_CONFLICT: 409, PROVIDER_MISMATCH: 409, MOCK_PROVIDER_DISABLED: 503 }[error?.code]) || 500;
      const code = error?.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED");
      const message = status === 500 ? "The request could not be completed" : String(error.message || "Request failed");
      return errorResponse(res, status, code, message, requestId), true;
    }
  };
}
