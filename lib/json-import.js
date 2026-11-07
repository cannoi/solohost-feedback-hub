import fs from "node:fs";
import path from "node:path";

const IMPORT_NAME = "legacy-json-v1";
const FILES = ["apps", "feedback", "updates", "notices", "payments"];

function readCollection(dataDir, name) {
  const file = path.join(dataDir, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  let rows;
  try {
    const source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    rows = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in ${name}.json`);
  }
  if (!Array.isArray(rows)) throw new Error(`${name}.json must contain an array`);
  const ids = new Set();
  for (const row of rows) {
    const id = name === "apps" ? String(row?.app_id || "").trim() : String(row?.id || "").trim();
    if (!id) throw new Error(`Missing ${name === "apps" ? "app_id" : "id"} in ${name}.json`);
    if (ids.has(id)) throw new Error(`Duplicate ID in ${name}.json: ${id}`);
    ids.add(id);
  }
  return rows;
}

export function inspectJsonImport(dataDir) {
  const collections = Object.fromEntries(FILES.map((name) => [name, readCollection(dataDir, name)]));
  return {
    counts: Object.fromEntries(FILES.map((name) => [name, collections[name].length])),
    collections,
  };
}

function ensureApp(db, appId, appsById) {
  if (!appId) throw new Error("Application ID is required for imported records");
  if (appsById.has(appId)) return;
  const now = new Date().toISOString();
  const row = { app_id: appId, app_name: appId, category: "general", status: "pending", imported_placeholder: true };
  db.prepare(`INSERT INTO applications(application_id, app_name, category, integration_status, legacy_json, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(appId, appId, "general", JSON.stringify(row), now, now);
  appsById.set(appId, row);
}

function appStatus(row) {
  if (row.integration_status) return row.integration_status;
  if (["active", "approved"].includes(String(row.status || "active").toLowerCase())) return "approved";
  if (["paused", "disabled", "archived", "rejected"].includes(String(row.status || "").toLowerCase())) return "disabled";
  return "pending";
}

export function importJsonData({ db, dataDir }) {
  if (!db || !dataDir) throw new TypeError("db and dataDir are required");
  const prior = db.prepare("SELECT imported_counts_json FROM json_import_runs WHERE import_name=?").get(IMPORT_NAME);
  if (prior) {
    return { imported: JSON.parse(prior.imported_counts_json), skipped: { already_imported: true }, warnings: [] };
  }

  // Parse and validate every source before opening the write transaction. A malformed file never causes a partial import.
  const { counts, collections } = inspectJsonImport(dataDir);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const appsById = new Map();
    const insertApp = db.prepare(`INSERT INTO applications(application_id, app_name, category, description, application_url,
      backend_api_url, integration_status, allowed_origins_json, enabled_features_json, legacy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of collections.apps) {
      const appId = String(row.app_id).trim();
      const record = { ...row, app_id: appId };
      const createdAt = String(row.created_at || now);
      insertApp.run(appId, String(row.app_name || appId), String(row.category || "general"), String(row.description || ""),
        String(row.application_url || row.url || ""), String(row.backend_api_url || ""), appStatus(row),
        JSON.stringify(Array.isArray(row.allowed_origins) ? row.allowed_origins : []),
        JSON.stringify(Array.isArray(row.enabled_features) ? row.enabled_features : []), JSON.stringify(record),
        createdAt, String(row.updated_at || createdAt));
      appsById.set(appId, record);
    }

    const insertFeedback = db.prepare(`INSERT INTO feedback(id, application_id, category, title, message, rating, status,
      priority, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of collections.feedback) {
      const appId = String(row.app_id || row.application_id || "").trim(); ensureApp(db, appId, appsById);
      const category = String(row.category || row.type || "general");
      const createdAt = String(row.created_at || now);
      insertFeedback.run(String(row.id), appId, category, String(row.title || ""), String(row.message || ""),
        Number.isInteger(Number(row.rating)) && Number(row.rating) >= 0 && Number(row.rating) <= 5 ? Number(row.rating) : 0,
        String(row.status || "NEW"), String(row.priority || row.ai?.priority || "P2"), createdAt,
        row.updated_at ? String(row.updated_at) : null, JSON.stringify(row));
    }

    const insertUpdate = db.prepare("INSERT INTO updates(id, application_id, created_at, record_json) VALUES (?, ?, ?, ?)");
    for (const row of collections.updates) {
      const appId = String(row.app_id || row.application_id || "").trim(); ensureApp(db, appId, appsById);
      insertUpdate.run(String(row.id), appId, String(row.created_at || now), JSON.stringify(row));
    }

    const insertNotice = db.prepare("INSERT INTO notices(id, application_id, created_at, record_json) VALUES (?, ?, ?, ?)");
    for (const row of collections.notices) {
      const appId = String(row.app_id || row.application_id || "").trim(); ensureApp(db, appId, appsById);
      insertNotice.run(String(row.id), appId, String(row.created_at || now), JSON.stringify(row));
    }

    const insertPayment = db.prepare(`INSERT INTO payments_legacy(id, application_id, created_at, verification_state, record_json)
      VALUES (?, ?, ?, 'legacy_unverified', ?)`);
    for (const row of collections.payments) {
      const appId = String(row.app_id || row.application_id || "").trim(); ensureApp(db, appId, appsById);
      const legacy = { ...row, legacy_status: String(row.legacy_status || row.status || "unknown"), status: "legacy_unverified", verification_state: "legacy_unverified" };
      insertPayment.run(String(row.id), appId, String(row.created_at || now), JSON.stringify(legacy));
    }

    db.prepare("INSERT INTO json_import_runs(import_name, imported_at, imported_counts_json) VALUES (?, ?, ?)")
      .run(IMPORT_NAME, now, JSON.stringify(counts));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { imported: counts, skipped: { already_imported: false }, warnings: [] };
}
