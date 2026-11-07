import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./lib/db.js";
import { createSqliteCompatStore } from "./lib/sqlite-compat-store.js";
import { importJsonData } from "./lib/json-import.js";
import { createAppService } from "./lib/apps.js";
import { createApiV1 } from "./lib/api-v1.js";
import { attachGracefulShutdown } from "./lib/lifecycle.js";
import { createNotificationService, startNotificationWorker } from "./lib/notifications.js";
import { createSecretBox } from "./lib/secret-box.js";
import { createWebhookService, startWebhookWorker } from "./lib/webhooks.js";
import { createOwnerService } from "./lib/owners.js";
import { createPiPaymentService, startPiReconciliationWorker } from "./lib/pi-payments.js";
import { createFeeLedgerService, startFeeReconciliationWorker } from "./lib/fee-ledger.js";
import { TYPES, STATUSES, localClassify, scoreApp } from "./lib/classify.js";
import { createSettings, DEFAULT_DONATE } from "./lib/settings.js";
import { createAdminSessionStore } from "./lib/admin-sessions.js";
import { isLoopbackAddress } from "./lib/network-address.js";
import { buildInsights, applyAiWording } from "./lib/insights.js";
import { catalogPublic, detectProviderFromToken, modelsFor } from "./lib/ai-catalog.js";
import { createAiKernel, createActionRegistry, createCustomStore } from "./ai-app-kernel/src/index.js";
import { verifyProvider } from "./ai-app-kernel/src/providers.js";
import { createRequire } from "node:module";
import * as appAdapter from "./lib/app-adapter.js";

const require = createRequire(import.meta.url);
const { createAIService } = require("./lib/ai-module/ai-service.cjs");
const { createFeedbackService } = require("./lib/feedback-module/feedback-service.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const hasSetupPort = process.env.SETUP_PORT !== undefined;
const SETUP_PORT = hasSetupPort ? Number(process.env.SETUP_PORT) : 0;
const HUB_ID = process.env.SHFH_HUB_ID || process.env.HUB_ID || "SHFH-CANNOI-0905428801";
const PUBLIC_BASE_URL = process.env.SHFH_HUB_URL || process.env.PUBLIC_BASE_URL || "";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const PI_WALLET = process.env.PI_WALLET || DEFAULT_DONATE.pi_wallet;
const MB_BANK = process.env.MB_BANK || DEFAULT_DONATE.mb_bank;
const MB_ACCOUNT = process.env.MB_ACCOUNT || DEFAULT_DONATE.mb_account;
const MB_NAME = process.env.MB_NAME || DEFAULT_DONATE.mb_name;
const MAX_BODY = 160 * 1024;
const RATE_WINDOW = 60 * 60 * 1000;
const RATE_LIMIT = 20;

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
function applyAiEnv(s) {
  const st = s || (typeof settings !== "undefined" ? settings.get() : null);
  if (!st) return;
  const ids = ["xai", "openai", "gemini", "openrouter", "mistral", "deepseek", "groq"];
  for (const id of ids) delete process.env[`${id.toUpperCase()}_API_KEY`];
  const provider = String(st.ai?.provider || "").toLowerCase();
  if (provider) process.env.AI_PROVIDER = provider;
  if (st.ai?.model) process.env.AI_MODEL = st.ai.model;
  if (st.ai?.local_base_url) process.env.LOCAL_AI_BASE_URL = st.ai.local_base_url;
  if (st.ai?.api_key) {
    process.env.AI_API_KEY = st.ai.api_key;
    if (provider && !["ollama", "lmstudio", "local"].includes(provider)) {
      process.env[`${provider.toUpperCase()}_API_KEY`] = st.ai.api_key;
    }
  }
}
const database = openDatabase({ dataDir, migrationsDir: path.join(__dirname, "db/migrations") });
importJsonData({ db: database.db, dataDir });
const db = createSqliteCompatStore(database.db);
const settings = createSettings(dataDir, process.env);
if (Object.hasOwn(process.env, "ADMIN_INITIAL_PASSWORD")) {
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
  delete process.env.ADMIN_INITIAL_PASSWORD;
  if (!settings.hasPassword() && initialPassword) settings.bootstrapAdminPassword(initialPassword);
}
applyAiEnv();

// Universal AI + Feedback modules (Snake Arcade style)
const universalAI = createAIService({
  dataDir,
  appName: "SoloHost Feedback Hub",
  adapter: appAdapter,
});
const feedbackOptions = {
  appId: "solohost-feedback-hub",
  appName: "SoloHost Feedback Hub",
  version: "2.5.1",
  hubId: HUB_ID,
  baseUrl: PUBLIC_BASE_URL,
};
if (process.env.SHFH_INGEST_TOKEN) feedbackOptions.ingestToken = process.env.SHFH_INGEST_TOKEN;
const universalFB = createFeedbackService(feedbackOptions);

const hits = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;
const adminSessions = createAdminSessionStore({ ttlMs: SESSION_TTL });
const appService = createAppService(database.db);
const ownerService = createOwnerService({ db: database.db });
const encryptionKey = process.env.HUB_ENCRYPTION_KEY || process.env.WEBHOOK_ENCRYPTION_KEY || "";
const secretBox = encryptionKey ? createSecretBox(encryptionKey) : null;
const webhookService = secretBox ? createWebhookService({ db: database.db, secretBox }) : null;
const feeLedger = createFeeLedgerService({ db: database.db, webhookService, mockPaymentsEnabled: process.env.FEE_MOCK_PAYMENTS === "true" });
const piPaymentService = secretBox ? createPiPaymentService({ db: database.db, secretBox, webhookService, feeLedger }) : null;
const notificationService = createNotificationService({ db: database.db, webhookService });
const stopNotificationWorker = startNotificationWorker({ service: notificationService, onError: (code) => console.error(`Notification worker error: ${code}`) });
const stopWebhookWorker = webhookService ? startWebhookWorker({ service: webhookService, onError: (code) => console.error(`Webhook worker error: ${code}`) }) : async () => {};
const stopPiWorker = piPaymentService ? startPiReconciliationWorker({ service: piPaymentService, onError: (code) => console.error(`Pi reconciliation error: ${code}`) }) : async () => {};
const stopFeeWorker = startFeeReconciliationWorker({ service: feeLedger, onError: (code) => console.error(`Fee reconciliation error: ${code}`) });
const apiV1 = createApiV1({ db: database.db, appService, notificationService, webhookService, ownerService, piPaymentService, feeLedger, isPlatformAdmin: admin, uploadDir: path.join(dataDir, "uploads") });

function parseCookie(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return {}; }
    }
  }
  return out;
}
function sessionOk(req) {
  const sid = parseCookie(req).SHFH_SESSION;
  return adminSessions.has(sid);
}
function setSession(res, req) {
  const sid = adminSessions.create();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const secure = Boolean(req.socket.encrypted) || forwardedProto === "https";
  res.setHeader("Set-Cookie", `SHFH_SESSION=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? "; Secure" : ""}`);
  return sid;
}
function setupConnectionAllowed(req) {
  return isLoopbackAddress(req.socket.remoteAddress) || (SETUP_PORT > 0 && req.socket.localPort === SETUP_PORT);
}

