const TABLES = Object.freeze({
  feedback: { table: "feedback", app: "application_id", time: "created_at" },
  updates: { table: "updates", app: "application_id", time: "created_at" },
  notices: { table: "notices", app: "application_id", time: "created_at" },
  payments: { table: "payments_legacy", app: "application_id", time: "created_at" },
});

function parseJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

export function createSqliteCompatStore(db) {
  function ensureLegacyApp(appId) {
    if (!appId) throw new Error("Record app_id is required");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO applications(application_id, app_name, category, integration_status, legacy_json, created_at, updated_at)
      VALUES (?, ?, 'general', 'pending', '{}', ?, ?)
      ON CONFLICT(application_id) DO NOTHING`).run(appId, appId, now, now);
  }

  function appFromRow(row) {
    const stored = parseJson(row.legacy_json);
    if (stored.__hidden_from_legacy_list) return null;
    delete stored.__hidden_from_legacy_list;
    return { ...stored, app_id: row.application_id, app_name: row.app_name, category: row.category, integration_status: row.integration_status };
  }

  function upsertApp(partial = {}) {
    const appId = String(partial.app_id || "").trim();
    if (!appId) return null;
    const rows = db.prepare("SELECT * FROM applications WHERE application_id = ?").all(appId);
    const previous = rows[0];
    const existing = previous ? appFromRow(previous) : {};
    const now = new Date().toISOString();
    const value = {
      ...existing,
      ...partial,
      app_id: appId,
      app_name: partial.app_name || existing.app_name || appId,
      category: partial.category || existing.category || "general",
      status: partial.status || existing.status || "active",
      fee_required: partial.fee_required ?? existing.fee_required ?? false,
      current_version: partial.current_version || existing.current_version || "",
      support_url: partial.support_url || existing.support_url || "",
      created_at: existing.created_at || now,
      updated_at: now,
    };
    delete value.__hidden_from_legacy_list;
    const integrationStatus = value.approval_status === "approved" || (!previous && value.approval_status !== "pending" && value.status !== "pending")
      ? "approved"
      : previous?.integration_status || "pending";
    db.prepare(`INSERT INTO applications(application_id, app_name, category, integration_status, legacy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id) DO UPDATE SET app_name=excluded.app_name, category=excluded.category,
      legacy_json=excluded.legacy_json, updated_at=excluded.updated_at`)
      .run(appId, value.app_name, value.category, integrationStatus, JSON.stringify(value), value.created_at, now);
    return value;
  }

  function read(name) {
    if (name === "apps") return db.prepare("SELECT * FROM applications ORDER BY created_at, application_id").all().map(appFromRow).filter(Boolean);
    const spec = TABLES[name];
    if (!spec) throw new Error(`Unknown collection: ${name}`);
    return db.prepare(`SELECT record_json FROM ${spec.table} ORDER BY ${spec.time}, id`).all().map((row) => parseJson(row.record_json));
  }

  function write(name, records) {
    if (!Array.isArray(records)) throw new TypeError("Collection data must be an array");
    if (name === "apps") {
      const tx = db.isTransaction ? (fn) => fn() : (fn) => { db.exec("BEGIN IMMEDIATE"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } };
      return tx(() => {
        const ids = new Set();
        for (const row of records) {
          const id = String(row?.app_id || "").trim();
          if (!id || ids.has(id)) throw new Error("Each app must have a unique app_id");
          ids.add(id);
        }
        for (const row of db.prepare("SELECT application_id, legacy_json FROM applications").all()) {
          if (ids.has(row.application_id)) continue;
          const stored = parseJson(row.legacy_json);
          stored.__hidden_from_legacy_list = true;
          db.prepare("UPDATE applications SET integration_status='disabled', legacy_json=?, updated_at=? WHERE application_id=?")
            .run(JSON.stringify(stored), new Date().toISOString(), row.application_id);
        }
        for (const row of records) {
          upsertApp(row);
        }
      });
    }
    const spec = TABLES[name];
    if (!spec) throw new Error(`Unknown collection: ${name}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`DELETE FROM ${spec.table}`);
      for (const row of records) {
        const appId = String(row?.app_id || row?.application_id || "");
        const id = String(row?.id || "");
        if (!id) throw new Error(`${name} record id is required`);
        ensureLegacyApp(appId);
        const createdAt = String(row.created_at || new Date().toISOString());
        if (name === "feedback") {
          db.prepare(`INSERT INTO feedback(id, application_id, category, title, message, rating, status, priority, created_at, updated_at, record_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, appId, row.type || row.category || "general", row.title || "", row.message || "", Number(row.rating) || 0,
              row.status || "new", row.priority || row.ai?.priority || "P2", createdAt, row.updated_at || null, JSON.stringify(row));
        } else if (name === "payments") {
          const legacyPayment = {
            ...row,
            legacy_status: String(row.legacy_status || row.status || "unknown"),
            status: "legacy_unverified",
            verification_state: "legacy_unverified",
          };
          db.prepare(`INSERT INTO payments_legacy(id, application_id, created_at, verification_state, record_json)
            VALUES (?, ?, ?, 'legacy_unverified', ?)`)
            .run(id, appId, createdAt, JSON.stringify(legacyPayment));
        } else {
          db.prepare(`INSERT INTO ${spec.table}(id, application_id, created_at, record_json) VALUES (?, ?, ?, ?)`)
            .run(id, appId, createdAt, JSON.stringify(row));
        }
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  return { read, write, upsertApp };
}
