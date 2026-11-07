import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createNotificationService } from "../lib/notifications.js";

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-notifications-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  const apps = createAppService(opened.db);
  apps.requestRegistration({ app_id: "notify-worker", app_name: "Notify Worker" }); apps.approveApp("notify-worker");
  let now = new Date("2026-10-31T00:00:00Z");
  const service = createNotificationService({ db: opened.db, clock: () => new Date(now) });
  return { dataDir, opened, service, setNow(value) { now = new Date(value); } };
}

test("scheduled notifications deliver to selected recipients once and retain read state", async () => {
  const ctx = setup();
  try {
    const item = ctx.service.create({ applicationId: "notify-worker", idempotencyKey: "release-notify-001", title: "Release", body: "Version 4", type: "release", audience: "selected", recipientIds: ["cust-a", "cust-b"], scheduledAt: "2026-10-31T00:00:10Z" });
    assert.equal(item.workflow_state, "draft");
    assert.equal((await ctx.service.dispatchDue()).delivered, 0);
    assert.throws(() => ctx.service.publish({ applicationId: "notify-worker", notificationId: item.notification_id }), { code: "NOTIFICATION_NOT_PUBLISHABLE" });
    const updated = ctx.service.updateDraft({ applicationId: "notify-worker", notificationId: item.notification_id, input: { title: "Release 4", body: "Version 4 notes", type: "release", audience: "selected", recipientIds: ["cust-a", "cust-b"], scheduledAt: "2026-10-31T00:00:10Z" } });
    assert.equal(updated.workflow_state, "draft");
    assert.equal(ctx.service.previewDraft({ applicationId: "notify-worker", notificationId: item.notification_id }).delivered, false);
    ctx.service.approve({ applicationId: "notify-worker", notificationId: item.notification_id, actorType: "app_owner", actorId: "owner-a" });
    assert.throws(() => ctx.service.updateDraft({ applicationId: "notify-worker", notificationId: item.notification_id, input: { title: "Changed", body: "too late", audience: "all" } }), { code: "NOTIFICATION_NOT_EDITABLE" });
    ctx.service.publish({ applicationId: "notify-worker", notificationId: item.notification_id, actorType: "app_owner", actorId: "owner-a" });
    assert.equal((await ctx.service.dispatchDue()).delivered, 0);
    ctx.setNow("2026-10-31T00:00:11Z");
    assert.equal((await ctx.service.dispatchDue()).delivered, 2);
    assert.equal((await ctx.service.dispatchDue()).delivered, 0);
    const list = ctx.service.list({ applicationId: "notify-worker", recipientId: "cust-a" });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].is_read, false);
    ctx.service.markRead({ applicationId: "notify-worker", notificationId: item.notification_id, recipientId: "cust-a" });
    assert.equal(ctx.service.list({ applicationId: "notify-worker", recipientId: "cust-a" }).items[0].is_read, true);
    assert.equal(ctx.service.list({ applicationId: "notify-worker", recipientId: "cust-b" }).items[0].is_read, false);
    assert.deepEqual(ctx.service.history({ applicationId: "notify-worker", notificationId: item.notification_id }).map((event) => event.action), ["created", "updated", "previewed", "approved", "published"]);
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("external delivery failures retry with durable exponential backoff and idempotent notification create", async () => {
  const ctx = setup();
  try {
    const payload = { applicationId: "notify-worker", idempotencyKey: "payment-alert-01", title: "Payment", body: "Receipt", type: "payment", audience: "selected", recipientIds: ["cust-a"], channel: "email" };
    const first = ctx.service.create(payload);
    const replay = ctx.service.create(payload);
    assert.equal(replay.notification_id, first.notification_id);
    assert.throws(() => ctx.service.create({ ...payload, body: "Changed" }), { code: "IDEMPOTENCY_CONFLICT" });
    ctx.service.approve({ applicationId: "notify-worker", notificationId: first.notification_id });
    ctx.service.publish({ applicationId: "notify-worker", notificationId: first.notification_id });
    const failed = await ctx.service.dispatchDue({ adapters: { email: async () => { throw Object.assign(new Error("smtp password leaked"), { code: "SMTP_FAILED" }); } } });
    assert.equal(failed.retrying, 1);
    assert.equal(ctx.opened.db.prepare("SELECT last_error FROM notification_recipients WHERE notification_id=?").get(first.notification_id).last_error, "SMTP_FAILED");
    ctx.setNow("2026-10-31T00:00:03Z");
    const delivered = await ctx.service.dispatchDue({ adapters: { email: async ({ idempotencyKey }) => ({ accepted: true, idempotencyKey }) } });
    assert.equal(delivered.delivered, 1);
    assert.equal(ctx.opened.db.prepare("SELECT delivery_status FROM notification_recipients WHERE notification_id=?").get(first.notification_id).delivery_status, "delivered");
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("notification templates are tenant scoped, localized, and require declared variables", async () => {
  const ctx = setup();
  try {
    ctx.service.saveTemplate({ applicationId: "notify-worker", key: "order-ready", locale: "en", title: "Order {{order}}", body: "Hello {{customer}}" });
    ctx.service.saveTemplate({ applicationId: "notify-worker", key: "order-ready", locale: "vi", title: "Đơn {{order}}", body: "Xin chào {{customer}}" });
    assert.throws(() => ctx.service.create({ applicationId: "other-tenant", idempotencyKey: "template-fake-01", templateKey: "order-ready", variables: { order: "1", customer: "A" }, audience: "all" }), { code: "NOTIFICATION_TEMPLATE_NOT_FOUND" });
    const notification = ctx.service.create({ applicationId: "notify-worker", idempotencyKey: "template-order-01", templateKey: "order-ready", variables: { order: "42", customer: "Mai" }, locale: "vi", audience: "all" });
    const stored = ctx.opened.db.prepare("SELECT title,body,locale FROM notifications WHERE notification_id=?").get(notification.notification_id);
    assert.equal(stored.title, "Đơn 42"); assert.equal(stored.body, "Xin chào Mai"); assert.equal(stored.locale, "vi");
    assert.throws(() => ctx.service.create({ applicationId: "notify-worker", idempotencyKey: "template-order-02", templateKey: "order-ready", variables: { order: "42" }, locale: "en", audience: "all" }), { code: "INVALID_NOTIFICATION_TEMPLATE" });
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});