function clean(v, n = 4000) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, n);
}
function redact(s) {
  return String(s || "")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_SECRET]")
    .replace(/\b(?:api[_ -]?key|token|secret|password|private[_ -]?key)\s*[:=]\s*[^\s,;]{8,}/gi, "$1=[REDACTED_SECRET]")
    .replace(/\b(?:seed phrase|recovery phrase)\b[^.!?\n]{0,200}/gi, "[REDACTED_SENSITIVE]");
}
const PUBLIC_API = new Set([
  "/api/health", "/api/config", "/api/sdk.js", "/api/client-policy",
  "/api/feedback", "/api/notices", "/api/updates", "/api/session",
]);
function isPublicPath(p) {
  if (PUBLIC_API.has(p)) return true;
  if (p.startsWith("/api/notices/")) return true;
  if (p === "/api/sdk.js" || p.startsWith("/client/")) return true;
  return false;
}
let activePath = "";
function send(res, code, obj, reqPath) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
  const p = reqPath || activePath;
  if (isPublicPath(p)) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,OPTIONS";
  }
  const cookie = res.getHeader("Set-Cookie");
  if (cookie) headers["Set-Cookie"] = cookie;
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}
function text(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
function bearer(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}
function equal(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function admin(req) {
  if (sessionOk(req)) return true;
  const tok = bearer(req);
  if (tok && settings.checkPassword(tok)) return true;
  return false;
}
function ingest(req) {
  const need = settings.ingestToken();
  return !need || equal(bearer(req), need);
}
function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x").split(",")[0].trim();
}
function limited(req, max = RATE_LIMIT, windowMs = RATE_WINDOW, bucket = "ing", key = clientKey(req)) {
  const k = bucket + ":" + key;
  const now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < windowMs);
  a.push(now); hits.set(k, a);
  return a.length > max;
}
function pendingAppLimit(req, input) {
  const appId = (clean(input.app_id, 64) || "unknown").toLowerCase();
  const storedApp = database.db.prepare("SELECT integration_status FROM applications WHERE application_id=?").get(appId);
  if (storedApp?.integration_status === "disabled") return { status: 410, error: "This app has been removed" };
  const app = db.read("apps").find((item) => item.app_id === appId);
  const needsApproval = !app || app.approval_status === "pending" || app.integration_status === "pending";
  if (!needsApproval) {
    input.app_id = appId;
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(appId)) return { status: 400, error: "New app IDs must be 2–64 character slugs" };
  if (limited(req, 1, 60 * 60 * 1000, `new-app:${appId}`)) {
    return { status: 429, error: "Unapproved apps may submit once per hour per client" };
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = database.db.prepare("SELECT count(*) AS total FROM feedback WHERE application_id=? AND created_at>=?").get(appId, since).total;
  if (recent >= 5) return { status: 429, error: "Unapproved apps are limited to five feedback submissions per day" };
  input.app_id = appId;
  return null;
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = "", n = 0, too = false;
    req.on("data", (c) => { n += c.length; if (n <= MAX_BODY) s += c; else too = true; });
    req.on("end", () => {
      if (too) return resolve({ too: true });
      try { resolve({ json: JSON.parse(s || "{}") }); } catch { resolve({ bad: true }); }
    });
  });
}
function nid(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
function templates() {
  return {
    thanks: "Cảm ơn bạn đã gửi phản hồi. Hub đã ghi nhận và sẽ dùng để quyết định nâng cấp.",
    payment_ok: "Thanh toán / ủng hộ đã được ghi nhận. Cảm ơn bạn đã nuôi dự án.",
    unpaid_nudge: "App này đang miễn phí để dùng thử. Nếu thấy hữu ích, hãy ủng hộ dự án (Pi Wallet hoặc MB Bank) để giữ app sống.",
    update_ack: "ÄÃ£ cÃ³ báº£n cáº­p nháº­t má»›i. Má»Ÿ pháº§n Updates trong app Ä‘á»ƒ xem chi tiáº¿t.",
  };
}

function ensureApp(p) {
  const app_id = (clean(p.app_id, 64) || "unknown").toLowerCase();
  const existing = db.read("apps").find((a) => a.app_id === app_id);
  if (!existing) {
    db.upsertApp({
      app_id,
      app_name: clean(p.app_name, 120) || app_id,
      category: clean(p.category, 60) || "general",
      status: "pending",
      approval_status: "pending",
    });
  }
  return app_id;
}

function addNotice({ app_id, anonymous_id, kind, title, body, extra }) {
  const row = {
    id: nid("NT"),
    app_id,
    anonymous_id: anonymous_id || "",
    kind,
    title,
    body,
    extra: extra || {},
    read: false,
    created_at: new Date().toISOString(),
  };
  const all = db.read("notices");
  all.push(row);
  db.write("notices", all);
  return row;
}

function ingestEvent(p, req) {
  const event = clean(p.event || "feedback", 40);
  if (event === "feedback" && !clean(p.message, 4000)) throw Object.assign(new Error("Message is required"), { http: 400 });
  const app_id = ensureApp(p);
  const tpls = templates();

  if (event === "payment") {
    const pay = {
      id: nid("PAY"),
      app_id,
      app_name: clean(p.app_name, 120) || app_id,
      anonymous_id: clean(p.anonymous_id, 120),
      txn_id: clean(p.license?.txn_id || p.txn_id, 120),
      method: clean(p.license?.method || p.method, 40) || "unknown",
      amount: clean(p.license?.amount || p.amount, 40),
      status: "legacy_unverified",
      verification_state: "legacy_unverified",
      created_at: new Date().toISOString(),
    };
    const pays = db.read("payments"); pays.push(pay); db.write("payments", pays);
    return { ok: true, kind: "payment", id: pay.id, status: "legacy_unverified", notice: null };
  }

  const row = {
    id: nid("FB"),
    schema_version: "2.0",
    event,
    app_id,
    app_name: clean(p.app_name, 120) || app_id,
    version: clean(p.version, 60),
    platform: clean(p.platform, 40) || "solohost",
    type: TYPES.includes(p.type) ? p.type : "improvement",
    rating: Number(p.rating) || 0,
    message: redact(clean(p.message, 4000)),
    anonymous_id: clean(p.anonymous_id, 120),
    license: {
      paid: Boolean(p.license?.paid),
      plan: clean(p.license?.plan, 40) || "free",
      txn_id: clean(p.license?.txn_id, 120),
      state: clean(p.license?.state, 40) || (p.license?.paid ? "supporter" : "unknown"),
      method: clean(p.license?.method, 40),
      paid_until: clean(p.license?.paid_until, 40),
    },
    installed_at: clean(p.installed_at, 40),
    locale: clean(p.locale, 12) || "vi",
    user_agent: clean(req.headers["user-agent"], 300),
    created_at: new Date().toISOString(),
    status: "NEW",
    ai: localClassify({ ...p, app_id }),
  };
  const items = db.read("feedback"); items.push(row); db.write("feedback", items);

  const notice = addNotice({
    app_id, anonymous_id: row.anonymous_id, kind: "thanks",
    title: "Cảm ơn phản hồi", body: tpls.thanks, extra: { feedback_id: row.id },
  });

  const app = db.read("apps").find((a) => a.app_id === app_id);
  if (app?.fee_required && !row.license.paid) {
    addNotice({
      app_id, anonymous_id: row.anonymous_id, kind: "unpaid_nudge",
      title: "Ủng hộ dự án", body: tpls.unpaid_nudge,
    });
  }
  return { ok: true, id: row.id, status: row.status, ai: row.ai, notice };
}

const storeAdapter = createCustomStore({
  async listCollections() { return ["apps", "feedback", "updates", "notices", "payments"]; },
  async list(name, filter = {}) {
    return db.read(name).filter((row) => Object.entries(filter).every(([k, v]) => String(row?.[k]) === String(v)));
  },
  async get(name, id) { return db.read(name).find((r) => r.id === id || r.app_id === id) || null; },
  async put(name, record) {
    const rows = db.read(name);
    const id = record.id || record.app_id;
    const i = rows.findIndex((r) => r.id === id || r.app_id === id);
    if (i >= 0) rows[i] = { ...rows[i], ...record };
    else rows.push(record);
    db.write(name, rows);
    return record;
  },
  async delete(name, id) {
    const rows = db.read(name);
    const next = rows.filter((r) => r.id !== id && r.app_id !== id);
    db.write(name, next);
    return { deleted: next.length !== rows.length, id };
  },
});

const actions = createActionRegistry()
  .register({
    name: "rank_apps",
    description: "Rank managed apps by feedback heat, bugs and rating",
    parameters: { type: "object", properties: {} },
    async run() { return rankedApps(); },
  })
  .register({
    name: "set_feedback_status",
    description: "Change a feedback item status",
    parameters: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } }, required: ["id", "status"] },
    async run({ id, status }) {
      if (!STATUSES.includes(status)) throw new Error("Invalid status");
      const rows = db.read("feedback");
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) throw new Error("Not found");
      rows[i].status = status;
      rows[i].updated_at = new Date().toISOString();
      db.write("feedback", rows);
      return rows[i];
    },
  })
  .register({
    name: "draft_upgrade_plan",
    description: "Build an upgrade plan from open feedback of one app",
    parameters: { type: "object", properties: { app_id: { type: "string" } }, required: ["app_id"] },
    async run({ app_id }) { return upgradePlan(app_id); },
  })
  .register({
    name: "publish_update",
    description: "Publish an app update notice after human review",
    parameters: {
      type: "object",
      properties: { app_id: { type: "string" }, version: { type: "string" }, notice: { type: "string" } },
      required: ["app_id", "version", "notice"],
    },
    async run(args) { return publishUpdate(args); },
  })
  .register({
    name: "send_notice",
    description: "Queue a client notice (thanks, payment_ok, unpaid_nudge, custom)",
    parameters: {
      type: "object",
      properties: {
        app_id: { type: "string" }, anonymous_id: { type: "string" },
        kind: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      },
      required: ["app_id", "kind", "title", "body"],
    },
    async run(args) { return addNotice(args); },
  });

