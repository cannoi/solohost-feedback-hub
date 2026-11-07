import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "../lib/settings.js";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "shfh-start-")); }
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
function startHub(dataDir, port, setupPort = 0, initialAdminPassword = "") {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT || "", PORT: String(port),
      ...(setupPort ? { SETUP_PORT: String(setupPort) } : {}),
      ...(initialAdminPassword ? { ADMIN_INITIAL_PASSWORD: initialAdminPassword } : {}),
      DATA_DIR: dataDir, HUB_ID: "TEST-HUB",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}
async function waitReady(handle) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (/listening on :(\d+)/.test(handle.output())) return Number(handle.output().match(/listening on :(\d+)/)[1]);
    if (handle.child.exitCode != null) throw new Error(`Hub exited ${handle.child.exitCode}: ${handle.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Hub did not become ready: ${handle.output()}`);
}
async function stopHub(handle) {
  if (handle.child.exitCode == null) handle.child.kill("SIGTERM");
  return await Promise.race([
    new Promise((resolve) => handle.child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Hub did not stop gracefully: ${handle.output()}`)), 5000)),
  ]);
}
async function call(base, route, { method = "GET", cookie, token, body, ip, forwardedProto } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (ip) headers["X-Forwarded-For"] = ip;
  if (forwardedProto) headers["X-Forwarded-Proto"] = forwardedProto;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, json: await response.json() };
}
function readDb(dataDir) {
  const database = new DatabaseSync(path.join(dataDir, "feedback-hub.sqlite"), { readOnly: true });
  try { return {
    feedback: database.prepare("SELECT id, application_id FROM feedback ORDER BY id").all(),
    payments: database.prepare("SELECT record_json, verification_state FROM payments_legacy").all(),
    apps: database.prepare("SELECT application_id, integration_status FROM applications ORDER BY application_id").all(),
    imports: database.prepare("SELECT count(*) AS n FROM json_import_runs").get().n,
  }; } finally { database.close(); }
}

test("real server imports JSON once, serves tenant APIs, rejects false payment confirmation, and persists after restart", async () => {
  const dataDir = tempDir();
  const pass = hashPassword("test-admin-password");
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ admin_password_salt: pass.salt, admin_password_hash: pass.hash, ingest_token: "" }));
  fs.writeFileSync(path.join(dataDir, "apps.json"), JSON.stringify([{ app_id: "legacy-app", app_name: "Legacy App", status: "active" }]));
  fs.writeFileSync(path.join(dataDir, "feedback.json"), JSON.stringify([{ id: "FB-imported", app_id: "legacy-app", message: "imported once", type: "bug", status: "NEW" }]));
  const firstPort = await freePort();
  let hub = startHub(dataDir, firstPort);
  let adminCookie = "";
  try {
    await waitReady(hub);
    const health = await call(`http://127.0.0.1:${firstPort}`, "/api/v1/integration/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.data.database, "ready");
    const portal = await fetch(`http://127.0.0.1:${firstPort}/feedback/track`);
    assert.equal(portal.status, 200);
    assert.match(await portal.text(), /Track your feedback/);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/admin/overview")).status, 401);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/login", { method: "POST", body: { password: "wrong-password" } })).status, 401);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/admin/overview", { cookie: "SHFH_SESSION=expired-session" })).status, 401);
    const login = await call(`http://127.0.0.1:${firstPort}`, "/api/login", { method: "POST", body: { password: "test-admin-password" }, forwardedProto: "https" });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    assert.match(login.headers.get("set-cookie"), /SameSite=Lax/);
    assert.match(login.headers.get("set-cookie"), /Secure/);
    adminCookie = login.headers.get("set-cookie").split(";")[0];
    const cookie = adminCookie;
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/admin/overview", { cookie })).status, 200);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/setup", { method: "POST", body: { password: "another-admin-password" } })).status, 409);
    const registration = await call(`http://127.0.0.1:${firstPort}`, "/api/v1/apps/register", { method: "POST", body: { app_id: "solo-e2e", app_name: "Solo E2E" } });
    assert.equal(registration.status, 202);
    const approve = await call(`http://127.0.0.1:${firstPort}`, "/api/v1/apps/solo-e2e/approve", { method: "POST", cookie });
    assert.equal(approve.status, 200);
    const key = await call(`http://127.0.0.1:${firstPort}`, "/api/v1/apps/solo-e2e/credentials", { method: "POST", cookie, body: { scopes: ["feedback:write", "feedback:read"] } });
    assert.equal(key.status, 201);
    const feedback = await call(`http://127.0.0.1:${firstPort}`, "/api/v1/feedback", { method: "POST", token: key.json.data.secret, body: { category: "bug", title: "Works over HTTP", message: "Persist this safely" } });
    assert.equal(feedback.status, 201);
    const legacy = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback", { method: "POST", body: { app_id: "legacy-discovered", app_name: "Legacy Discovered", event: "feedback", message: "Legacy client still works" } });
    assert.equal(legacy.status, 201);
    const appOverview = await call(`http://127.0.0.1:${firstPort}`, "/api/admin/overview", { cookie });
    assert.equal(appOverview.status, 200);
    assert.equal(appOverview.json.apps.some((app) => app.app_id === "legacy-discovered"), false);
    assert.equal(appOverview.json.pending_apps.some((app) => app.app_id === "legacy-discovered"), true);
    const repeatedUnapprovedFeedback = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback", { method: "POST", body: { app_id: "legacy-discovered", app_name: "Legacy Discovered", event: "feedback", message: "Second report too soon" } });
    assert.equal(repeatedUnapprovedFeedback.status, 429);
    for (let i = 1; i <= 5; i += 1) {
      const allowed = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback", {
        method: "POST", ip: `198.51.100.${i}`, body: { app_id: "daily-cap", app_name: "Daily Cap", event: "feedback", message: `Pending report ${i}` }
      });
      assert.equal(allowed.status, 201);
    }
    const dailyCap = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback", {
      method: "POST", ip: "198.51.100.6", body: { app_id: "daily-cap", app_name: "Daily Cap", event: "feedback", message: "Over daily app limit" }
    });
    assert.equal(dailyCap.status, 429);
    const deniedApproval = await call(`http://127.0.0.1:${firstPort}`, "/api/apps/legacy-discovered/approve", { method: "POST" });
    assert.equal(deniedApproval.status, 401);
    const approvedApp = await call(`http://127.0.0.1:${firstPort}`, "/api/apps/legacy-discovered/approve", { method: "POST", cookie });
    assert.equal(approvedApp.status, 200);
    const approvedOverview = await call(`http://127.0.0.1:${firstPort}`, "/api/admin/overview", { cookie });
    assert.equal(approvedOverview.json.apps.some((app) => app.app_id === "legacy-discovered"), true);
    const removedApp = await call(`http://127.0.0.1:${firstPort}`, "/api/apps/legacy-discovered", { method: "DELETE", cookie });
    assert.equal(removedApp.status, 200);
    assert.equal(removedApp.json.retained_feedback, true);
    const removedOverview = await call(`http://127.0.0.1:${firstPort}`, "/api/admin/overview", { cookie });
    assert.equal(removedOverview.json.apps.some((app) => app.app_id === "legacy-discovered"), false);
    const publishedUpdate = await call(`http://127.0.0.1:${firstPort}`, "/api/updates", {
      method: "POST", cookie, body: {
        app_id: "legacy-app", app_name: "Spoofed Name", version: "2.6.0",
        notice: "Short compatibility notice", release_notes: "Full release notes are retained.",
        release_url: "https://downloads.example.test/legacy-app/2.6.0", published: true,
      },
    });
    assert.equal(publishedUpdate.status, 201);
    assert.equal(publishedUpdate.json.item.app_name, "Legacy App");
    assert.equal(publishedUpdate.json.item.notice, "Short compatibility notice");
    assert.equal(publishedUpdate.json.item.release_notes, "Full release notes are retained.");
    assert.equal(publishedUpdate.json.item.release_url, "https://downloads.example.test/legacy-app/2.6.0");
    assert.equal(publishedUpdate.json.item.published, true);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates/all?app_id=solo-e2e", { cookie })).json.items.length, 0);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates?app_id=legacy-app")).json.items[0].notice, "Short compatibility notice");
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/client-policy?app_id=legacy-app")).json.latest_update.notice, "Short compatibility notice");
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "legacy-app", version: "2.7.0", release_notes: "Notes without a short notice" } })).status, 201);
    const unpublishedUpdate = await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "legacy-app", version: "2.8.0", notice: "Draft notice", published: false } });
    assert.equal(unpublishedUpdate.status, 201);
    assert.equal(unpublishedUpdate.json.item.published, false);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates?app_id=legacy-app")).json.items.some((item) => item.id === unpublishedUpdate.json.item.id), false);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "missing-version", notice: "Missing version" } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { version: "1.0", notice: "Missing app id" } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "../bad", version: "1.0", notice: "Invalid app id" } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "legacy-app", version: "1.0", notice: "Invalid publication status", published: "false" } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "unknown-app", version: "1.0", notice: "Unknown app" } })).status, 404);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "legacy-discovered", version: "1.0", notice: "Pending app" } })).status, 409);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "legacy-app", version: "1.0", notice: "Bad URL", release_url: "javascript:alert(1)" } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/apps", { method: "POST", cookie, body: { app_id: "paused-app", app_name: "Paused App", status: "paused" } })).status, 201);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "paused-app", version: "1.0", notice: "Paused app" } })).status, 409);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/apps", { method: "POST", cookie, body: { app_id: "disabled-app", app_name: "Disabled App" } })).status, 201);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/apps/disabled-app", { method: "DELETE", cookie })).status, 200);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/updates", { method: "POST", cookie, body: { app_id: "disabled-app", version: "1.0", notice: "Disabled app" } })).status, 409);
    const noticeCreated = await call(`http://127.0.0.1:${firstPort}`, "/api/admin/notices", {
      method: "POST", cookie, body: { app_id: "legacy-app", type: "announcement", title: "Targeted notice", body: "For one user", audience: "selected", recipient_ids: ["user-one"], idempotency_key: "admin-test-notice-0001" },
    });
    assert.equal(noticeCreated.status, 201);
    assert.equal(noticeCreated.json.item.application_id, "legacy-app");
    const noticeHistory = await call(`http://127.0.0.1:${firstPort}`, "/api/admin/notices?app_id=legacy-app", { cookie });
    assert.equal(noticeHistory.json.items.some((item) => item.notification_id === noticeCreated.json.item.notification_id), true);
    assert.deepEqual(noticeHistory.json.items.find((item) => item.notification_id === noticeCreated.json.item.notification_id).recipient_ids, ["user-one"]);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/admin/notices", {
      method: "POST", cookie, body: { app_id: "solo-e2e", type: "announcement", title: "Other app", body: "Isolated", audience: "all", idempotency_key: "admin-test-notice-0002" },
    })).status, 201);
    assert.equal(noticeHistory.json.items.every((item) => item.application_id === "legacy-app"), true);
    const otherNoticeHistory = await call(`http://127.0.0.1:${firstPort}`, "/api/admin/notices?app_id=solo-e2e", { cookie });
    assert.equal(otherNoticeHistory.json.items.every((item) => item.application_id === "solo-e2e"), true);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/admin/notices", { method: "POST", cookie, body: { app_id: "legacy-discovered", title: "Pending", body: "No" } })).status, 409);
    const scopedFeedback = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback?app_id=legacy-app", { cookie });
    assert.equal(scopedFeedback.json.items.some((item) => item.id === "FB-imported"), true);
    assert.equal(scopedFeedback.json.items.some((item) => item.app_id === "solo-e2e"), false);
    assert.equal((await call(`http://127.0.0.1:${firstPort}`, "/api/feedback/FB-imported?app_id=solo-e2e", { method: "PATCH", cookie, body: { status: "DONE" } })).status, 404);
    const falsePayment = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback", { method: "POST", body: { app_id: "legacy-payment", event: "payment", amount: "1", txn_id: "fabricated" } });
    assert.equal(falsePayment.json.status, "legacy_unverified");
    assert.equal(falsePayment.json.notice, null);

    // Universal AI + Feedback panel contract: public config is secret-free; panel feedback
    // is locally stored without reusing the protected app-ingest endpoint.
    const panelConfig = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback/config");
    assert.equal(panelConfig.status, 200);
    assert.equal(panelConfig.json.hubId, "TEST-HUB");
    assert.equal(panelConfig.json.appId, "solohost-feedback-hub");
    assert.equal(JSON.stringify(panelConfig.json).includes("cannoi_"), false);
    const adminHtml = await fetch(`http://127.0.0.1:${firstPort}/admin`).then((response) => response.text());
    assert.doesNotMatch(adminHtml, /id="s_(?:hub|url|ingest)"/);
    assert.doesNotMatch(adminHtml, /ADMIN_TOKEN|setupToken/);
    assert.match(adminHtml, /<select id="ua"/);
    assert.match(adminHtml, /<select id="nb_app"/);
    assert.doesNotMatch(adminHtml, /id="un"/);
    assert.match(adminHtml, /id="appManagement"/);
    assert.match(adminHtml, /function returnToAppList/);
    assert.match(adminHtml, /window\.addEventListener\("popstate"/);
    assert.match(adminHtml, /loadVersion!==appLoadVersion\|\|appId!==currentApp/);
    assert.match(adminHtml, /id="pw"[^>]*maxlength="200"/);
    assert.match(adminHtml, /id="pw2"[^>]*maxlength="200"/);
    assert.match(adminHtml, /plan\.textContent=""/);
    assert.match(adminHtml, /insights\.textContent=""/);
    assert.match(adminHtml, /async function loadNoticeHistory\(loadVersion=appLoadVersion\)/);
    const dockerIgnore = fs.readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    assert.match(dockerIgnore, /config\/solohost\.env/);
    assert.match(dockerIgnore, /data\//);
    const appSelectorScript = await fetch(`http://127.0.0.1:${firstPort}/admin-app-selector.js`).then((response) => response.text());
    assert.match(appSelectorScript, /SHFAAppSelector/);
    const panelCssResponse = await fetch(`http://127.0.0.1:${firstPort}/ai-panel.css`, { headers: { Cookie: cookie } });
    assert.equal(panelCssResponse.status, 200);
    const panelCss = await panelCssResponse.text();
    assert.match(panelCss, /#aiPanel/);
    assert.match(panelCss, /right:\s*16px/);
    const panelJs = await fetch(`http://127.0.0.1:${firstPort}/ai-panel.js`, { headers: { Cookie: cookie } });
    assert.equal(panelJs.status, 200);
    const panelIcon = await fetch(`http://127.0.0.1:${firstPort}/ai-icon.png`, { headers: { Cookie: cookie } });
    assert.equal(panelIcon.status, 200);
    const panelFeedback = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback/panel-submit", {
      method: "POST", body: { type: "bug", rating: 5, message: "Panel integration test", anonymous_id: "panel-anon", locale: "en" }
    });
    assert.equal(panelFeedback.status, 201);
    const repeatedPanelFeedback = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback/panel-submit", {
      method: "POST", body: { type: "bug", rating: 5, message: "Panel limit test", anonymous_id: "panel-anon", locale: "en" }
    });
    assert.equal(repeatedPanelFeedback.status, 429);
    const panelSync = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback/sync?anonymous_id=panel-anon");
    assert.equal(panelSync.status, 200);
    assert.equal(panelSync.json.notices.length, 1);
    assert.equal(panelSync.json.donate !== undefined, true);
    const markRead = await call(`http://127.0.0.1:${firstPort}`, `/api/feedback/read/${encodeURIComponent(panelSync.json.notices[0].id)}`, {
      method: "POST", body: { anonymous_id: "panel-anon" }
    });
    assert.equal(markRead.status, 200);
    const panelSyncAfterRead = await call(`http://127.0.0.1:${firstPort}`, "/api/feedback/sync?anonymous_id=panel-anon");
    assert.equal(panelSyncAfterRead.json.notices.length, 0);

    const publicSettings = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/settings");
    assert.equal(publicSettings.status, 401);
    const chat = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/chat", {
      method: "POST", body: { message: "How do I submit feedback?" }
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.source, "local");
    assert.match(chat.json.reply, /public form|feedback/i);
    const catalog = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/catalog");
    const providerIds = (catalog.json.providers || []).map(x => x.id);
    for (const id of ["openai","gemini","deepseek","anthropic","openrouter","groq","mistral","xai","custom","local"]) {
      assert.ok(providerIds.includes(id), `missing AI provider ${id}`);
    }
    const viChat = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/chat", {
      method: "POST", body: { message: "Làm sao gửi phản hồi?" }
    });
    assert.equal(viChat.status, 200);
    assert.match(viChat.json.reply, /Bạn có thể|phản hồi/i);
    const viApprovalChat = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/chat", {
      method: "POST", body: { message: "Làm sao phê duyệt app mới?" }
    });
    assert.match(viApprovalChat.json.reply, /chờ duyệt|phản hồi/i);
    const enApprovalChat = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/chat", {
      method: "POST", body: { message: "How do I approve a pending app?" }
    });
    assert.match(enApprovalChat.json.reply, /pending|administrator/i);

    const settings = await call(`http://127.0.0.1:${firstPort}`, "/api/settings", { cookie });
    assert.equal(settings.status, 200);
    assert.equal(Object.hasOwn(settings.json.settings, "ingest_token"), false);

    const fakeKey = "test-only-not-a-real-provider-key";
    const saveAi = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/settings", {
      method: "POST", cookie, body: { provider: "openai", apiKey: fakeKey, model: "auto", mode: "cloud_enabled" }
    });
    assert.equal(saveAi.status, 200);
    assert.ok(saveAi.json.settings.maskedKey);
    assert.equal(JSON.stringify(saveAi.json).includes(fakeKey), false);
    const getAi = await call(`http://127.0.0.1:${firstPort}`, "/api/ai/settings", { cookie });
    assert.equal(getAi.status, 200);
    assert.equal(JSON.stringify(getAi.json).includes(fakeKey), false);

    const snapshot = readDb(dataDir);
    assert.equal(snapshot.feedback.length, 9);
    assert.equal(snapshot.imports, 1);
    assert.equal(snapshot.apps.find((row) => row.application_id === "legacy-discovered").integration_status, "disabled");
    assert.equal(snapshot.feedback.some((row) => row.application_id === "legacy-discovered"), true);
    assert.equal(snapshot.payments[0].verification_state, "legacy_unverified");
  } finally {
    const stopped = await stopHub(hub);
    if (process.platform !== "win32") {
      assert.equal(stopped.code, 0);
      assert.match(hub.output(), /graceful shutdown complete/);
    } else assert.equal(stopped.signal, "SIGTERM");
  }

  const secondPort = await freePort();
  hub = startHub(dataDir, secondPort);
  try {
    await waitReady(hub);
    assert.equal((await call(`http://127.0.0.1:${secondPort}`, "/api/v1/integration/health")).status, 200);
    assert.equal((await call(`http://127.0.0.1:${secondPort}`, "/api/admin/overview", { cookie: adminCookie })).status, 401);
    const snapshot = readDb(dataDir);
    assert.equal(snapshot.feedback.length, 9);
    assert.equal(snapshot.imports, 1);
  } finally {
    const stopped = await stopHub(hub);
    if (process.platform !== "win32") {
      assert.equal(stopped.code, 0);
      assert.match(hub.output(), /graceful shutdown complete/);
    } else assert.equal(stopped.signal, "SIGTERM");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("database initialization errors prevent HTTP listener startup", async () => {
  const root = tempDir();
  const invalidData = path.join(root, "not-a-directory");
  fs.writeFileSync(invalidData, "block directory creation");
  const port = await freePort();
  const hub = startHub(invalidData, port);
  try {
    const exited = await Promise.race([
      new Promise((resolve) => hub.child.once("exit", (code) => resolve(code))),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Invalid database path did not fail: ${hub.output()}`)), 5000)),
    ]);
    assert.notEqual(exited, 0);
    assert.doesNotMatch(hub.output(), /listening on :/);
  } finally { if (hub.child.exitCode == null) await stopHub(hub); fs.rmSync(root, { recursive: true, force: true }); }
});

test("first admin setup is direct-loopback-only, rate-limited, and password survives restart", async () => {
  const dataDir = tempDir();
  let port = await freePort();
  let setupPort = await freePort();
  let hub = startHub(dataDir, port, setupPort);
  try {
    await waitReady(hub);
    const localSession = await call(`http://127.0.0.1:${port}`, "/api/session");
    assert.equal(localSession.json.needs_setup, true);
    assert.equal(localSession.json.setup_available, true);
    const isolatedSetupSession = await call(`http://127.0.0.1:${setupPort}`, "/api/session");
    assert.equal(isolatedSetupSession.json.setup_available, true, "the dedicated setup listener should support Docker loopback publication");
    const forwardedSession = await call(`http://127.0.0.1:${port}`, "/api/session", { ip: "203.0.113.77" });
    assert.equal(forwardedSession.json.setup_available, true, "setup eligibility must ignore spoofed forwarded addresses");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assert.equal((await call(`http://127.0.0.1:${port}`, "/api/setup", {
        method: "POST", ip: `198.51.100.${attempt + 1}`, body: { password: "short" },
      })).status, 400);
    }
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/setup", {
      method: "POST", ip: "192.0.2.123", body: { password: "admin-password" },
    })).status, 429, "spoofed forwarded addresses must not evade the per-socket setup limit");
  } finally { await stopHub(hub); }

  setupPort = await freePort();
  hub = startHub(dataDir, port, setupPort);
  try {
    await waitReady(hub);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/setup", { method: "POST", body: { password: "short" } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/setup", { method: "POST", body: { password: "p".repeat(201) } })).status, 400);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/session")).json.needs_setup, true);
    const password = "  admin-password  ";
    const setup = await call(`http://127.0.0.1:${port}`, "/api/setup", { method: "POST", ip: "203.0.113.77", body: { password } });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/admin/overview", { cookie })).status, 200);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/setup", { method: "POST", body: { password: "another-password" } })).status, 409);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/logout", { method: "POST", cookie })).status, 200);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/admin/overview", { cookie })).status, 401);
  } finally { await stopHub(hub); }

  port = await freePort();
  hub = startHub(dataDir, port);
  try {
    await waitReady(hub);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/login", { method: "POST", body: { password: "admin-password" } })).status, 401);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/login", { method: "POST", body: { password: "p".repeat(201) } })).status, 400);
    const login = await call(`http://127.0.0.1:${port}`, "/api/login", { method: "POST", body: { password: "  admin-password  " } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/admin/overview", { cookie })).status, 200);
  } finally { await stopHub(hub); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("Pi Apps compose package resolves from the expected Windows path with spaces", () => {
  const packageRoot = process.cwd();
  const compose = fs.readFileSync(path.join(packageRoot, "compose.yaml"), "utf8");
  for (const filename of ["docker-compose.yml", "compose.yml"]) {
    const composePath = path.join(packageRoot, filename);
    assert.equal(fs.existsSync(composePath), true, `${filename} must be present in the package root`);
    assert.equal(fs.readFileSync(composePath, "utf8"), compose, `${filename} must match compose.yaml`);
  }
  assert.doesNotMatch(compose, /^\s+env_file:/m, "a fresh install must not require a generated config/solohost.env file");
  assert.match(compose, /127\.0\.0\.1:\$\{SETUP_HOST_PORT:-8091\}:8091/);
  assert.match(compose, /SETUP_PORT:\s*"8091"/);
  assert.match(compose, /ADMIN_INITIAL_PASSWORD:\s*"\$\{ADMIN_INITIAL_PASSWORD:-\}"/);
  const options = fs.readFileSync(path.join(packageRoot, "config_options.yml"), "utf8");
  assert.match(options, /id:\s*ADMIN_INITIAL_PASSWORD[\s\S]*?type:\s*secret[\s\S]*?required:\s*true/);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "Pi Network "));
  const composePath = path.join(tempRoot, "Pi Network", "pi-apps", "cannoi-solohost-feedback-hub", "docker-compose.yml");
  try {
    fs.mkdirSync(path.dirname(composePath), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, "docker-compose.yml"), composePath);
    assert.equal(fs.existsSync(composePath), true);
    assert.equal(fs.readFileSync(composePath, "utf8"), compose);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("SoloHost install-time admin password is hashed once and supports login without remote setup", async () => {
  const dataDir = tempDir();
  const port = await freePort();
  const password = "solo-host-install-password";
  let hub = startHub(dataDir, port, 0, password);
  try {
    await waitReady(hub);
    const session = await call(`http://127.0.0.1:${port}`, "/api/session");
    assert.equal(session.json.needs_setup, false);
    assert.equal(session.json.setup_available, false);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/setup", {
      method: "POST", body: { password: "attempt-to-reset-password" },
    })).status, 409);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/login", {
      method: "POST", body: { password: "incorrect-password" },
    })).status, 401);
    const login = await call(`http://127.0.0.1:${port}`, "/api/login", { method: "POST", body: { password } });
    assert.equal(login.status, 200);
    const savedSettings = fs.readFileSync(path.join(dataDir, "settings.json"), "utf8");
    assert.equal(savedSettings.includes(password), false, "the install secret must not be persisted in plaintext");
    assert.match(savedSettings, /admin_password_hash/);
  } finally { await stopHub(hub); }

  hub = startHub(dataDir, port);
  try {
    await waitReady(hub);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/session")).json.needs_setup, false);
    assert.equal((await call(`http://127.0.0.1:${port}`, "/api/login", { method: "POST", body: { password } })).status, 200);
  } finally { await stopHub(hub); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("SoloHost install rejects an invalid configured admin password before listening", async () => {
  const dataDir = tempDir();
  const port = await freePort();
  const hub = startHub(dataDir, port, 0, "short");
  try {
    const exitCode = await Promise.race([
      new Promise((resolve) => hub.child.once("exit", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Invalid initial password did not stop startup: ${hub.output()}`)), 5000)),
    ]);
    assert.notEqual(exitCode, 0);
    assert.doesNotMatch(hub.output(), /listening on :/);
    assert.doesNotMatch(hub.output(), /short/);
  } finally { if (hub.child.exitCode == null) await stopHub(hub); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
