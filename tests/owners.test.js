import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createOwnerService } from "../lib/owners.js";

test("owner invites bind a user to one app and sessions enforce expiry and CSRF", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-owners-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  let now = new Date("2026-10-31T00:00:00Z");
  try {
    const apps = createAppService(opened.db);
    for (const id of ["owned-one", "owned-two"]) { apps.requestRegistration({ app_id: id, app_name: id }); apps.approveApp(id); }
    const owners = createOwnerService({ db: opened.db, clock: () => new Date(now) });
    const invite = owners.createInvite({ applicationId: "owned-one", email: "Owner@example.com", role: "owner" });
    const claimed = await owners.claimInvite({ token: invite.token, email: "owner@example.com", password: "correct horse battery" });
    assert.equal(claimed.email, "owner@example.com");
    assert.deepEqual(owners.listApps({ userId: claimed.user_id }).map((app) => app.application_id), ["owned-one"]);
    await assert.rejects(owners.claimInvite({ token: invite.token, email: "owner@example.com", password: "correct horse battery" }), { code: "INVITE_INVALID" });
    const session = await owners.login({ email: "owner@example.com", password: "correct horse battery" });
    const req = { headers: { cookie: `SHFH_OWNER=${session.sessionToken}`, "x-csrf-token": session.csrfToken } };
    assert.equal(owners.authenticate(req).user_id, claimed.user_id);
    assert.throws(() => owners.authenticate({ headers: { cookie: req.headers.cookie } }, { mutation: true }), { code: "CSRF_REJECTED" });
    assert.equal(owners.authenticate({ headers: req.headers }, { mutation: true }).user_id, claimed.user_id);
    now = new Date("2026-10-31T13:00:00Z");
    assert.throws(() => owners.authenticate(req), { code: "OWNER_SESSION_EXPIRED" });
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("owner password validation and reset revokes existing sessions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-owner-reset-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  try {
    const apps = createAppService(opened.db); apps.requestRegistration({ app_id: "owned-reset", app_name: "owner" }); apps.approveApp("owned-reset");
    const owners = createOwnerService({ db: opened.db });
    const invite = owners.createInvite({ applicationId: "owned-reset", email: "reset@example.com", role: "owner" });
    await assert.rejects(owners.claimInvite({ token: invite.token, email: "reset@example.com", password: "short" }), { code: "INVALID_PASSWORD" });
    await owners.claimInvite({ token: invite.token, email: "reset@example.com", password: "a strong password 1" });
    const session = await owners.login({ email: "reset@example.com", password: "a strong password 1" });
    const reset = owners.createPasswordReset({ email: "reset@example.com" });
    await owners.completePasswordReset({ token: reset.token, password: "a stronger password 2" });
    assert.throws(() => owners.authenticate({ headers: { cookie: `SHFH_OWNER=${session.sessionToken}` } }), { code: "OWNER_SESSION_INVALID" });
    await assert.rejects(owners.login({ email: "reset@example.com", password: "a strong password 1" }), { code: "OWNER_LOGIN_FAILED" });
    assert.ok(await owners.login({ email: "reset@example.com", password: "a stronger password 2" }));
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
