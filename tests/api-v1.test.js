import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createApiV1 } from "../lib/api-v1.js";
import { createNotificationService } from "../lib/notifications.js";
import { createSecretBox } from "../lib/secret-box.js";
import { createWebhookService } from "../lib/webhooks.js";
import { createOwnerService } from "../lib/owners.js";
import { createPiPaymentService } from "../lib/pi-payments.js";
import { createFeeLedgerService } from "../lib/fee-ledger.js";

async function withApi(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-api-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  const appService = createAppService(opened.db);
  const webhookService = createWebhookService({ db: opened.db, secretBox: createSecretBox(crypto.randomBytes(32).toString("base64url")), resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  const notificationService = createNotificationService({ db: opened.db, webhookService });
  const ownerService = createOwnerService({ db: opened.db });
  const feeLedger = createFeeLedgerService({ db: opened.db, webhookService, mockPaymentsEnabled: true });
  let piDto = null;
  const piClient = { verifyUser: async () => ({ uid: "pi-http-user" }), getPayment: async () => piDto, approvePayment: async () => { piDto = { ...piDto, status: { ...piDto.status, developer_approved: true } }; return piDto; }, completePayment: async (_id, txid) => { piDto = { ...piDto, status: { ...piDto.status, developer_completed: true }, transaction: { txid, verified: true } }; return piDto; } };
  const piPaymentService = createPiPaymentService({ db: opened.db, secretBox: createSecretBox(crypto.randomBytes(32).toString("base64url")), clientForApp: () => piClient, webhookService, feeLedger });
  const api = createApiV1({ db: opened.db, appService, notificationService, webhookService, ownerService, piPaymentService, feeLedger, uploadDir: path.join(dataDir, "uploads"), isPlatformAdmin: (req) => req.headers["x-test-admin"] === "yes" });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!await api(req, res, url)) { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = "GET", token, admin = false, cookie, csrf, body, contentType = "application/json" } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (admin) headers["x-test-admin"] = "yes";
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers["X-CSRF-Token"] = csrf;
    if (body !== undefined) headers["Content-Type"] = contentType;
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.arrayBuffer();
    return { status: response.status, json: data, headers: response.headers };
  }
  try { await run({ opened, appService, notificationService, webhookService, ownerService, piPaymentService, feeLedger, setPiDto: (value) => { piDto = value; }, request }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    opened.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("fee order HTTP API enforces scopes and tenant isolation with mock confirmation", async () => {
  await withApi(async ({ appService, request }) => {
    const tokenA = registerAndApprove(appService, "fee-http-a", ["fees:create", "fees:read", "fees:simulate"]);
    const tokenB = registerAndApprove(appService, "fee-http-b", ["fees:read"]);
    const deniedCreate = await request("/api/v1/fees/orders", { method: "POST", token: tokenB, body: { amount_subunits: 1250, amount_scale: 2, currency: "USD" } });
    assert.equal(deniedCreate.status, 403);
    const created = await request("/api/v1/fees/orders", { method: "POST", token: tokenA, body: { idempotency_key: "http-order-key-0001", amount_subunits: 1250, amount_scale: 2, currency: "USD", provider: "mock", order_reference: "order-a" } });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.order.status, "pending");
    const replay = await request("/api/v1/fees/orders", { method: "POST", token: tokenA, body: { idempotency_key: "http-order-key-0001", amount_subunits: 1250, amount_scale: 2, currency: "USD", provider: "mock", order_reference: "order-a" } });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.order.order_id, created.json.data.order.order_id);
    assert.equal((await request(`/api/v1/fees/orders/${created.json.data.order.order_id}`, { token: tokenB })).status, 404);
    const before = await request(`/api/v1/fees/orders/${created.json.data.order.order_id}`, { token: tokenA });
    assert.equal(before.json.data.service_delivery_allowed, false);
    const settled = await request(`/api/v1/fees/orders/${created.json.data.order.order_id}/settle-mock`, { method: "POST", token: tokenA, body: {} });
    assert.equal(settled.status, 200);
    assert.equal(settled.json.data.order.verification_state, "verified");
    assert.equal(settled.json.data.order.status, "paid");
    const after = await request(`/api/v1/fees/orders/${created.json.data.order.order_id}`, { token: tokenA });
    assert.equal(after.json.data.service_delivery_allowed, true);
    const history = await request(`/api/v1/fees/orders/${created.json.data.order.order_id}/history`, { token: tokenA });
    assert.deepEqual(history.json.data.items.map((event) => event.action), ["order.created", "provider.event_received", "payment.confirmed"]);
  });
});

function registerAndApprove(apps, appId, scopes = ["feedback:write", "feedback:read"]) {
  apps.requestRegistration({ app_id: appId, app_name: appId });
  apps.approveApp(appId);
  return apps.issueCredential(appId, scopes).secret;
}

test("HTTP registration stays pending until admin approval and credentials require admin", async () => {
  await withApi(async ({ request, appService }) => {
    const created = await request("/api/v1/apps/register", { method: "POST", body: { app_id: "new-owner-app", app_name: "New Owner App" } });
    assert.equal(created.status, 202);
    assert.equal(created.json.data.integration_status, "pending");
    const denied = await request("/api/v1/apps/new-owner-app/approve", { method: "POST" });
    assert.equal(denied.status, 401);
    const approved = await request("/api/v1/apps/new-owner-app/approve", { method: "POST", admin: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.data.integration_status, "approved");
    const issued = await request("/api/v1/apps/new-owner-app/credentials", { method: "POST", admin: true, body: { scopes: ["feedback:write"] } });
    assert.equal(issued.status, 201);
    assert.match(issued.json.data.secret, /^shfh_live_/);
    assert.equal((await request("/api/v1/apps/new-owner-app", { method: "DELETE" })).status, 401);
    const deleted = await request("/api/v1/apps/new-owner-app", { method: "DELETE", admin: true });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.data.deleted, true);
    assert.equal(appService.authenticateCredential(issued.json.data.secret), null);
  });
});

test("new application registrations have a strict per-IP daily limit", async () => {
  await withApi(async ({ request }) => {
    for (let i = 1; i <= 3; i += 1) {
      const created = await request("/api/v1/apps/register", { method: "POST", body: { app_id: `daily-app-${i}`, app_name: `Daily App ${i}` } });
      assert.equal(created.status, 202);
    }
    const overLimit = await request("/api/v1/apps/register", { method: "POST", body: { app_id: "daily-app-4", app_name: "Daily App 4" } });
    assert.equal(overLimit.status, 429);
    assert.equal(overLimit.json.error.code, "RATE_LIMITED");
  });
});

test("feedback HTTP writes and reads remain bound to credential tenant despite app_id spoofing", async () => {
  await withApi(async ({ appService, notificationService, request }) => {
    const tokenA = registerAndApprove(appService, "tenant-a");
    const tokenB = registerAndApprove(appService, "tenant-b");
    const a = await request("/api/v1/feedback", { method: "POST", token: tokenA, body: { app_id: "tenant-b", category: "bug", title: "A issue", message: "Tenant A report" } });
    const b = await request("/api/v1/feedback", { method: "POST", token: tokenB, body: { category: "question", title: "B issue", message: "Tenant B report" } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json.data.application_id, "tenant-a");
    assert.equal(a.json.data.app_id, "tenant-a");
    const listA = await request("/api/v1/feedback", { token: tokenA });
    assert.equal(listA.json.data.items.length, 1);
    assert.equal(listA.json.data.items[0].message, "Tenant A report");
    const crossRead = await request(`/api/v1/feedback/${encodeURIComponent(b.json.data.id)}`, { token: tokenA });
    assert.equal(crossRead.status, 404);
  });
});

test("feedback HTTP rejects bad credentials, missing scopes, invalid input, and duplicate submissions", async () => {
  await withApi(async ({ appService, request }) => {
    const readOnly = registerAndApprove(appService, "read-only", ["feedback:read"]);
    const denied = await request("/api/v1/feedback", { method: "POST", token: readOnly, body: { category: "bug", title: "x", message: "y" } });
    assert.equal(denied.status, 403);
    const badAuth = await request("/api/v1/feedback", { token: "shfh_live_invalid_invalid_invalid_invalid" });
    assert.equal(badAuth.status, 401);
    const writer = registerAndApprove(appService, "writer");
    const invalid = await request("/api/v1/feedback", { method: "POST", token: writer, body: { category: "made-up", title: "x", message: "body" } });
    assert.equal(invalid.status, 400);
    const invalidRating = await request("/api/v1/feedback", { method: "POST", token: writer, body: { category: "bug", title: "x", message: "body", rating: 0 } });
    assert.equal(invalidRating.status, 400);
    const first = await request("/api/v1/feedback", { method: "POST", token: writer, body: { category: "bug", title: "Repeated", message: "same report" } });
    const duplicate = await request("/api/v1/feedback", { method: "POST", token: writer, body: { category: "bug", title: "Repeated", message: "same report" } });
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, "DUPLICATE_FEEDBACK");
    const list = await request("/api/v1/feedback?limit=999", { token: writer });
    assert.equal(list.json.meta.limit, 100);
  });
});

test("integration health reports SQLite readiness without revealing details", async () => {
  await withApi(async ({ request }) => {
    const response = await request("/api/v1/integration/health");
    assert.equal(response.status, 200);
    assert.equal(response.json.data.status, "ok");
    assert.equal(response.json.data.database, "ready");
    assert.equal(JSON.stringify(response.json).includes("feedback-hub.sqlite"), false);
  });
});

test("application can update tenant feedback and add a conversation reply", async () => {
  await withApi(async ({ appService, request }) => {
    const token = registerAndApprove(appService, "feedback-workflow", ["feedback:write", "feedback:read", "feedback:manage"]);
    const created = await request("/api/v1/feedback", { method: "POST", token, body: { category: "bug", title: "Workflow", message: "A reproducible issue" } });
    const updated = await request(`/api/v1/feedback/${created.json.data.id}`, { method: "PATCH", token, body: { status: "in_progress", priority: "P1" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.status, "in_progress");
    assert.equal(updated.json.data.priority, "P1");
    const replied = await request(`/api/v1/feedback/${created.json.data.id}/messages`, { method: "POST", token, body: { body: "We are investigating", private: false } });
    assert.equal(replied.status, 201);
    const messages = await request(`/api/v1/feedback/${created.json.data.id}/messages`, { token });
    assert.equal(messages.json.data.items.length, 1);
    assert.equal(messages.json.data.items[0].body, "We are investigating");
  });
});

test("notification API creates private drafts and only returns published tenant notices", async () => {
  await withApi(async ({ appService, notificationService, request }) => {
    const write = registerAndApprove(appService, "notify-app", ["notifications:write", "notifications:read"]);
    const other = registerAndApprove(appService, "notify-other", ["notifications:read"]);
    const created = await request("/api/v1/notifications", { method: "POST", token: write, body: { title: "Release", body: "Version 2", type: "release" } });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.workflow_state, "draft");
    assert.equal((await notificationService.dispatchDue()).delivered, 0);
    const own = await request("/api/v1/notifications", { token: write });
    const isolated = await request("/api/v1/notifications", { token: other });
    assert.equal(own.json.data.items.length, 0);
    assert.equal(isolated.json.data.items.length, 0);
  });
});

test("payment sessions enforce tenant ownership and idempotency without claiming verification", async () => {
  await withApi(async ({ appService, request }) => {
    const token = registerAndApprove(appService, "payment-owner", ["payments:create", "payments:read"]);
    const another = registerAndApprove(appService, "payment-other", ["payments:read"]);
    const body = { amount: 1.25, memo: "Service order", order_reference: "order-91", metadata: { order_id: "order-91" } };
    const created = await request("/api/v1/payments/create", { method: "POST", token, body: { ...body, idempotency_key: "order-91-payment" } });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.status, "created");
    assert.equal(created.json.data.verification_state, "unverified");
    const replay = await request("/api/v1/payments/create", { method: "POST", token, body: { ...body, idempotency_key: "order-91-payment" } });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.session_id, created.json.data.session_id);
    const mismatch = await request("/api/v1/payments/create", { method: "POST", token, body: { ...body, amount: 2, idempotency_key: "order-91-payment" } });
    assert.equal(mismatch.status, 409);
    const foreign = await request(`/api/v1/payments/${created.json.data.session_id}`, { token: another });
    assert.equal(foreign.status, 404);
    const invalid = await request("/api/v1/payments/create", { method: "POST", token, body: { amount: 0, idempotency_key: "bad-amount" } });
    assert.equal(invalid.status, 400);
  });
});

