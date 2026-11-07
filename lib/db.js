import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase({ dataDir, migrationsDir }) {
  if (!dataDir || !migrationsDir) throw new TypeError("dataDir and migrationsDir are required");
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "feedback-hub.sqlite");
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
    const files = fs.readdirSync(migrationsDir).filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/i.test(name)).sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return {
      db,
      file,
      transaction(fn) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      close() { if (db.isOpen) db.close(); },
    };
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}
