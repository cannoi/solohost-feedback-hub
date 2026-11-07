import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-apps-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  return { dataDir, opened, service: createAppService(opened.db) };
}

test("registration creates pending app and requires explicit approval before key issue", () => {
  const { dataDir, opened, service } = setup();
  try {
    const app = service.requestRegistration({ app_id: "owner-portal", app_name: "Owner Portal", application_url: "https://example.test" });
    assert.equal(app.application_id, "owner-portal");
    assert.equal(app.integration_status, "pending");
    assert.throws(() => service.issueCredential(app.application_id, ["feedback:write"]), { code: "APP_NOT_APPROVED" });
    const auth = service.approveApp(app.application_id);
    assert.equal(auth.integration_status, "approved");
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("registration rejects invalid and duplicate application IDs", () => {
  const { dataDir, opened, service } = setup();
  try {
    assert.throws(() => service.requestRegistration({ app_id: "../escape", app_name: "Bad" }), { code: "INVALID_APP" });
    service.requestRegistration({ app_id: "same-app", app_name: "One" });
    assert.throws(() => service.requestRegistration({ app_id: "same-app", app_name: "Two" }), { code: "APP_EXISTS" });
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("credential rotation and revocation keep only hashes in SQLite", () => {
  const { dataDir, opened, service } = setup();
  try {
    service.requestRegistration({ app_id: "credential-app", app_name: "Cred App" });
    service.approveApp("credential-app");
    const first = service.issueCredential("credential-app", ["feedback:read", "feedback:write"]);
    const hash = createHash("sha256").update(first.secret).digest("hex");
    const stored = opened.db.prepare("SELECT secret_hash, scopes_json, revoked_at FROM api_credentials WHERE credential_id=?").get(first.credential_id);
    assert.equal(stored.secret_hash, hash);
    assert.equal(JSON.stringify(stored).includes(first.secret), false);
    assert.deepEqual(JSON.parse(stored.scopes_json), ["feedback:read", "feedback:write"]);
    const second = service.issueCredential("credential-app", ["feedback:write"]);
    assert.ok(service.authenticateCredential(first.secret));
    assert.ok(service.authenticateCredential(second.secret));
    service.revokeCredential(first.credential_id);
    assert.equal(service.authenticateCredential(first.secret), null);
    assert.ok(service.authenticateCredential(second.secret));
    service.disableApp("credential-app");
    assert.equal(service.authenticateCredential(second.secret), null);
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