test("customer follow-up tokens can only read and reply to their feedback, never private notes", async () => {
  await withApi(async ({ appService, request, opened }) => {
    const token = registerAndApprove(appService, "customer-followup", ["feedback:write", "feedback:read", "feedback:manage"]);
    const created = await request("/api/v1/feedback", { method: "POST", token, body: { category: "question", title: "Need help", message: "My question", anonymous: false, contact_email: "pioneer@example.com", follow_up: true } });
    assert.equal(created.status, 201);
    const tracking = created.json.data.follow_up_token;
    assert.match(tracking, /^fhcust_/);
    assert.equal(created.json.data.follow_up_url, "/feedback/track");
    const fbId = created.json.data.id;
    const lookup = await request("/api/v1/customer/feedback", { token: tracking });
    assert.equal(lookup.status, 200); assert.equal(lookup.json.data.id, fbId);
    const note = await request(`/api/v1/feedback/${fbId}/messages`, { method: "POST", admin: true, body: { body: "Staff only note", private: true } });
    assert.equal(note.status, 201);
    const customerView = await request(`/api/v1/customer/feedback/${fbId}`, { token: tracking });
    assert.equal(customerView.status, 200);
    assert.equal(customerView.json.data.messages.length, 0);
    assert.equal(JSON.stringify(customerView.json).includes("Staff only"), false);
    const reply = await request(`/api/v1/customer/feedback/${fbId}/messages`, { method: "POST", token: tracking, body: { body: "One more detail" } });
    assert.equal(reply.status, 201);
    const own = await request(`/api/v1/customer/feedback/${fbId}`, { token: tracking });
    assert.equal(own.json.data.messages.length, 1);
    assert.equal((await request("/api/v1/customer/feedback", { token: tracking })).json.data.messages.length, 1);
    const other = await request(`/api/v1/customer/feedback/${created.json.data.id}-other`, { token: tracking });
    assert.equal(other.status, 404);
  });
});