const kernel = createAiKernel({
  schema: {
    name: "solohost-feedback-hub",
    collections: [
      { name: "apps", fields: ["app_id", "app_name", "category", "status", "fee_required", "current_version"] },
      { name: "feedback", fields: ["id", "app_id", "type", "message", "status", "rating", "ai"] },
      { name: "updates", fields: ["id", "app_id", "version", "notice", "published"] },
      { name: "notices", fields: ["id", "app_id", "kind", "title", "body", "read"] },
      { name: "payments", fields: ["id", "app_id", "txn_id", "status"] },
    ],
  },
  store: storeAdapter,
  actions,
  baseUrl: process.env.LOCAL_AI_BASE_URL || process.env.AI_BASE_URL || "",
  system: `You are the SoloHost Feedback Hub controller.
Summarize all feedback, ratings and comments into themes ranked from most requested to least, rank apps, and draft the smallest safe upgrade.
Never invent collection names, features, or payment confirmations.
Never expose API keys or tokens.
Reply in the user's language.
After tools: âœ… Done / âš ï¸ Not completed / ðŸ‘¤ User action`,
});

function rankedApps() {
  const apps = db.read("apps").filter((app) => app.approval_status !== "pending" && app.integration_status !== "pending");
  const items = db.read("feedback");
  const pays = db.read("payments");
  return apps.map((app) => scoreApp({
    ...app,
    status: app.status || (app.integration_status === "approved" ? "active" : "pending"),
  }, items, pays)).sort((a, b) => b.rank_score - a.rank_score);
}

function upgradePlan(app_id) {
  // Ranked by how many people asked (see lib/insights.js). Keeps the old fields so existing clients keep working.
  const rep = buildInsights(db.read("feedback"), { app_id });
  const open = db.read("feedback").filter((x) => x.app_id === app_id && !["DONE", "DECLINED"].includes(x.status));
  const bugs = open.filter((x) => x.type === "bug");
  const ideas = open.filter((x) => x.type === "idea" || x.type === "improvement");
  return {
    app_id,
    generated_at: rep.generated_at,
    headline: `${bugs.length} open bugs, ${ideas.length} ideas — ship smallest safe change first`,
    must_fix: rep.fixes.slice(0, 5).map((x) => ({ id: x.id, text: x.title, count: x.count, users: x.users, priority: x.priority, feedback_ids: x.feedback_ids })),
    next_features: rep.upgrades.slice(0, 5).map((x) => ({ id: x.id, text: x.title, count: x.count, users: x.users, priority: x.priority, feedback_ids: x.feedback_ids })),
    builder_prompt: rep.builder_prompt,
  };
}

function publishUpdate(p) {
  const app = p.app;
  const appId = app.application_id;
  const releaseNotes = clean(p.release_notes || p.raw_notes || p.notice, 7000);
  const notice = clean(p.notice, 1000) || clean(releaseNotes, 1000);
  const row = {
    id: nid("UP"),
    app_id: appId,
    app_name: app.app_name,
    version: clean(p.version, 60),
    notice,
    release_notes: releaseNotes,
    release_url: clean(p.release_url, 500),
    created_at: new Date().toISOString(),
    published: p.published !== false,
  };
  const a = db.read("updates"); a.push(row); db.write("updates", a);
  if (row.published) {
    addNotice({
      app_id: row.app_id, kind: "update", title: `Cập nhật ${row.version}`,
      body: row.notice,
    });
  }
  return row;
}


function mirrorNoticeToClientStore({ app_id, kind, title, body }) {
  return addNotice({
    app_id,
    kind: kind || "announcement",
    title: title || "Notice",
    body: body || "",
  });
}

function listActiveManagedAppIds() {
  const rows = database.db.prepare("SELECT application_id, integration_status, legacy_json FROM applications").all();
  const out = [];
  for (const row of rows) {
    if (row.integration_status && row.integration_status !== "approved" && row.integration_status !== "active") continue;
    let registry = {};
    try { registry = JSON.parse(row.legacy_json || "{}"); } catch { continue; }
    const status = String(registry.status || "active").toLowerCase();
    if (status === "archived" || status === "paused") continue;
    out.push(row.application_id);
  }
  return out;
}

function managedActiveApp(value) {
  const appId = clean(value, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(appId)) {
    const error = new Error("A valid app_id is required");
    error.http = 400;
    throw error;
  }
  const row = database.db.prepare("SELECT application_id, app_name, integration_status, legacy_json FROM applications WHERE application_id=?").get(appId);
  if (!row) {
    const error = new Error("Unknown app_id");
    error.http = 404;
    throw error;
  }
  let registry;
  try { registry = JSON.parse(row.legacy_json || "{}"); }
  catch {
    const error = new Error("Application registry data is invalid");
    error.http = 500;
    throw error;
  }
  if (registry.__hidden_from_legacy_list || row.integration_status === "disabled") {
    const error = new Error("This application has been removed");
    error.http = 409;
    throw error;
  }
  if (row.integration_status !== "approved" || registry.approval_status === "pending") {
    const error = new Error("Application must be approved before this action");
    error.http = 409;
    throw error;
  }
  if (String(registry.status || "active").toLowerCase() !== "active") {
    const error = new Error("Application must be active before this action");
    error.http = 409;
    throw error;
  }
  return { application_id: row.application_id, app_name: row.app_name };
}

const publicDir = path.join(__dirname, "public");
function serveFile(res, file) {
  const ext = path.extname(file);
  const type = ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".js" ? "application/javascript; charset=utf-8"
    : ext === ".css" ? "text/css; charset=utf-8"
    : ext === ".png" ? "image/png" : "text/plain; charset=utf-8";
  if (!fs.existsSync(file)) return text(res, 404, "Not found");
  if (ext === ".png") {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
    return fs.createReadStream(file).pipe(res);
  }
  text(res, 200, fs.readFileSync(file), type);
}

