import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../lib/db.js";
import { importJsonData } from "../lib/json-import.js";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "shfh-import-")); }
function copyFixture(dataDir) {
  const fixture = path.resolve("tests/fixtures/legacy-data");
  for (const name of fs.readdirSync(fixture)) fs.copyFileSync(path.join(fixture, name), path.join(dataDir, name));
}
function open(dataDir) { return openDatabase({ dataDir: path.join(dataDir, "db"), migrationsDir: path.resolve("db/migrations") }); }

test("JSON import preserves records while downgrading old confirmed payments", () => {
  const dataDir = tempDir(); copyFixture(dataDir);
  const before = Object.fromEntries(fs.readdirSync(dataDir).map((name) => [name, fs.readFileSync(path.join(dataDir, name), "utf8")]));
  const opened = open(dataDir);
  try {
    const first = importJsonData({ db: opened.db, dataDir });
    assert.equal(first.imported.apps, 1);
    assert.equal(first.imported.feedback, 1);
    assert.equal(first.imported.updates, 1);
    assert.equal(first.imported.notices, 1);
    assert.equal(first.imported.payments, 1);
    assert.equal(opened.db.prepare("SELECT id FROM feedback WHERE id='FB-fixture-1'").get().id, "FB-fixture-1");
    const payment = opened.db.prepare("SELECT verification_state, record_json FROM payments_legacy WHERE id='PAY-fixture-1'").get();
    assert.equal(payment.verification_state, "legacy_unverified");
    const legacyPayment = JSON.parse(payment.record_json);
    assert.equal(legacyPayment.status, "legacy_unverified");
    assert.equal(legacyPayment.legacy_status, "confirmed");
    const second = importJsonData({ db: opened.db, dataDir });
    assert.equal(second.skipped.already_imported, true);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM feedback").get().n, 1);
    for (const [name, contents] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dataDir, name), "utf8"), contents);
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("malformed JSON aborts import without importing partial data", () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "apps.json"), JSON.stringify([{ app_id: "safe-app", app_name: "Safe" }]));
  fs.writeFileSync(path.join(dataDir, "feedback.json"), "[{broken");
  const opened = open(dataDir);
  try {
    assert.throws(() => importJsonData({ db: opened.db, dataDir }), /feedback\.json/i);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM applications").get().n, 0);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM json_import_runs").get().n, 0);
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("duplicate IDs abort import without dropping either source row", () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "apps.json"), JSON.stringify([{ app_id: "dup-app", app_name: "Dup" }]));
  fs.writeFileSync(path.join(dataDir, "feedback.json"), JSON.stringify([
    { id: "same-id", app_id: "dup-app", message: "first" },
    { id: "same-id", app_id: "dup-app", message: "second" },
  ]));
  const opened = open(dataDir);
  try {
    assert.throws(() => importJsonData({ db: opened.db, dataDir }), /duplicate.*feedback/i);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM applications").get().n, 0);
    assert.equal(opened.db.prepare("SELECT count(*) AS n FROM feedback").get().n, 0);
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("migration dry run reports counts without exposing records or creating a database", () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "apps.json"), JSON.stringify([{ app_id: "private-app", app_name: "private name" }]));
  fs.writeFileSync(path.join(dataDir, "feedback.json"), JSON.stringify([{ id: "secret-id", app_id: "private-app", message: "do not print this" }]));
  const result = spawnSync(process.execPath, ["scripts/migrate-json.js", "--dry-run"], {
    cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir }, encoding: "utf8",
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.counts.apps, 1);
    assert.equal(report.counts.feedback, 1);
    assert.doesNotMatch(result.stdout, /private name|do not print this|secret-id/);
    assert.equal(fs.existsSync(path.join(dataDir, "feedback-hub.sqlite")), false);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
