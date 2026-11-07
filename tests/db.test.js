import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { createSqliteCompatStore } from "../lib/sqlite-compat-store.js";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "shfh-db-")); }

test("openDatabase applies migrations once and enables relational integrity", () => {
  const dataDir = tempDir();
  const first = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  try {
    assert.equal(first.db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n, 11);
    assert.equal(first.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(first.db.prepare("PRAGMA journal_mode").get().journal_mode.toLowerCase(), "wal");
    first.db.prepare("INSERT INTO applications(application_id, app_name, integration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tenant-a", "A", "approved", new Date().toISOString(), new Date().toISOString());
    assert.throws(() => first.db.prepare("INSERT INTO feedback(id, application_id, message, created_at) VALUES (?, ?, ?, ?)").run("f1", "missing", "x", new Date().toISOString()), /FOREIGN KEY/i);
    first.db.prepare("INSERT INTO applications(application_id, app_name, integration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tenant-b", "B", "approved", new Date().toISOString(), new Date().toISOString());
    assert.throws(() => first.db.prepare("INSERT INTO applications(application_id, app_name, integration_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tenant-a", "Again", "approved", new Date().toISOString(), new Date().toISOString()), /UNIQUE/i);
  } finally { first.close(); }

  const second = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  try { assert.equal(second.db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n, 11); }
  finally { second.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("sqlite compatibility store preserves collection-shaped records", () => {
  const dataDir = tempDir();
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  try {
    const store = createSqliteCompatStore(opened.db);
    const app = store.upsertApp({ app_id: "compat-app", app_name: "Compat", category: "utility" });
    assert.equal(app.app_id, "compat-app");
    const item = { id: "FB-1", app_id: "compat-app", message: "hello", status: "NEW", created_at: new Date().toISOString() };
    store.write("feedback", [item]);
    assert.deepEqual(store.read("feedback"), [item]);
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});





test("replacing the legacy app list hides apps without deleting tenant records", () => {
  const dataDir = tempDir();
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  try {
    const store = createSqliteCompatStore(opened.db);
    store.upsertApp({ app_id: "retained-app", app_name: "Retained" });
    const item = { id: "FB-keep", app_id: "retained-app", message: "keep me", created_at: new Date().toISOString() };
    store.write("feedback", [item]);
    store.write("apps", []);
    assert.deepEqual(store.read("apps"), []);
    assert.deepEqual(store.read("feedback"), [item]);
    assert.equal(opened.db.prepare("SELECT integration_status FROM applications WHERE application_id='retained-app'").get().integration_status, "disabled");
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("legacy payment writes never retain client-confirmed as verified state", () => {
  const dataDir = tempDir();
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  try {
    const store = createSqliteCompatStore(opened.db);
    store.write("payments", [{ id: "PAY-legacy", app_id: "compat-app", status: "confirmed", amount: "1", created_at: new Date().toISOString() }]);
    const [payment] = store.read("payments");
    assert.equal(payment.status, "legacy_unverified");
    assert.equal(payment.legacy_status, "confirmed");
    assert.equal(payment.verification_state, "legacy_unverified");
  } finally { opened.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
