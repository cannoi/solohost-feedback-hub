import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { importJsonData, inspectJsonImport } from "../lib/json-import.js";

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const dryRun = process.argv.includes("--dry-run");

try {
  if (dryRun) {
    const { counts } = inspectJsonImport(dataDir);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "dry-run", counts })}\n`);
  } else {
    const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
    try {
      const result = importJsonData({ db: opened.db, dataDir });
      process.stdout.write(`${JSON.stringify({ ok: true, mode: "import", ...result })}\n`);
    } finally { opened.close(); }
  }
} catch (error) {
  process.stderr.write(`JSON migration failed: ${String(error?.message || "invalid source data").slice(0, 240)}\n`);
  process.exitCode = 1;
}