test("customer deletion removes feedback, conversations, and follow-up access", async () => {
  await withApi(async ({ appService, request, opened }) => {
    const token = registerAndApprove(appService, "customer-delete", ["feedback:write", "feedback:read"]);
    const created = await request("/api/v1/feedback", { method: "POST", token, body: { category: "question", title: "Delete me", message: "Personal data", anonymous: false, contact_email: "delete@example.com", follow_up: true } });
    const id = created.json.data.id, customerToken = created.json.data.follow_up_token;
    const deletion = await request(`/api/v1/customer/feedback/${id}`, { method: "DELETE", token: customerToken });
    assert.equal(deletion.status, 200);
    assert.equal((await request(`/api/v1/customer/feedback/${id}`, { token: customerToken })).status, 404);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM feedback WHERE id=?").get(id).n, 0);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM feedback_access_tokens WHERE feedback_id=?").get(id).n, 0);
    assert.equal(opened.db.prepare("SELECT action FROM audit_events WHERE subject_id=?").get(id).action, "feedback.deleted");
  });
});

test("attachment HTTP routes sniff content and isolate downloads to the owning application", async () => {
  await withApi(async ({ appService, request }) => {
    const owner = registerAndApprove(appService, "attachment-owner", ["feedback:write", "feedback:read", "feedback:manage"]);
    const other = registerAndApprove(appService, "attachment-other", ["feedback:read", "feedback:manage"]);
    const created = await request("/api/v1/feedback", { method: "POST", token: owner, body: { category: "bug", title: "Screenshot", message: "See attached" } });
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const stored = await request(`/api/v1/feedback/${created.json.data.id}/attachments?filename=screen.png`, { method: "POST", token: owner, contentType: "image/png", body: png });
    assert.equal(stored.status, 201);
    const downloaded = await request(`/api/v1/feedback/${created.json.data.id}/attachments/${stored.json.data.attachment_id}`, { token: owner });
    assert.equal(downloaded.status, 200);
    assert.equal(Buffer.from(downloaded.json).equals(png), true);
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    const crossTenant = await request(`/api/v1/feedback/${created.json.data.id}/attachments/${stored.json.data.attachment_id}`, { token: other });
    assert.equal(crossTenant.status, 404);
    const fake = await request(`/api/v1/feedback/${created.json.data.id}/attachments?filename=page.png`, { method: "POST", token: owner, contentType: "image/png", body: Buffer.from("<script>alert(1)</script>") });
    assert.equal(fake.status, 400);
  });
});