async function handleAi(req, res, rest, method) {
  if (rest === "/logo.png" && method === "GET") {
    return serveFile(res, path.join(__dirname, "ai-app-kernel/assets/ai-logo.png"));
  }
  if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
  try {
    if (method === "GET" && rest === "/health") return send(res, 200, { ok: true, module: "ai-app-kernel" });
    if (method === "GET" && rest === "/schema") return send(res, 200, { schema: kernel.schema, collections: await kernel.store.listCollections() });
    if (method === "GET" && rest === "/capabilities") return send(res, 200, { actions: kernel.actions.list() });
    if (method === "GET" && rest === "/route") return send(res, 200, await kernel.route());
    if (method === "GET" && rest === "/logo.png") {
      return serveFile(res, path.join(__dirname, "ai-app-kernel/assets/ai-logo.png"));
    }
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad) return send(res, 400, { ok: false, error: "Invalid JSON" });
    // Chat always goes through Universal AI (single key system). Old kernel kept only for schema/capabilities introspection.
    if (method === "POST" && rest === "/chat") {
      const out = await universalAI.chat({
        message: json.message || json.text || "",
        history: Array.isArray(json.history) ? json.history.slice(-8) : [],
      });
      return send(res, 200, { ok: true, text: out.reply || out.text || "", reply: out.reply, ...out });
    }
    if (method === "POST" && rest === "/act") return send(res, 200, await kernel.invoke(json.name, json.args || {}, json.ctx || {}));
    return send(res, 404, { ok: false, error: "Unknown AI route" });
  } catch (e) {
    return send(res, 400, { ok: false, error: String(e.message || e) });
  }
}

