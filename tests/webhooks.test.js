import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createSecretBox } from "../lib/secret-box.js";
import { createWebhookService } from "../lib/webhooks.js";

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-webhooks-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  const apps = createAppService(opened.db);
  for (const id of ["hook-one", "hook-two"]) { apps.requestRegistration({ app_id: id, app_name: id }); apps.approveApp(id); }
  let now = new Date("2026-10-31T00:00:00Z");
  const box = createSecretBox(crypto.randomBytes(32).toString("base64url"));
  const service = createWebhookService({ db: opened.db, secretBox: box, clock: () => new Date(now), resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  return { dataDir, opened, service, setNow(value) { now = new Date(value); } };
}

test("webhook subscriptions encrypt secrets and only queue matching tenant events", async () => {
  const ctx = setup();
  try {
    const hook = await ctx.service.register({ applicationId: "hook-one", endpoint: "https://hooks.example.org/feedback", events: ["feedback.created"] });
    assert.match(hook.secret, /^shfh_whsec_/);
    const stored = ctx.opened.db.prepare("SELECT secret_hash,secret_ciphertext FROM secure_webhook_subscriptions WHERE webhook_id=?").get(hook.webhook_id);
    assert.equal(stored.secret_hash, crypto.createHash("sha256").update(hook.secret).digest("hex"));
    assert.equal(stored.secret_ciphertext.includes(hook.secret), false);
    assert.equal((await ctx.service.register({ applicationId: "hook-two", endpoint: "https://hooks.example.org/other", events: ["feedback.created"] })).application_id, "hook-two");
    const eventId = ctx.service.enqueueEvent({ applicationId: "hook-one", eventType: "feedback.created", payload: { feedback_id: "FB-1" } });
    assert.match(eventId, /^evt_/);
    assert.equal(ctx.opened.db.prepare("SELECT count(*) AS n FROM secure_webhook_deliveries WHERE event_id=?").get(eventId).n, 1);
    const delivered = await ctx.service.dispatchDue({ deliver: async ({ event }) => ({ statusCode: 204, eventId: event.id }) });
    assert.equal(delivered.delivered, 1);
    assert.equal(ctx.opened.db.prepare("SELECT status FROM secure_webhook_deliveries WHERE event_id=?").get(eventId).status, "delivered");
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("webhook enrollment and retries reject private targets and persist retry delay", async () => {
  const ctx = setup();
  try {
    const unsafe = createWebhookService({ db: ctx.opened.db, secretBox: createSecretBox(crypto.randomBytes(32).toString("base64url")), resolve: async () => [{ address: "169.254.169.254", family: 4 }] });
    await assert.rejects(unsafe.register({ applicationId: "hook-one", endpoint: "https://hooks.example.org/metadata", events: ["feedback.created"] }), { code: "UNSAFE_WEBHOOK_DESTINATION" });
    await ctx.service.register({ applicationId: "hook-one", endpoint: "https://hooks.example.org/retry", events: ["feedback.created"] });
    const eventId = ctx.service.enqueueEvent({ applicationId: "hook-one", eventType: "feedback.created", payload: { id: "FB-2" } });
    const failed = await ctx.service.dispatchDue({ deliver: async () => { throw Object.assign(new Error("remote response body secret"), { code: "WEBHOOK_HTTP_STATUS", statusCode: 503 }); } });
    assert.equal(failed.retrying, 1);
    const row = ctx.opened.db.prepare("SELECT status,last_error_code,last_status_code,next_attempt_at FROM secure_webhook_deliveries WHERE event_id=?").get(eventId);
    assert.equal(row.status, "pending"); assert.equal(row.last_error_code, "WEBHOOK_HTTP_STATUS"); assert.equal(row.last_status_code, 503);
    assert.ok(Date.parse(row.next_attempt_at) > Date.parse("2026-10-31T00:00:00Z"));
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});