test("webhook API issues secrets once, hides them on list, and enforces tenant ownership", async () => {
  await withApi(async ({ appService, webhookService, request }) => {
    const owner = registerAndApprove(appService, "webhook-owner", ["webhooks:manage", "webhooks:read", "feedback:write"]);
    const other = registerAndApprove(appService, "webhook-other", ["webhooks:manage"]);
    const bad = await request("/api/v1/webhooks/register", { method: "POST", token: owner, body: { endpoint: "https://public.example.com/hook", events: ["feedback.created", "made.up"] } });
    assert.equal(bad.status, 400);
    const created = await request("/api/v1/webhooks/register", { method: "POST", token: owner, body: { endpoint: "https://public.example.com/hook", events: ["feedback.created"] } });
    assert.equal(created.status, 201);
    assert.match(created.json.data.secret, /^shfh_whsec_/);
    const listed = await request("/api/v1/webhooks", { token: owner });
    assert.equal(listed.json.data.items.length, 1);
    assert.equal(JSON.stringify(listed.json).includes("shfh_whsec_"), false);
    const crossTenant = await request(`/api/v1/webhooks/${created.json.data.webhook_id}/disable`, { method: "POST", token: other });
    assert.equal(crossTenant.status, 404);
    const rotated = await request(`/api/v1/webhooks/${created.json.data.webhook_id}/rotate`, { method: "POST", token: owner });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.json.data.secret, created.json.data.secret);
    assert.equal(webhookService.listSubscriptions({ applicationId: "webhook-owner" })[0].active, true);
    const feedback = await request("/api/v1/feedback", { method: "POST", token: owner, body: { category: "bug", title: "Emit event", message: "Should enqueue" } });
    assert.equal(feedback.status, 201);
    const sent = await webhookService.dispatchDue({ deliver: async () => ({ statusCode: 202 }) });
    assert.equal(sent.delivered, 1);
    const history = await request("/api/v1/webhooks/deliveries", { token: owner });
    assert.equal(history.json.data.items[0].event_type, "feedback.created");
    assert.equal(history.json.data.items[0].status, "delivered");
  });
});

