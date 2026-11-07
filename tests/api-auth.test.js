import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { parseBearer, authorizeCredential } from "../lib/api-auth.js";

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-auth-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  const apps = createAppService(opened.db);
  apps.requestRegistration({ app_id: "auth-app", app_name: "Auth App" });
  apps.approveApp("auth-app");
  const credential = apps.issueCredential("auth-app", ["feedback:read"]);
  return { dataDir, opened, apps, credential };
}

test("parseBearer accepts only a single bearer credential", () => {
  assert.equal(parseBearer({ headers: { authorization: "Bearer shfh_test" } }), "shfh_test");
  assert.equal(parseBearer({ headers: { authorization: "bearer shfh_test" } }), "shfh_test");
  assert.equal(parseBearer({ headers: { authorization: "Basic shfh_test" } }), null);
  assert.equal(parseBearer({ headers: { authorization: "Bearer one two" } }), null);
  assert.equal(parseBearer({ headers: {} }), null);
});

test("credential auth rejects wrong and revoked keys and enforces exact scopes", () => {
  const { dataDir, opened, apps, credential } = setup();
  try {
    const context = apps.authenticateCredential(credential.secret);
    assert.equal(context.applicationId, "auth-app");
    assert.equal(authorizeCredential(context, "feedback:read"), true);
    assert.equal(authorizeCredential(context, "feedback:write"), false);
    assert.equal(apps.authenticateCredential("shfh_invalid"), null);
    apps.revokeCredential(credential.credential_id);
    assert.equal(apps.authenticateCredential(credential.secret), null);
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
