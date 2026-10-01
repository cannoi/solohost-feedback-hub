import fs from "node:fs";
import path from "node:path";

export function createFileDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const files = {
    apps: path.join(dataDir, "apps.json"),
    feedback: path.join(dataDir, "feedback.json"),
    updates: path.join(dataDir, "updates.json"),
    notices: path.join(dataDir, "notices.json"),
    payments: path.join(dataDir, "payments.json"),
  };
  for (const f of Object.values(files)) if (!fs.existsSync(f)) fs.writeFileSync(f, "[]");

  const read = (key) => {
    try { return JSON.parse(fs.readFileSync(files[key], "utf8")); } catch { return []; }
  };
  const write = (key, data) => {
    const t = files[key] + ".tmp";
    fs.writeFileSync(t, JSON.stringify(data, null, 2));
    fs.renameSync(t, files[key]);
  };

  return {
    files,
    read,
    write,
    upsertApp(partial) {
      const apps = read("apps");
      const id = String(partial.app_id || "").trim();
      if (!id) return null;
      const i = apps.findIndex((a) => a.app_id === id);
      const now = new Date().toISOString();
      const row = {
        app_id: id,
        app_name: partial.app_name || id,
        category: partial.category || "general",
        status: partial.status || "active",
        fee_required: Boolean(partial.fee_required),
        current_version: partial.current_version || "",
        support_url: partial.support_url || "",
        created_at: i >= 0 ? apps[i].created_at : now,
        updated_at: now,
      };
      if (i >= 0) apps[i] = { ...apps[i], ...row };
      else apps.push(row);
      write("apps", apps);
      return row;
    },
  };
}
