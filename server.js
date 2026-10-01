import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createFileDb } from "./lib/store.js";
import { TYPES, STATUSES, localClassify, scoreApp } from "./lib/classify.js";
import { createSettings } from "./lib/settings.js";
import { catalogPublic, detectProviderFromToken, modelsFor } from "./lib/ai-catalog.js";
import { createAiKernel, createActionRegistry, createCustomStore } from "./ai-app-kernel/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const HUB_ID = process.env.HUB_ID || "SHFH-CHANGE-ME";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const PI_WALLET = process.env.PI_WALLET || "";
const MB_BANK = process.env.MB_BANK || "MB Bank";
const MB_ACCOUNT = process.env.MB_ACCOUNT || "";
const MB_NAME = process.env.MB_NAME || "";
const MAX_BODY = 160 * 1024;
const RATE_WINDOW = 60 * 60 * 1000;
const RATE_LIMIT = 20;

const dataDir = path.join(__dirname, "data");
function applyAiEnv(s) {
  const st = s || (typeof settings !== "undefined" ? settings.get() : null);
  if (!st) return;
  if (st.ai?.provider) process.env.AI_PROVIDER = st.ai.provider;
  if (st.ai?.model) process.env.AI_MODEL = st.ai.model;
  if (st.ai?.local_base_url) process.env.LOCAL_AI_BASE_URL = st.ai.local_base_url;
  if (st.ai?.api_key) process.env.AI_API_KEY = st.ai.api_key;
}
const db = createFileDb(dataDir);
const settings = createSettings(dataDir, process.env);
applyAiEnv();
const hits = new Map();
const sessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function parseCookie(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionOk(req) {
  const sid = parseCookie(req).SHFH_SESSION;
  if (!sid || !sessions.has(sid)) return false;
  const exp = sessions.get(sid);
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  sessions.set(sid, Date.now() + SESSION_TTL);
  return true;
}
function setSession(res) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, Date.now() + SESSION_TTL);
  res.setHeader("Set-Cookie", `SHFH_SESSION=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
  return sid;
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
function limited(req, max = RATE_LIMIT, windowMs = RATE_WINDOW, bucket = "ing") {
  const k = bucket + ":" + clientKey(req);
  const now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < windowMs);
  a.push(now); hits.set(k, a);
  return a.length > max;
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
    update_ack: "Đã có bản cập nhật mới. Mở phần Updates trong app để xem chi tiết.",
  };
}

function ensureApp(p) {
  const app_id = clean(p.app_id, 120) || "unknown";
  const existing = db.read("apps").find((a) => a.app_id === app_id);
  if (!existing) {
    db.upsertApp({
      app_id,
      app_name: clean(p.app_name, 120) || app_id,
      category: clean(p.category, 60) || "general",
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
      status: "confirmed",
      created_at: new Date().toISOString(),
    };
    const pays = db.read("payments"); pays.push(pay); db.write("payments", pays);
    const notice = addNotice({
      app_id, anonymous_id: pay.anonymous_id, kind: "payment_ok",
      title: "Ủng hộ thành công", body: tpls.payment_ok, extra: { txn_id: pay.txn_id },
    });
    return { ok: true, kind: "payment", id: pay.id, notice };
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
  if (!row.message && event === "feedback") throw Object.assign(new Error("Message is required"), { http: 400 });
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
      { name: "apps", fields: ["app_id", "app_name", "category", "status", "fee_required"] },
      { name: "feedback", fields: ["id", "app_id", "type", "message", "status", "rating", "ai"] },
      { name: "updates", fields: ["id", "app_id", "version", "notice", "published"] },
      { name: "notices", fields: ["id", "app_id", "kind", "title", "body", "read"] },
      { name: "payments", fields: ["id", "app_id", "txn_id", "status"] },
    ],
  },
  store: storeAdapter,
  actions,
  baseUrl: process.env.LOCAL_AI_BASE_URL || process.env.AI_BASE_URL || "",
});

function rankedApps() {
  const apps = db.read("apps");
  const items = db.read("feedback");
  const pays = db.read("payments");
  return apps.map((a) => scoreApp(a, items, pays)).sort((a, b) => b.rank_score - a.rank_score);
}

function upgradePlan(app_id) {
  const items = db.read("feedback").filter((x) => x.app_id === app_id && !["DONE", "DECLINED"].includes(x.status));
  const bugs = items.filter((x) => x.type === "bug");
  const ideas = items.filter((x) => x.type === "idea" || x.type === "improvement");
  return {
    app_id,
    generated_at: new Date().toISOString(),
    headline: `${bugs.length} open bugs, ${ideas.length} ideas — ship smallest safe change first`,
    must_fix: bugs.slice(0, 5).map((x) => ({ id: x.id, text: x.message, priority: x.ai?.priority })),
    next_features: ideas.slice(0, 5).map((x) => ({ id: x.id, text: x.message })),
    builder_prompt: `App: ${app_id}\nProblem: ${bugs.length} users report open bugs.\nRequested action: Analyze current source, identify root cause, propose smallest safe change, then build, smoke test, HTTP test and preview.`,
  };
}

function publishUpdate(p) {
  const row = {
    id: nid("UP"),
    app_id: clean(p.app_id, 120),
    app_name: clean(p.app_name, 120) || clean(p.app_id, 120),
    version: clean(p.version, 60),
    notice: clean(p.notice, 1000),
    release_url: clean(p.release_url, 500),
    created_at: new Date().toISOString(),
    published: p.published !== false,
  };
  const a = db.read("updates"); a.push(row); db.write("updates", a);
  addNotice({
    app_id: row.app_id, kind: "update", title: `Cập nhật ${row.version}`,
    body: row.notice,
  });
  return row;
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
    if (method === "POST" && rest === "/chat") return send(res, 200, await kernel.chat({ message: json.message || json.text, history: json.history || [] }));
    if (method === "POST" && rest === "/act") return send(res, 200, await kernel.invoke(json.name, json.args || {}, json.ctx || {}));
    return send(res, 404, { ok: false, error: "Unknown AI route" });
  } catch (e) {
    return send(res, 400, { ok: false, error: String(e.message || e) });
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  activePath = u.pathname;
  if (req.method === "OPTIONS") return send(res, 204, { ok: true });

  if (req.method === "GET" && u.pathname === "/api/health") {
    const s = settings.get();
    return send(res, 200, { ok: true, service: "solohost-feedback-hub", version: "2.3.0", hub_id: s.hub_id || HUB_ID, public_base_url: s.public_base_url || PUBLIC_BASE_URL || null, needs_setup: !settings.hasPassword() });
  }

  if (req.method === "GET" && u.pathname === "/api/session") {
    return send(res, 200, { ok: true, authed: admin(req), needs_setup: !settings.hasPassword() });
  }

  if (req.method === "POST" && u.pathname === "/api/setup") {
    if (settings.hasPassword()) return send(res, 409, { ok: false, error: "Password already set" });
    const { json } = await readBody(req);
    const pw = clean(json?.password, 200);
    if (pw.length < 6) return send(res, 400, { ok: false, error: "Password min 6 chars" });
    settings.update({ admin_password: pw });
    setSession(res);
    return send(res, 201, { ok: true, setup: true });
  }

  if (req.method === "POST" && u.pathname === "/api/login") {
    if (limited(req, 8, 15 * 60 * 1000, "login")) return send(res, 429, { ok: false, error: "Too many login attempts" });
    const { json } = await readBody(req);
    const pw = String(json?.password || "");
    const ok = settings.checkPassword(pw);
    if (!ok) return send(res, 401, { ok: false, error: "Sai mật khẩu" });
    setSession(res);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && u.pathname === "/api/logout") {
    const sid = parseCookie(req).SHFH_SESSION;
    if (sid) sessions.delete(sid);
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
    const view = settings.update(json || {});
    applyAiEnv(settings.get());
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

  if (u.pathname.startsWith("/ai")) {
    return handleAi(req, res, u.pathname.slice(3) || "/", req.method);
  }

  // admin
  if (req.method === "GET" && u.pathname === "/api/admin/overview") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const items = db.read("feedback");
    return send(res, 200, {
      ok: true,
      apps: rankedApps(),
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
    a[i].status = json.status; a[i].updated_at = new Date().toISOString();
    if (json.admin_note) a[i].admin_note = clean(json.admin_note, 1000);
    db.write("feedback", a);
    return send(res, 200, { ok: true, item: a[i] });
  }

  if (req.method === "GET" && u.pathname === "/api/apps") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    return send(res, 200, { ok: true, items: rankedApps() });
  }

  if (req.method === "POST" && u.pathname === "/api/apps") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    if (!json?.app_id) return send(res, 400, { ok: false, error: "app_id required" });
    return send(res, 201, { ok: true, item: db.upsertApp(json) });
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

  if (req.method === "POST" && u.pathname === "/api/ai/classify") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    const id = json?.id;
    const rows = db.read("feedback");
    const i = rows.findIndex((x) => x.id === id);
    if (i < 0) return send(res, 404, { ok: false, error: "Not found" });
    try {
      const prompt = `Classify this app feedback. Reply JSON only: {"type":"bug|idea|improvement|review","sentiment":"positive|neutral|negative","priority":"P0|P1|P2|P3","summary":"...","suggested_action":"..."}\nAPP=${rows[i].app_id} TYPE=${rows[i].type} RATING=${rows[i].rating}\nMSG=${rows[i].message}`;
      const out = await kernel.chat({ message: prompt });
      let parsed = null;
      const m = String(out.text || out.message || "").match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      rows[i].ai = { ...(parsed || localClassify(rows[i])), classifier: parsed ? "kernel" : "local", raw: out.text };
      db.write("feedback", rows);
      return send(res, 200, { ok: true, item: rows[i] });
    } catch (e) {
      rows[i].ai = { ...localClassify(rows[i]), error: String(e.message || e) };
      db.write("feedback", rows);
      return send(res, 200, { ok: true, item: rows[i], fallback: true });
    }
  }

  if (req.method === "POST" && u.pathname === "/api/ai/rewrite") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    if (!json?.input) return send(res, 400, { ok: false, error: "Input is required" });
    try {
      const out = await kernel.chat({
        message: `Rewrite into a short mobile update notice. Preserve facts. Do not invent features. Output ONLY 1 title + 1-3 bullets.\n\n${clean(json.input, 7000)}`,
      });
      return send(res, 200, { ok: true, text: out.text || out.message || "" });
    } catch (e) {
      return send(res, 502, { ok: false, error: "AI service unavailable: " + e.message });
    }
  }

  if (req.method === "GET" && u.pathname === "/api/updates/all") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    return send(res, 200, { ok: true, items: db.read("updates").sort((x, y) => y.created_at.localeCompare(x.created_at)) });
  }

  if (req.method === "POST" && u.pathname === "/api/updates") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    if (!json?.app_id || !json?.version || !json?.notice) return send(res, 400, { ok: false, error: "app_id, version and notice are required" });
    return send(res, 201, { ok: true, item: publishUpdate(json) });
  }

  if (req.method === "PATCH" && u.pathname.startsWith("/api/updates/")) {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const id = decodeURIComponent(u.pathname.split("/").pop());
    const { json } = await readBody(req);
    const a = db.read("updates"); const i = a.findIndex((x) => x.id === id);
    if (i < 0) return send(res, 404, { ok: false, error: "Not found" });
    if (typeof json.published === "boolean") a[i].published = json.published;
    db.write("updates", a);
    return send(res, 200, { ok: true, item: a[i] });
  }

  if (req.method === "POST" && u.pathname === "/api/notices/broadcast") {
    if (!admin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { json } = await readBody(req);
    if (!json?.app_id || !json?.body) return send(res, 400, { ok: false, error: "app_id and body required" });
    return send(res, 201, { ok: true, item: addNotice({ ...json, kind: json.kind || "custom", title: json.title || "Thông báo" }) });
  }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/admin"))
    return serveFile(res, path.join(publicDir, "admin.html"));
  if (req.method === "GET" && (u.pathname === "/feedback" || u.pathname === "/public"))
    return serveFile(res, path.join(publicDir, "index.html"));
  if (req.method === "GET" && u.pathname.startsWith("/client/")) {
    const name = path.basename(u.pathname);
    if (!/^[a-zA-Z0-9._-]+\.js$/.test(name)) return text(res, 404, "Not found");
    return serveFile(res, path.join(publicDir, "client", name));
  }
  text(res, 404, "Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SoloHost Feedback Hub ${HUB_ID} v2 listening on :${PORT}`);
});
