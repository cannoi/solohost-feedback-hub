import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 8080);
const HUB_URL = String(process.env.FEEDBACK_HUB_URL || "").replace(/\/$/, "");
const APP_KEY = process.env.FEEDBACK_HUB_APP_KEY || "";
const WEBHOOK_SECRET = process.env.FEEDBACK_HUB_WEBHOOK_SECRET || "";
const ORDER_AMOUNT_PI = Number(process.env.ORDER_AMOUNT_PI || 1);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "connector.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS received_webhook_events(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,received_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hub_sessions(order_reference TEXT PRIMARY KEY,session_id TEXT NOT NULL,fee_order_id TEXT,payment_id TEXT,updated_at TEXT NOT NULL);");
if (!db.prepare("PRAGMA table_info(hub_sessions)").all().some((column) => column.name === "fee_order_id")) db.exec("ALTER TABLE hub_sessions ADD COLUMN fee_order_id TEXT");
if (!HUB_URL || !APP_KEY) console.error("Set FEEDBACK_HUB_URL and FEEDBACK_HUB_APP_KEY before using connector routes.");

function reply(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(body); }
async function jsonBody(req, max = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error("request too large"), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}
async function rawBody(req, max = 256 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error("request too large"), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
async function hub(route, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${HUB_URL}${route}`, { method, signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${APP_KEY}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Hub returned HTTP ${response.status}`), { status: response.status, code: data?.error?.code });
  return data?.data;
}
function verifySignature(req, rawBody) {
  if (Buffer.byteLength(WEBHOOK_SECRET) < 32) return false;
  const eventId = String(req.headers["x-shfh-event-id"] || ""), signature = String(req.headers["x-shfh-signature"] || ""), timestamp = String(req.headers["x-shfh-timestamp"] || "");
  if (!/^evt_[A-Za-z0-9_-]{12,80}$/.test(eventId) || !/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match || match[1] !== timestamp) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${eventId}.${rawBody}`).digest();
  const actual = Buffer.from(match[2], "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" }); return res.end(fs.readFileSync(new URL("./public/index.html", import.meta.url))); }
    if (req.method === "GET" && url.pathname === "/health") return reply(res, 200, { ok: true, hub_configured: Boolean(HUB_URL && APP_KEY), database: "ready" });
    if (req.method === "POST" && url.pathname === "/feedback") {
      const input = await jsonBody(req);
      const result = await hub("/api/v1/feedback", { method: "POST", body: { category: input.category, title: input.title, message: input.message, rating: input.rating, anonymous: input.anonymous !== false, contact_email: input.contact_email, follow_up: input.follow_up === true } });
      return reply(res, 201, { ok: true, feedback: result });
    }
    if (req.method === "GET" && url.pathname === "/notifications") {
      const recipientId = url.searchParams.get("recipient_id");
      if (!recipientId) return reply(res, 400, { ok: false, error: "recipient_id is required" });
      return reply(res, 200, { ok: true, ...(await hub(`/api/v1/notifications?recipient_id=${encodeURIComponent(recipientId)}&unread=true`)) });
    }
    if (req.method === "POST" && url.pathname === "/payments/session") {
      const input = await jsonBody(req), order = String(input.order_reference || "").slice(0, 100);
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(order)) return reply(res, 400, { ok: false, error: "valid order_reference required" });
      const amountSubunits = Math.round(ORDER_AMOUNT_PI * 10_000_000);
      if (!Number.isSafeInteger(amountSubunits) || amountSubunits <= 0 || Math.abs(ORDER_AMOUNT_PI * 10_000_000 - amountSubunits) > 0.00001) return reply(res, 500, { ok: false, error: "ORDER_AMOUNT_PI must be a positive amount with at most seven decimals" });
      const fee = await hub("/api/v1/fees/orders", { method: "POST", headers: { "Idempotency-Key": `fee:${order}` }, body: { amount_subunits: amountSubunits, amount_scale: 7, currency: "PI", provider: "pi", order_reference: order, description: `Sample order ${order}`, idempotency_key: `fee:${order}` } });
      const session = await hub("/api/v1/payments/create", { method: "POST", headers: { "Idempotency-Key": `sample:${order}` }, body: { amount: ORDER_AMOUNT_PI, memo: `Sample order ${order}`, order_reference: order, idempotency_key: `sample:${order}`, fee_order_id: fee.order.order_id, metadata: { order_reference: order } } });
      db.prepare("INSERT INTO hub_sessions(order_reference,session_id,fee_order_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(order_reference) DO UPDATE SET session_id=excluded.session_id,fee_order_id=excluded.fee_order_id,updated_at=excluded.updated_at").run(order, session.session_id, fee.order.order_id, new Date().toISOString());
      return reply(res, 201, { ok: true, session });
    }
    if (req.method === "POST" && url.pathname === "/payments/incomplete") {
      const input = await jsonBody(req), paymentId = String(input.payment_id || ""), txid = String(input.txid || "");
      const order = db.prepare("SELECT session_id FROM hub_sessions WHERE payment_id=?").get(paymentId);
      if (!order) return reply(res, 404, { ok: false, error: "No local Hub session is linked to this incomplete Pi payment." });
      return reply(res, 200, { ok: true, payment: await hub(`/api/v1/payments/${encodeURIComponent(order.session_id)}/complete`, { method: "POST", body: { payment_id: paymentId, txid } }) });
    }
    const paymentAction = url.pathname.match(/^\/payments\/([^/]+)\/(approve|complete)$/);
    if (req.method === "POST" && paymentAction) {
      const input = await jsonBody(req), sessionId = decodeURIComponent(paymentAction[1]);
      const route = `/api/v1/payments/${encodeURIComponent(sessionId)}/${paymentAction[2]}`;
      const body = paymentAction[2] === "approve" ? { payment_id: input.payment_id, user_access_token: input.user_access_token } : { payment_id: input.payment_id, txid: input.txid };
      const result = await hub(route, { method: "POST", body });
      if (paymentAction[2] === "approve") db.prepare("UPDATE hub_sessions SET payment_id=?,updated_at=? WHERE session_id=?").run(input.payment_id, new Date().toISOString(), sessionId);
      return reply(res, 200, { ok: true, payment: result });
    }
    if (req.method === "POST" && url.pathname === "/webhooks/feedback-hub") {
      const raw = await rawBody(req);
      if (!verifySignature(req, raw)) return reply(res, 401, { ok: false, error: "invalid webhook signature" });
      let event; try { event = JSON.parse(raw); } catch { return reply(res, 400, { ok: false, error: "invalid JSON" }); }
      const eventId = String(req.headers["x-shfh-event-id"]);
      const result = db.prepare("INSERT OR IGNORE INTO received_webhook_events(event_id,event_type,payload_json,received_at) VALUES(?,?,?,?)").run(eventId, String(event.type || "unknown"), raw, new Date().toISOString());
      return reply(res, 200, { ok: true, duplicate: result.changes === 0 });
    }
    return reply(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return reply(res, Number(error.status) || 502, { ok: false, error: error.message || "request failed", code: error.code || "CONNECTOR_ERROR" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`SoloHost connector sample listening on :${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
