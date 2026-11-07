import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createWebhookHeaders } from "../lib/webhook-security.js";

async function port() { const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function readBody(req) { const chunks=[]; for await(const c of req) chunks.push(c); return Buffer.concat(chunks).toString(); }
test("SoloHost sample uses backend credentials, serves actual HTTP routes, and verifies/deduplicates signed webhooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-connector-sample-")), samplePort = await port();
  const hubCalls = [];
  const hubServer = http.createServer(async (req, res) => {
    const raw = await readBody(req); const auth = req.headers.authorization;
    if (auth !== "Bearer shfh_live_test_key") { res.writeHead(401).end(JSON.stringify({ error: { message: "unauthorized" } })); return; }
    let data = {};
    hubCalls.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/api/v1/feedback") data = { id: "FB-SAMPLE", application_id: "sample" };
    else if (req.url === "/api/v1/fees/orders") data = { order: { order_id: "FO-123e4567-e89b-12d3-a456-426614174000" } };
    else if (req.url === "/api/v1/payments/create") data = { session_id: "PS-SAMPLE", fee_order_id: "FO-123e4567-e89b-12d3-a456-426614174000", amount: 1, memo: "Sample", metadata: { hub_session_id: "PS-SAMPLE" } };
    else if (req.url === "/api/v1/payments/PS-SAMPLE/approve") data = { status: "approved", verification_state: "unverified" };
    else if (req.url === "/api/v1/payments/PS-SAMPLE/complete") data = { status: "completed", verification_state: "verified" };
    else if (req.url.startsWith("/api/v1/notifications")) data = { items: [] };
    else { res.writeHead(404).end(JSON.stringify({ error: { message: "not found" } })); return; }
    res.writeHead(req.url === "/api/v1/feedback" || req.url === "/api/v1/fees/orders" || req.url === "/api/v1/payments/create" ? 201 : 200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, data, input: raw ? JSON.parse(raw) : null }));
  });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubUrl = `http://127.0.0.1:${hubServer.address().port}`;
  const secret = "sample-webhook-secret-".padEnd(40, "x");
  const child = spawn(process.execPath, ["server.mjs"], { cwd: path.resolve("examples/solohost-connector"), env: { ...process.env, PORT: String(samplePort), DATA_DIR: path.join(root, "data"), FEEDBACK_HUB_URL: hubUrl, FEEDBACK_HUB_APP_KEY: "shfh_live_test_key", FEEDBACK_HUB_WEBHOOK_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (x) => logs += x); child.stderr.on("data", (x) => logs += x);
  const base = `http://127.0.0.1:${samplePort}`;
  try {
    const end = Date.now() + 8000;
    while (Date.now() < end) { try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {} if (child.exitCode != null) throw new Error(logs); await new Promise((r) => setTimeout(r, 50)); }
    assert.equal((await (await fetch(`${base}/health`)).json()).hub_configured, true);
    const feedback = await fetch(`${base}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "bug", title: "Sample", message: "From connector" }) });
    assert.equal(feedback.status, 201); assert.equal((await feedback.json()).feedback.application_id, "sample");
    const session = await fetch(`${base}/payments/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_reference: "sample-42" }) });
    assert.equal(session.status, 201); assert.equal((await session.json()).session.session_id, "PS-SAMPLE");
    const feeCall = hubCalls.find((call) => call.url === "/api/v1/fees/orders");
    const paymentCall = hubCalls.find((call) => call.url === "/api/v1/payments/create");
    assert.equal(feeCall.body.provider, "pi"); assert.equal(feeCall.body.amount_scale, 7);
    assert.equal(paymentCall.body.fee_order_id, "FO-123e4567-e89b-12d3-a456-426614174000");
    const approve = await fetch(`${base}/payments/PS-SAMPLE/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_id: "pi_42", user_access_token: "secret-user-token" }) });
    assert.equal(approve.status, 200);
    const complete = await fetch(`${base}/payments/PS-SAMPLE/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_id: "pi_42", txid: "a".repeat(64) }) });
    assert.equal((await complete.json()).payment.verification_state, "verified");
    const raw = JSON.stringify({ id: "evt_sample_12345", type: "payment.completed", data: { session_id: "PS-SAMPLE" } }), eventId = "evt_sample_12345";
    const signed = createWebhookHeaders({ secret, eventId, rawBody: raw });
    async function deliver(signature = signed.signature) { return fetch(`${base}/webhooks/feedback-hub`, { method: "POST", headers: { "Content-Type": "application/json", "X-SHFH-Event-Id": eventId, "X-SHFH-Timestamp": signed.timestamp, "X-SHFH-Signature": signature }, body: raw }); }
    assert.equal((await deliver("t=1,v1=" + "0".repeat(64))).status, 401);
    assert.equal((await (await deliver()).json()).duplicate, false);
    assert.equal((await (await deliver()).json()).duplicate, true);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => hubServer.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