const requestHandler = async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  activePath = u.pathname;
  if (req.method === "OPTIONS") return send(res, 204, { ok: true });

  if (u.pathname.startsWith("/api/v1/") && await apiV1(req, res, u)) return;

  if (req.method === "GET" && u.pathname === "/api/health") {
    const s = settings.get();
    return send(res, 200, { ok: true, service: "solohost-feedback-hub", version: "2.5.0", hub_id: s.hub_id || HUB_ID, public_base_url: s.public_base_url || PUBLIC_BASE_URL || null, needs_setup: !settings.hasPassword() });
  }

  if (req.method === "GET" && u.pathname === "/api/session") {
    const needsSetup = !settings.hasPassword();
    return send(res, 200, { ok: true, authed: admin(req), needs_setup: needsSetup, setup_available: needsSetup && setupConnectionAllowed(req) });
  }

  if (req.method === "POST" && u.pathname === "/api/setup") {
    if (settings.hasPassword()) return send(res, 409, { ok: false, error: "Password already set" });
    const remoteAddress = req.socket.remoteAddress || "";
    if (!setupConnectionAllowed(req)) return send(res, 403, { ok: false, error: "Initial admin setup is only available from a direct localhost connection" });
    if (limited(req, 8, 15 * 60 * 1000, "setup", remoteAddress)) return send(res, 429, { ok: false, error: "Too many initial setup attempts" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const pw = json?.password;
    if (typeof pw !== "string" || pw.length < 6 || pw.length > 200) {
      return send(res, 400, { ok: false, error: "Password must be 6 to 200 characters" });
    }
    settings.update({ admin_password: pw });
    setSession(res, req);
    return send(res, 201, { ok: true, setup: true });
  }

  if (req.method === "POST" && u.pathname === "/api/login") {
    if (limited(req, 8, 15 * 60 * 1000, "login")) return send(res, 429, { ok: false, error: "Too many login attempts" });
    const { json } = await readBody(req);
    const pw = json?.password;
    if (typeof pw !== "string" || pw.length < 1 || pw.length > 200) {
      return send(res, 400, { ok: false, error: "Password must be 1 to 200 characters" });
    }
    const ok = settings.checkPassword(pw);
    if (!ok) return send(res, 401, { ok: false, error: "Sai mật khẩu" });
    setSession(res, req);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && u.pathname === "/api/logout") {
    const sid = parseCookie(req).SHFH_SESSION;
    if (sid) adminSessions.delete(sid);
    res.setHeader("Set-Cookie", "SHFH_SESSION=; HttpOnly; Path=/; Max-Age=0");
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && u.pathname === "/api/settings") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    return send(res, 200, { ok: true, settings: settings.publicView() });
  }

  if (req.method === "PUT" && u.pathname === "/api/settings") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    // AI provider/key is ONLY managed by Universal AI module (POST /api/ai/settings).
    // Strip any ai patch so there is no second key store / second input path.
    const patch = { ...(json || {}) };
    delete patch.ai;
    const view = settings.update(patch);
    return send(res, 200, { ok: true, settings: view });
  }

  if (req.method === "GET" && u.pathname === "/api/settings/ai-catalog") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    return send(res, 200, { ok: true, providers: catalogPublic() });
  }

  if (req.method === "POST" && u.pathname === "/api/settings/peek-token") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    const token = String(json?.token || "");
    const provider = detectProviderFromToken(token);
    return send(res, 200, { ok: true, provider, models: modelsFor(provider || json?.provider) });
  }

  if (req.method === "POST" && u.pathname === "/api/settings/test-ai") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    const st = settings.get();
    const LOCAL = ["ollama", "lmstudio", "local"];
    const token = String(json?.token || st.ai?.api_key || "").trim();
    let provider = String(json?.provider || st.ai?.provider || "").toLowerCase();
    const hinted = detectProviderFromToken(token);              // strong hints only: gsk_ / sk-or- / xai- / AIza (a bare "sk-" may be OpenAI or DeepSeek)
    if (!provider) provider = hinted || "";
    if (!provider) return send(res, 400, { ok: false, error: "HÃ£y chá»n nhÃ  cung cáº¥p trÆ°á»›c. / Choose a provider first." });
    if (!token && !LOCAL.includes(provider)) return send(res, 400, { ok: false, error: "Hãy dán API token. / Paste an API token." });
    if (token && hinted && hinted !== "openai" && hinted !== provider && !LOCAL.includes(provider)) {
      return send(res, 200, { ok: false, provider, suggested_provider: hinted, models: modelsFor(hinted), warning: `Token nÃ y cÃ³ dáº¡ng cá»§a ${hinted}, nhÆ°ng báº¡n Ä‘ang chá»n ${provider}. ÄÃ£ gá»£i Ã½ Ä‘á»•i sang ${hinted}. / Token looks like ${hinted}, not ${provider}.` });
    }
    const out = await verifyProvider({ provider, apiKey: token, baseUrl: json?.local_base_url || st.ai?.local_base_url || "", model: String(json?.model || "") });
    return send(res, 200, { ...out, models: out.models && out.models.length ? out.models : modelsFor(provider) });
  }

  if (req.method === "GET" && u.pathname === "/api/config") {
    const s = settings.get();
    const d = settings.publicDonate();
    return send(res, 200, {
      ok: true, hub_id: s.hub_id || HUB_ID, public_base_url: s.public_base_url || PUBLIC_BASE_URL || "", schema_version: "2.0",
      donate: { pi_wallet: d.pi_wallet || PI_WALLET, mb_bank: d.mb_bank || MB_BANK, mb_account: d.mb_account || MB_ACCOUNT, mb_name: d.mb_name || MB_NAME },
      events: ["feedback", "payment", "usage"],
      types: TYPES,
      schema_version: "2.2",
      payment_states: ["free", "unpaid", "pending", "paid", "supporter", "expired", "waived", "unknown"],
    });
  }

  if (req.method === "GET" && u.pathname === "/api/client-policy") {
    const appId = clean(u.searchParams.get("app_id"), 120);
    const app = db.read("apps").find((a) => a.app_id === appId) || { app_id: appId || "unknown", fee_required: false, app_name: appId };
    const latest = db.read("updates").filter((x) => x.published && (!appId || x.app_id === appId))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    const d = settings.publicDonate();
    return send(res, 200, {
      ok: true,
      schema_version: "2.2",
      app_id: app.app_id,
      app_name: app.app_name,
      fee_required: Boolean(app.fee_required),
      current_version: app.current_version || "",
      latest_update: latest,
      donate: { pi_wallet: d.pi_wallet || PI_WALLET, mb_bank: d.mb_bank || MB_BANK, mb_account: d.mb_account || MB_ACCOUNT, mb_name: d.mb_name || MB_NAME },
      templates: templates(),
      payment_states: ["free", "unpaid", "pending", "paid", "supporter", "expired", "waived", "unknown"],
    });
  }

  if (req.method === "GET" && u.pathname === "/api/sdk.js")
    return serveFile(res, path.join(publicDir, "client/shfh-client.js"));

  if (req.method === "POST" && u.pathname === "/api/feedback") {
    if (!ingest(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    if (limited(req)) return send(res, 429, { ok: false, error: "Rate limit exceeded" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const limitError = pendingAppLimit(req, json);
    if (limitError) return send(res, limitError.status, { ok: false, error: limitError.error });
    try { return send(res, 201, ingestEvent(json, req)); }
    catch (e) { return send(res, e.http || 400, { ok: false, error: e.message }); }
  }

  if (req.method === "GET" && u.pathname === "/api/notices") {
    const appId = u.searchParams.get("app_id") || "";
    const anon = u.searchParams.get("anonymous_id") || "";
    let items = db.read("notices");
    if (appId) items = items.filter((x) => x.app_id === appId);
    if (anon) items = items.filter((x) => !x.anonymous_id || x.anonymous_id === anon);
    items = items.filter((x) => !x.read).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);
    return send(res, 200, { ok: true, items });
  }

  if (req.method === "POST" && u.pathname.startsWith("/api/notices/") && u.pathname.endsWith("/read")) {
    const id = decodeURIComponent(u.pathname.split("/")[3]);
    const all = db.read("notices");
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return send(res, 404, { ok: false, error: "Not found" });
    all[i].read = true; db.write("notices", all);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && u.pathname === "/api/updates") {
    const appId = u.searchParams.get("app_id");
    let a = db.read("updates").filter((x) => x.published);
    if (appId) a = a.filter((x) => x.app_id === appId);
    return send(res, 200, { ok: true, items: a.sort((x, y) => y.created_at.localeCompare(x.created_at)) });
  }

  // â”€â”€ Universal AI Module routes (FAB panel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (u.pathname === "/api/ai/status" && req.method === "GET") {
    return send(res, 200, { ok: true, configured: universalAI.configured(), settings: universalAI.publicSettings() });
  }
  if (u.pathname === "/api/ai/catalog" && req.method === "GET") {
    return send(res, 200, { providers: universalAI.catalog() });
  }
  if (u.pathname === "/api/ai/settings" && req.method === "GET") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Admin sign-in required" });
    return send(res, 200, universalAI.publicSettings());
  }
  if (u.pathname === "/api/ai/settings" && req.method === "POST") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Admin sign-in required" });
    try {
      const { json, bad } = await readBody(req);
      if (bad) return send(res, 400, { ok: false, error: "Invalid JSON" });
      const saved = universalAI.saveSettings(json || {});
      return send(res, 200, { ok: true, settings: saved });
    } catch (e) {
      universalAI.log("error", "ai.settings", { error: e.message });
      return send(res, 400, { ok: false, error: e.message });
    }
  }
  if (u.pathname === "/api/ai/models" && req.method === "GET") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Admin sign-in required" });
    try {
      return send(res, 200, await universalAI.refreshModels());
    } catch (e) {
      return send(res, 502, { ok: false, error: String(e.message || e) });
    }
  }
  if (u.pathname === "/api/ai/test" && req.method === "POST") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Admin sign-in required" });
    try {
      return send(res, 200, await universalAI.testConnection());
    } catch (e) {
      return send(res, 502, { ok: false, error: String(e.message || e) });
    }
  }
  if (u.pathname === "/api/ai/chat" && req.method === "POST") {
    if (limited(req, 30, RATE_WINDOW, "ai-chat")) return send(res, 429, { ok: false, error: "AI chat rate limit exceeded" });
    try {
      const { json, bad } = await readBody(req);
      if (bad || !json?.message) return send(res, 400, { ok: false, error: "message required" });
      const out = await universalAI.chat({
        message: json.message,
        history: Array.isArray(json.history) ? json.history.slice(-8) : [],
        context: json.context || {},
        knowledge: json.knowledge,
      });
      return send(res, 200, out);
    } catch (e) {
      universalAI.log("error", "ai.chat.fail", { error: e.message });
      return send(res, 502, { ok: false, error: String(e.message || e) });
    }
  }
  if (u.pathname === "/api/logs" && req.method === "GET") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Admin sign-in required" });
    return send(res, 200, { logs: universalAI.readLogs() });
  }
  if (u.pathname === "/api/logs" && req.method === "DELETE") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Admin sign-in required" });
    universalAI.clearLogs();
    return send(res, 200, { ok: true });
  }

  // â”€â”€ Universal Feedback Module routes (for the panel itself) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (u.pathname === "/api/feedback/config" && req.method === "GET") {
    return send(res, 200, universalFB.publicConfig());
  }
  if (u.pathname === "/api/feedback/sync" && req.method === "GET") {
    const appId = "solohost-feedback-hub";
    const anon = clean(u.searchParams.get("anonymous_id") || "", 120);
    const donate = settings.publicDonate();
    let notices = db.read("notices").filter(n => n.app_id === appId && !n.read);
    if (anon) notices = notices.filter(n => !n.anonymous_id || n.anonymous_id === anon);
    notices = notices.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20);
    return send(res, 200, {
      ok: true,
      policy: { ok: true, app_id: appId, app_name: "SoloHost Feedback Hub", donate },
      notices,
      donate,
    });
  }
  // Panel feedback is stored locally; keep the existing authenticated ingest endpoint unchanged.
  if (u.pathname === "/api/feedback/panel-submit" && req.method === "POST") {
    if (limited(req, 12, RATE_WINDOW, "panel-feedback")) {
      return send(res, 429, { ok: false, error: "Rate limit exceeded" });
    }
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    try {
      const payload = {
        ...json,
        event: "feedback",
        app_id: "solohost-feedback-hub",
        app_name: "SoloHost Feedback Hub",
        version: "2.5.1",
        rating: Math.max(0, Math.min(5, Number(json.rating) || 0)),
      };
      delete payload.apiKey; delete payload.token; delete payload.password;
      const limitError = pendingAppLimit(req, payload);
      if (limitError) return send(res, limitError.status, { ok: false, error: limitError.error });
      return send(res, 201, ingestEvent(payload, req));
    } catch (e) {
      return send(res, e.http || 400, { ok: false, error: e.message || "Feedback could not be saved" });
    }
  }

  if (u.pathname.startsWith("/api/feedback/read/") && req.method === "POST") {
    const id = decodeURIComponent(u.pathname.split("/").pop());
    const { json } = await readBody(req);
    const anonymousId = clean(json?.anonymous_id, 120);
    const notices = db.read("notices");
    const i = notices.findIndex(n => n.id === id && n.app_id === "solohost-feedback-hub" &&
      (!n.anonymous_id || n.anonymous_id === anonymousId));
    if (i < 0) return send(res, 404, { ok: false, error: "Notice not found" });
    notices[i].read = true;
    notices[i].read_at = new Date().toISOString();
    db.write("notices", notices);
    return send(res, 200, { ok: true, id, read: true });
  }

  if (u.pathname === "/ai" || u.pathname.startsWith("/ai/")) {
    return handleAi(req, res, u.pathname.slice(3) || "/", req.method);
  }

  // admin
  if (req.method === "GET" && u.pathname === "/api/admin/overview") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const items = db.read("feedback");
    const pendingApps = db.read("apps").filter((app) => app.approval_status === "pending" || app.integration_status === "pending")
      .map((app) => ({ ...app, feedback_count: items.filter((item) => item.app_id === app.app_id).length }));
    return send(res, 200, {
      ok: true,
      apps: rankedApps(),
      pending_apps: pendingApps,
      totals: {
        feedback: items.length,
        new: items.filter((x) => x.status === "NEW").length,
        bugs: items.filter((x) => x.type === "bug").length,
        payments: db.read("payments").length,
      },
    });
  }

  if (req.method === "GET" && u.pathname === "/api/feedback") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const appId = u.searchParams.get("app_id");
    let a = db.read("feedback").sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (appId) a = a.filter((x) => x.app_id === appId);
    return send(res, 200, { ok: true, count: a.length, items: a });
  }

  if (req.method === "PATCH" && u.pathname.startsWith("/api/feedback/")) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const id = decodeURIComponent(u.pathname.split("/").pop());
    const { json } = await readBody(req);
    if (!json || !STATUSES.includes(json.status)) return send(res, 400, { ok: false, error: "Invalid status" });
    const a = db.read("feedback"); const i = a.findIndex((x) => x.id === id);
    if (i < 0) return send(res, 404, { ok: false, error: "Not found" });
    const appId = clean(u.searchParams.get("app_id"), 64);
    if (appId && appId !== a[i].app_id) return send(res, 404, { ok: false, error: "Feedback not found for this application" });
    a[i].status = json.status; a[i].updated_at = new Date().toISOString();
    if (json.admin_note) a[i].admin_note = clean(json.admin_note, 1000);
    db.write("feedback", a);
    return send(res, 200, { ok: true, item: a[i] });
  }

  if (req.method === "GET" && u.pathname === "/api/apps") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    return send(res, 200, { ok: true, items: rankedApps() });
  }

  const appApproval = u.pathname.match(/^\/api\/apps\/([^/]+)\/approve$/);
  if (req.method === "POST" && appApproval) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const appId = decodeURIComponent(appApproval[1]);
    const app = db.read("apps").find((item) => item.app_id === appId);
    if (!app || (app.approval_status !== "pending" && app.integration_status !== "pending")) {
      return send(res, 404, { ok: false, error: "Pending app not found" });
    }
    try {
      appService.approveApp(appId);
      return send(res, 200, { ok: true, item: db.upsertApp({ ...app, status: "active", approval_status: "approved" }) });
    } catch (error) {
      return send(res, error.code === "APP_NOT_FOUND" ? 404 : 409, { ok: false, error: error.message });
    }
  }

  const appRemoval = u.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (req.method === "DELETE" && appRemoval) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    try {
      appService.disableApp(decodeURIComponent(appRemoval[1]));
      return send(res, 200, { ok: true, deleted: true, retained_feedback: true });
    } catch (error) {
      return send(res, error.code === "APP_NOT_FOUND" ? 404 : 500, { ok: false, error: error.message });
    }
  }

  if (req.method === "POST" && u.pathname === "/api/apps") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    if (!json?.app_id) return send(res, 400, { ok: false, error: "app_id required" });
    const id = clean(json.app_id, 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) return send(res, 400, { ok: false, error: "app_id must be a slug: a-z 0-9 . _ -" });
    return send(res, 201, { ok: true, item: db.upsertApp({ ...json, app_id: id, status: json.status || "active", approval_status: "approved", current_version: json.current_version || "" }) });
  }

  if (req.method === "GET" && u.pathname === "/api/apps/export") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const payload = {
      kind: "solohost-feedback-hub-apps",
      version: "2.2",
      exported_at: new Date().toISOString(),
      items: db.read("apps"),
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"solohost-apps.json\"",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(payload, null, 2));
  }

  if (req.method === "POST" && u.pathname === "/api/apps/import") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too || bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const items = Array.isArray(json) ? json : json.items;
    if (!Array.isArray(items)) return send(res, 400, { ok: false, error: "Expected {items:[]} or array" });
    const replace = json.replace === true;
    if (replace) db.write("apps", []);
    let upserted = 0;
    for (const row of items.slice(0, 500)) {
      if (row && row.app_id) { db.upsertApp(row); upserted += 1; }
    }
    return send(res, 200, { ok: true, upserted, total: db.read("apps").length, replaced: replace });
  }

  if (req.method === "GET" && u.pathname.startsWith("/api/apps/") && u.pathname.endsWith("/plan")) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const appId = decodeURIComponent(u.pathname.split("/")[3]);
    return send(res, 200, { ok: true, plan: upgradePlan(appId) });
  }

  // AI classify = ONE summary of all comments / ratings / feedback, ranked from most requested to least.
  // (Per-item AI classification was removed on purpose; each item still gets a free local tag when it arrives.)
  if (req.method === "POST" && (u.pathname === "/api/ai/classify" || u.pathname === "/api/ai/insights")) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    const appId = json?.app_id ? clean(json.app_id, 120) : "";
    let report = buildInsights(db.read("feedback"), { app_id: appId, includeClosed: json?.include_closed === true });
    let ai_note = "";
    if (json?.use_ai !== false && report.ranked.length) {
      try {
        const brief = report.ranked.slice(0, 25).map((x) => ({ id: x.id, kind: x.kind, count: x.count, users: x.users, title: x.title, samples: x.samples }));
        // Single AI system: Universal AI module (same key as robot panel Settings)
        const out = await universalAI.chat({
          message: `Do NOT call tools. Re-word only. Below are feedback themes already ranked by number of requests. Do not reorder, merge, drop or invent any. For each id write a clear short title (max 90 chars), a one-sentence summary and one concrete next action, in the language of the samples. Reply JSON only: {"items":[{"id":"IN001","title":"...","summary":"...","suggested_action":"..."}]}\n${JSON.stringify(brief)}`,
        });
        const text = out.reply || out.text || out.message || "";
        const m = String(text).match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        if (parsed && Array.isArray(parsed.items)) report = applyAiWording(report, parsed.items);
        else ai_note = "AI khÃ´ng tráº£ vá» JSON há»£p lá»‡ â€” Ä‘ang dÃ¹ng báº£n tá»•ng há»£p cá»¥c bá»™.";
      } catch (e) {
        ai_note = "AI chưa sẵn sàng (" + String(e.message || e).slice(0, 120) + ") — đang dùng bản tổng hợp cục bộ, thứ tự vẫn đúng.";
      }
    }
    return send(res, 200, { ok: true, report, ai_note });
  }

  if (req.method === "POST" && u.pathname === "/api/ai/rewrite") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    if (!json?.input) return send(res, 400, { ok: false, error: "Input is required" });
    try {
      // Single AI system: Universal AI module (same key as robot panel Settings)
      const out = await universalAI.chat({
        message: `Rewrite into a short mobile update notice. Preserve facts. Do not invent features. Output ONLY 1 title + 1-3 bullets.\n\n${clean(json.input, 7000)}`,
      });
      return send(res, 200, { ok: true, text: out.reply || out.text || out.message || "" });
    } catch (e) {
      return send(res, 502, { ok: false, error: "AI service unavailable: " + e.message });
    }
  }

  if (req.method === "GET" && u.pathname === "/api/updates/all") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const appId = clean(u.searchParams.get("app_id"), 64);
    const items = db.read("updates").filter((item) => !appId || item.app_id === appId);
    return send(res, 200, { ok: true, items: items.sort((x, y) => y.created_at.localeCompare(x.created_at)) });
  }

  if (req.method === "POST" && u.pathname === "/api/updates") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    if (json.published !== undefined && typeof json.published !== "boolean") {
      return send(res, 400, { ok: false, error: "published must be a boolean" });
    }
    const version = clean(json.version, 60);
    const notice = clean(json.notice, 1000) || clean(json.release_notes || json.raw_notes, 1000);
    if (!version || !notice) return send(res, 400, { ok: false, error: "app_id, version and notice (or release_notes) are required" });
    const releaseUrl = clean(json.release_url, 500);
    if (releaseUrl) {
      try {
        const url = new URL(releaseUrl);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
      } catch {
        return send(res, 400, { ok: false, error: "release_url must be an absolute HTTP(S) URL without credentials" });
      }
    }
    try {
      const app = managedActiveApp(json.app_id);
      return send(res, 201, { ok: true, item: publishUpdate({ ...json, app, version, notice }) });
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "PATCH" && u.pathname.startsWith("/api/updates/")) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const id = decodeURIComponent(u.pathname.split("/").pop());
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const a = db.read("updates"); const i = a.findIndex((x) => x.id === id);
    if (i < 0) return send(res, 404, { ok: false, error: "Not found" });
    const appId = clean(u.searchParams.get("app_id") || json.app_id, 64);
    if (appId && appId !== a[i].app_id) return send(res, 404, { ok: false, error: "Not found for this application" });
    if (json.published === true) {
      try { managedActiveApp(appId || a[i].app_id); }
      catch (error) { return send(res, error.http || 400, { ok: false, error: error.message }); }
    }
    if (typeof json.published === "boolean") a[i].published = json.published;
    db.write("updates", a);
    return send(res, 200, { ok: true, item: a[i] });
  }

  if (req.method === "GET" && u.pathname === "/api/admin/notices") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const appId = clean(u.searchParams.get("app_id"), 64);
    const items = database.db.prepare(`SELECT n.notification_id,n.application_id,n.title,n.body,n.notification_type AS type,n.locale,n.scheduled_at,n.expires_at,n.audience,n.channel,n.workflow_state,n.approved_at,n.published_at,n.cancelled_at,
      (SELECT count(*) FROM notification_recipients r WHERE r.notification_id=n.notification_id) AS recipients_total,
      (SELECT count(*) FROM notification_recipients r WHERE r.notification_id=n.notification_id AND r.delivery_status='delivered') AS delivered_total,
      (SELECT count(*) FROM notification_recipients r WHERE r.notification_id=n.notification_id AND r.delivery_status='failed') AS failed_total
      FROM notifications n WHERE (?='' OR n.application_id=?) ORDER BY n.created_at DESC LIMIT 100`).all(appId, appId);
    return send(res, 200, { ok: true, items: items.map((item) => ({
      ...item,
      recipient_ids: database.db.prepare("SELECT recipient_id FROM notification_recipients WHERE notification_id=? AND recipient_id<>'*' ORDER BY recipient_id").all(item.notification_id).map((recipient) => recipient.recipient_id),
      history: notificationService.history({ applicationId: item.application_id, notificationId: item.notification_id }),
    })) });
  }

  if (req.method === "POST" && u.pathname === "/api/admin/notices/preview") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const typeByKind = { thanks: "announcement", payment_ok: "payment", unpaid_nudge: "payment", update: "update", custom: "announcement" };
    try {
      const app = managedActiveApp(json.app_id);
      const preview = notificationService.preview({ applicationId: app.application_id, title: json.title, body: json.body, type: json.type || typeByKind[json.kind] || "announcement", locale: json.locale, audience: json.audience || "all", recipientIds: json.recipient_ids, scheduledAt: json.scheduled_at, expiresAt: json.expires_at, channel: json.channel || "in_app" });
      return send(res, 200, { ok: true, preview });
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "POST" && u.pathname === "/api/admin/notices") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const typeByKind = { thanks: "announcement", payment_ok: "payment", unpaid_nudge: "payment", update: "update", custom: "announcement" };
    try {
      const app = managedActiveApp(json.app_id);
      const item = notificationService.create({ applicationId: app.application_id, title: json.title, body: json.body, type: json.type || typeByKind[json.kind] || "announcement", locale: json.locale, audience: json.audience || "all", recipientIds: json.recipient_ids, scheduledAt: json.scheduled_at, expiresAt: json.expires_at, channel: json.channel || "in_app", idempotencyKey: json.idempotency_key || `admin-${crypto.randomUUID()}`, workflowState: "draft", actorType: "platform_admin", actorId: "admin", createdBy: "platform_admin" });
      return send(res, item.status === "replayed" ? 200 : 201, { ok: true, item });
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
  }

  const adminNoticeEdit = u.pathname.match(/^\/api\/admin\/notices\/([^/]+)$/);
  if (req.method === "PUT" && adminNoticeEdit) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const typeByKind = { thanks: "announcement", payment_ok: "payment", unpaid_nudge: "payment", update: "update", custom: "announcement" };
    try {
      const app = managedActiveApp(json.app_id);
      const item = notificationService.updateDraft({ applicationId: app.application_id, notificationId: decodeURIComponent(adminNoticeEdit[1]), input: { title: json.title, body: json.body, type: json.type || typeByKind[json.kind] || "announcement", locale: json.locale, audience: json.audience || "all", recipientIds: json.recipient_ids, scheduledAt: json.scheduled_at, expiresAt: json.expires_at, channel: json.channel || "in_app" } });
      return send(res, 200, { ok: true, item });
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
  }

  const adminNoticeAction = u.pathname.match(/^\/api\/admin\/notices\/([^/]+)\/(preview|approve|publish|cancel)$/);
  if (req.method === "POST" && adminNoticeAction) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const notificationId = decodeURIComponent(adminNoticeAction[1]);
    const action = adminNoticeAction[2];
    const notice = database.db.prepare("SELECT application_id FROM notifications WHERE notification_id=?").get(notificationId);
    if (!notice) return send(res, 404, { ok: false, error: "Notice not found" });
    const requestedAppId = clean(u.searchParams.get("app_id"), 64);
    if (requestedAppId && requestedAppId !== notice.application_id) return send(res, 404, { ok: false, error: "Notice not found for this application" });
    if (action === "approve" || action === "publish") {
      try { managedActiveApp(notice.application_id); }
      catch (error) { return send(res, error.http || 400, { ok: false, error: error.message }); }
    }
    try {
      if (action === "preview") return send(res, 200, { ok: true, preview: notificationService.previewDraft({ applicationId: notice.application_id, notificationId }) });
      if (action === "approve") return send(res, 200, { ok: true, item: notificationService.approve({ applicationId: notice.application_id, notificationId, actorType: "platform_admin", actorId: "admin" }) });
      if (action === "publish") {
        const item = notificationService.publish({ applicationId: notice.application_id, notificationId, actorType: "platform_admin", actorId: "admin" });
        const full = database.db.prepare("SELECT title,body,notification_type AS type FROM notifications WHERE notification_id=?").get(notificationId);
        if (full) {
          mirrorNoticeToClientStore({ app_id: notice.application_id, kind: full.type || "announcement", title: full.title, body: full.body });
        }
        return send(res, 200, { ok: true, item });
      }
      return send(res, 200, { ok: true, item: notificationService.cancel({ applicationId: notice.application_id, notificationId, actorType: "platform_admin", actorId: "admin" }) });
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
  }


  if (req.method === "POST" && u.pathname === "/api/admin/notices/send") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    const title = clean(json.title, 160);
    const body = clean(json.body, 4000);
    if (!title || !body) return send(res, 400, { ok: false, error: "title and body are required" });
    const typeByKind = { thanks: "announcement", payment_ok: "payment", unpaid_nudge: "payment", update: "update", custom: "announcement" };
    const type = clean(json.type || typeByKind[json.kind] || "announcement", 32);
    const target = clean(json.app_id, 64);
    let appIds = [];
    try {
      // Broadcast ONLY when client explicitly sends * or all — never on empty app_id
      if (target === "*" || target === "all") {
        appIds = listActiveManagedAppIds();
        if (!appIds.length) return send(res, 400, { ok: false, error: "No active managed apps to notify" });
      } else if (!target) {
        return send(res, 400, { ok: false, error: "app_id is required (use a specific app_id, or * for all apps)" });
      } else {
        appIds = [managedActiveApp(target).application_id];
      }
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
    const items = [];
    for (const applicationId of appIds) {
      try {
        const created = notificationService.create({
          applicationId,
          title,
          body,
          type,
          audience: json.audience === "selected" ? "selected" : "all",
          recipientIds: json.recipient_ids || [],
          scheduledAt: json.scheduled_at || null,
          expiresAt: json.expires_at || null,
          channel: json.channel || "in_app",
          idempotencyKey: json.idempotency_key || `send-${applicationId}-${crypto.randomUUID()}`,
          workflowState: "draft",
          actorType: "platform_admin",
          actorId: "admin",
          createdBy: "platform_admin",
        });
        notificationService.approve({ applicationId, notificationId: created.notification_id, actorType: "platform_admin", actorId: "admin" });
        const published = notificationService.publish({ applicationId, notificationId: created.notification_id, actorType: "platform_admin", actorId: "admin" });
        mirrorNoticeToClientStore({ app_id: applicationId, kind: type, title, body });
        items.push({ ...published, application_id: applicationId });
      } catch (error) {
        items.push({ application_id: applicationId, error: error.message });
      }
    }
    const okCount = items.filter((x) => !x.error).length;
    return send(res, okCount ? 201 : 400, { ok: okCount > 0, sent: okCount, total: appIds.length, items });
  }

  if (req.method === "GET" && u.pathname === "/api/admin/activity") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const days = Math.max(1, Math.min(90, Number(u.searchParams.get("days") || 7) || 7));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const events = [];
    for (const n of db.read("notices") || []) {
      if (String(n.created_at || "") >= since) {
        events.push({ id: n.id, kind: "notice", type: n.kind || "announcement", title: n.title, body: n.body, app_id: n.app_id, created_at: n.created_at });
      }
    }
    for (const f of db.read("feedback") || []) {
      if (String(f.created_at || "") >= since) {
        events.push({ id: f.id, kind: "feedback", type: f.type || "feedback", title: (f.message || "").slice(0, 120), body: f.message, app_id: f.app_id, created_at: f.created_at });
      }
    }
    for (const urow of db.read("updates") || []) {
      if (String(urow.created_at || "") >= since) {
        events.push({ id: urow.id, kind: "update", type: "update", title: `Update ${urow.version}`, body: urow.notice, app_id: urow.app_id, created_at: urow.created_at });
      }
    }
    try {
      const sqlNotices = database.db.prepare(`SELECT notification_id AS id, application_id AS app_id, title, body, notification_type AS type, COALESCE(published_at, created_at) AS created_at, workflow_state
        FROM notifications WHERE COALESCE(published_at, created_at) >= ? ORDER BY created_at DESC LIMIT 200`).all(since);
      for (const row of sqlNotices) {
        events.push({ id: row.id, kind: "notice_workflow", type: row.type, title: row.title, body: row.body, app_id: row.app_id, created_at: row.created_at, status: row.workflow_state });
      }
    } catch {}
    events.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return send(res, 200, { ok: true, days, since, items: events.slice(0, 300) });
  }

  if (req.method === "POST" && u.pathname === "/api/notices/broadcast") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json, too, bad } = await readBody(req);
    if (too) return send(res, 413, { ok: false, error: "Payload too large" });
    if (bad || !json) return send(res, 400, { ok: false, error: "Invalid JSON" });
    if (!json?.app_id || !json?.body) return send(res, 400, { ok: false, error: "app_id and body required" });
    try {
      const app = managedActiveApp(json.app_id);
      const item = notificationService.create({ applicationId: app.application_id, title: json.title || "Thông báo", body: json.body, type: "announcement", audience: "all", idempotencyKey: `legacy-admin-${crypto.randomUUID()}`, workflowState: "draft", actorType: "platform_admin", actorId: "admin", createdBy: "platform_admin" });
      return send(res, 201, { ok: true, item });
    } catch (error) {
      return send(res, error.http || 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && u.pathname === "/owner")
    return serveFile(res, path.join(publicDir, "owner.html"));
  if (req.method === "GET" && u.pathname === "/feedback/track")
    return serveFile(res, path.join(publicDir, "feedback-track.html"));
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/admin"))
    return serveFile(res, path.join(publicDir, "admin.html"));
  if (req.method === "GET" && (u.pathname === "/feedback" || u.pathname === "/public"))
    return serveFile(res, path.join(publicDir, "index.html"));
  if (req.method === "GET" && u.pathname.startsWith("/client/")) {
    const name = path.basename(u.pathname);
    if (!/^[a-zA-Z0-9._-]+\.js$/.test(name)) return text(res, 404, "Not found");
    return serveFile(res, path.join(publicDir, "client", name));
  }
  // Universal AI panel assets
  if (req.method === "GET" && (u.pathname === "/ai-icon.png" || u.pathname === "/ai-panel.css" || u.pathname === "/ai-panel.js")) {
    return serveFile(res, path.join(publicDir, path.basename(u.pathname)));
  }
  if (req.method === "GET" && u.pathname === "/admin-app-selector.js") {
    return serveFile(res, path.join(publicDir, "admin-app-selector.js"));
  }
  if (req.method === "GET" && (u.pathname.startsWith("/ai-module/") || u.pathname.startsWith("/feedback-module/"))) {
    const rel = u.pathname.replace(/^\//, "");
    if (!/^[a-zA-Z0-9._/-]+\.js$/.test(rel) || rel.includes("..")) return text(res, 404, "Not found");
    return serveFile(res, path.join(publicDir, rel));
  }
  text(res, 404, "Not found");
};

if (hasSetupPort && (!Number.isInteger(SETUP_PORT) || SETUP_PORT < 1 || SETUP_PORT > 65535 || SETUP_PORT === PORT)) {
  throw new Error("SETUP_PORT must be a valid port distinct from PORT");
}
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const server = http.createServer(requestHandler);
server.listen(PORT, LISTEN_HOST, () => {
  console.log(`SoloHost Feedback Hub ${HUB_ID} v2 listening on ${LISTEN_HOST}:${server.address().port}`);
});
if (SETUP_PORT) {
  const setupServer = http.createServer(requestHandler);
  setupServer.listen(SETUP_PORT, "0.0.0.0", () => {
    console.log(`SoloHost Feedback Hub loopback setup listener on :${setupServer.address().port}`);
  });
}

attachGracefulShutdown({ server, database, stopWorkers: async () => { await Promise.all([stopNotificationWorker(), stopWebhookWorker(), stopPiWorker(), stopFeeWorker()]); } });