test("feedback search, sorting, analytics, and export stay scoped to the application", async () => {
  await withApi(async ({ appService, request }) => {
    const owner = registerAndApprove(appService, "feedback-analytics", ["feedback:write", "feedback:read"]);
    await request("/api/v1/feedback", { method: "POST", token: owner, body: { category: "bug", title: "Alpha error", message: "unique keyword nebula", rating: 2 } });
    await request("/api/v1/feedback", { method: "POST", token: owner, body: { category: "question", title: "Beta help", message: "another request", rating: 5 } });
    const found = await request("/api/v1/feedback?q=nebula&sort=rating&order=asc", { token: owner });
    assert.equal(found.json.data.items.length, 1);
    assert.equal(found.json.data.items[0].title, "Alpha error");
    const analytics = await request("/api/v1/analytics/feedback", { token: owner });
    assert.equal(analytics.json.data.total, 2);
    assert.equal(analytics.json.data.average_rating, 3.5);
    const exportResult = await request("/api/v1/feedback/export?format=csv", { token: owner });
    assert.equal(exportResult.status, 200);
    assert.equal(Buffer.from(exportResult.json).toString().includes("Alpha error"), true);
  });
});

test("application owner invite, login, CSRF, membership scope, credential rotation, and secret-safe Pi config work over HTTP", async () => {
  await withApi(async ({ appService, ownerService, piPaymentService, request }) => {
    appService.requestRegistration({ app_id: "owner-http-one", app_name: "Owner App One" }); appService.approveApp("owner-http-one");
    appService.requestRegistration({ app_id: "owner-http-two", app_name: "Owner App Two" }); appService.approveApp("owner-http-two");
    const invite = await request("/api/v1/apps/owner-http-one/owners/invite", { method: "POST", admin: true, body: { email: "owner-http@example.com", role: "owner" } });
    assert.equal(invite.status, 201);
    const claim = await request("/api/v1/owner/claim", { method: "POST", body: { token: invite.json.data.token, email: "owner-http@example.com", password: "a secure owner password" } });
    assert.equal(claim.status, 201);
    const login = await request("/api/v1/owner/login", { method: "POST", body: { email: "owner-http@example.com", password: "a secure owner password" } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const csrf = login.json.data.csrf_token;
    const apps = await request("/api/v1/owner/apps", { cookie });
    assert.equal(apps.json.data.items.length, 1);
    const overview = await request("/api/v1/owner/apps/owner-http-one", { cookie });
    assert.equal(overview.status, 200);
    assert.equal(overview.json.data.app.application_id, "owner-http-one");
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/settings", { cookie })).status, 200);
    assert.equal((await request("/api/v1/owner/apps/owner-http-two/settings", { cookie })).status, 404);
    const settings = await request("/api/v1/owner/apps/owner-http-one/settings", { method: "PUT", cookie, csrf, body: { app_name: "Owner App Updated", description: "Updated safely", application_url: "https://example.com", backend_api_url: "http://internal-api:8080" } });
    assert.equal(settings.status, 200); assert.equal(settings.json.data.application.app_name, "Owner App Updated");
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/analytics", { cookie })).status, 200);
    assert.equal((await request("/api/v1/owner/apps/owner-http-two/analytics", { cookie })).status, 404);
    const denied = await request("/api/v1/owner/apps/owner-http-two", { cookie });
    assert.equal(denied.status, 404);
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/notifications", { cookie })).status, 200);
    const template = await request("/api/v1/owner/apps/owner-http-one/notifications/templates", { method: "PUT", cookie, csrf, body: { key: "owner-welcome", locale: "en", title: "Hi {{name}}", body: "Welcome" } });
    assert.equal(template.status, 200);
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/notifications/templates", { cookie })).json.data.items.length, 1);
    const notice = await request("/api/v1/owner/apps/owner-http-one/notifications", { method: "POST", cookie, csrf, body: { title: "Maintenance", body: "Scheduled", idempotency_key: "owner-notice-001", audience: "all" } });
    assert.equal(notice.status, 201);
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/notifications", { cookie })).json.data.items[0].recipients_total, 1);
    assert.equal(notice.json.data.workflow_state, "draft");
    const noticeId = notice.json.data.notification_id;
    const noticeReader = appService.issueCredential("owner-http-one", ["notifications:read"]).secret;
    assert.equal((await request("/api/v1/notifications", { token: noticeReader })).json.data.items.length, 0);
    assert.equal((await request(`/api/v1/owner/apps/owner-http-one/notifications/${noticeId}`, { method: "PUT", cookie, csrf, body: { title: "Maintenance update", body: "Scheduled safely", audience: "all" } })).status, 200);
    assert.equal((await request(`/api/v1/owner/apps/owner-http-one/notifications/${noticeId}/preview`, { method: "POST", cookie, csrf })).status, 200);
    assert.equal((await request(`/api/v1/owner/apps/owner-http-one/notifications/${noticeId}/approve`, { method: "POST", cookie, csrf })).status, 200);
    assert.equal((await request(`/api/v1/owner/apps/owner-http-one/notifications/${noticeId}/publish`, { method: "POST", cookie, csrf })).json.data.workflow_state, "published");
    assert.equal((await request("/api/v1/notifications", { token: noticeReader })).json.data.items[0].title, "Maintenance update");
    assert.equal((await request(`/api/v1/owner/apps/owner-http-one/notifications/${noticeId}/history`, { cookie })).json.data.items.map((event) => event.action).join(","), "created,updated,previewed,approved,published");
    assert.equal((await request(`/api/v1/owner/apps/owner-http-one/notifications/${noticeId}/cancel`, { method: "POST", cookie, csrf })).status, 200);
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/webhooks", { cookie })).status, 200);
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/payments", { cookie })).status, 200);
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/pi-config", { cookie })).json.data.configuration, null);
    assert.equal((await request("/api/v1/owner/apps/owner-http-two/pi-config", { cookie })).status, 404);
    const noPiCsrf = await request("/api/v1/owner/apps/owner-http-one/pi-config", { method: "PUT", cookie, body: { pi_app_id: "pi-owner-app", network: "testnet", server_api_key: "pi-owner-server-secret" } });
    assert.equal(noPiCsrf.status, 403);
    const savedPiConfig = await request("/api/v1/owner/apps/owner-http-one/pi-config", { method: "PUT", cookie, csrf, body: { pi_app_id: "pi-owner-app", network: "testnet", server_api_key: "pi-owner-server-secret" } });
    assert.equal(savedPiConfig.status, 200);
    assert.equal(JSON.stringify(savedPiConfig.json).includes("pi-owner-server-secret"), false);
    assert.equal(piPaymentService.configuration("owner-http-one").network, "testnet");
    assert.equal((await request("/api/v1/owner/apps/owner-http-one/members", { cookie })).json.data.items[0].role, "owner");
    const noCsrf = await request("/api/v1/owner/apps/owner-http-one/credentials", { method: "POST", cookie, body: { scopes: ["feedback:read"] } });
    assert.equal(noCsrf.status, 403);
    const issued = await request("/api/v1/owner/apps/owner-http-one/credentials", { method: "POST", cookie, csrf, body: { scopes: ["feedback:read"] } });
    assert.equal(issued.status, 201);
    assert.match(issued.json.data.secret, /^shfh_live_/);
    const feedbackKey = appService.issueCredential("owner-http-one", ["feedback:write"]).secret;
    const feedback = await request("/api/v1/feedback", { method: "POST", token: feedbackKey, body: { category: "bug", title: "Owner attachment", message: "Attach image" } });
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const upload = await request(`/api/v1/owner/apps/owner-http-one/feedback/${feedback.json.data.id}/attachments?filename=owner.png`, { method: "POST", cookie, csrf, contentType: "image/png", body: png });
    assert.equal(upload.status, 201);
    const attachmentRead = await request(`/api/v1/owner/apps/owner-http-one/feedback/${feedback.json.data.id}/attachments/${upload.json.data.attachment_id}`, { cookie });
    assert.equal(attachmentRead.status, 200); assert.equal(Buffer.from(attachmentRead.json).equals(png), true);
    assert.equal(ownerService.listApps({ userId: claim.json.data.user_id })[0].role, "owner");
  });
});

test("HTTP Pi payment handshake settles only its linked provider-neutral fee order after authoritative completion", async () => {
  await withApi(async ({ appService, feeLedger, piPaymentService, setPiDto, request }) => {
    const appKey = registerAndApprove(appService, "pi-http-app", ["payments:create", "payments:read", "fees:create", "fees:read"]);
    appService.requestRegistration({ app_id: "pi-http-other", app_name: "Other" }); appService.approveApp("pi-http-other");
    piPaymentService.configure({ applicationId: "pi-http-app", piAppId: "pi-test-app", serverApiKey: "pi-platform-server-secret", network: "testnet" });
    const fee = await request("/api/v1/fees/orders", { method: "POST", token: appKey, body: { idempotency_key: "pi-fee-http-0001", amount_subunits: 12500000, amount_scale: 7, currency: "PI", provider: "pi", order_reference: "42" } });
    assert.equal(fee.status, 201);
    const created = await request("/api/v1/payments/create", { method: "POST", token: appKey, body: { amount: 1.25, memo: "Order 42", order_reference: "42", idempotency_key: "http-order-0001", fee_order_id: fee.json.data.order.order_id, metadata: { item: "pro" } } });
    assert.equal(created.status, 201); assert.equal(created.json.data.pi.configured, true);
    const sessionId = created.json.data.session_id;
    assert.equal(created.json.data.fee_order_id, fee.json.data.order.order_id);
    setPiDto({ identifier: "pi_http_payment", user_uid: "pi-http-user", amount: 1.25, memo: "Order 42", metadata: { item: "pro", hub_session_id: sessionId, fee_order_id: fee.json.data.order.order_id }, direction: "user_to_app", network: "Pi Testnet", status: { developer_approved: false, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false }, transaction: null });
    const noScope = appService.issueCredential("pi-http-other", ["payments:create"]).secret;
    assert.equal((await request(`/api/v1/payments/${sessionId}/approve`, { method: "POST", token: noScope, body: { payment_id: "pi_http_payment", user_access_token: "user-token" } })).status, 404);
    assert.equal((await request(`/api/v1/payments/${sessionId}`, { token: appKey })).json.data.service_delivery_allowed, false);
    const approval = await request(`/api/v1/payments/${sessionId}/approve`, { method: "POST", token: appKey, body: { payment_id: "pi_http_payment", user_access_token: "pi-user-access-token" } });
    assert.equal(approval.status, 200); assert.equal(approval.json.data.verification_state, "unverified");
    const txid = "b".repeat(64);
    setPiDto({ ...({}), identifier: "pi_http_payment", user_uid: "pi-http-user", amount: 1.25, memo: "Order 42", metadata: { item: "pro", hub_session_id: sessionId, fee_order_id: fee.json.data.order.order_id }, direction: "user_to_app", network: "Pi Testnet", status: { developer_approved: true, transaction_verified: true, developer_completed: false, cancelled: false, user_cancelled: false }, transaction: { txid, verified: true } });
    const completed = await request(`/api/v1/payments/${sessionId}/complete`, { method: "POST", token: appKey, body: { payment_id: "pi_http_payment", txid } });
    assert.equal(completed.status, 200); assert.equal(completed.json.data.verification_state, "verified"); assert.equal(completed.json.data.service_delivery_allowed, true);
    assert.equal(feeLedger.getOrder({ applicationId: "pi-http-app", orderId: fee.json.data.order.order_id }).status, "paid");
    assert.equal(feeLedger.canDeliver({ applicationId: "pi-http-app", orderId: fee.json.data.order.order_id }), true);
    const completionReplay = await request(`/api/v1/payments/${sessionId}/complete`, { method: "POST", token: appKey, body: { payment_id: "pi_http_payment", txid } });
    assert.equal(completionReplay.status, 200); assert.equal(completionReplay.json.data.service_delivery_allowed, true);
    const read = await request(`/api/v1/payments/${sessionId}`, { token: appKey });
    assert.equal(read.json.data.status, "completed"); assert.equal(read.json.data.txid, txid);
  });
});
