/** Catalog mặc định — app thật trên SoloHost để quản lý ngay. */
export const DEFAULT_APPS = [
  { app_id: "solohost-feedback-hub", app_name: "SoloHost Feedback Hub", category: "ops", fee_required: false },
  { app_id: "pi-node-monitor", app_name: "Pi Node Monitor / Controller", category: "node", fee_required: false },
  { app_id: "telegram-controller-pro", app_name: "Telegram Controller PRO", category: "ops", fee_required: false },
  { app_id: "solohost-social", app_name: "SoloHost Social Network", category: "social", fee_required: false },
  { app_id: "personal-ai-hub", app_name: "Personal AI Hub", category: "ai", fee_required: false },
  { app_id: "personal-ai-assistant", app_name: "Personal AI Assistant", category: "ai", fee_required: false },
  { app_id: "brick-game-e9999", app_name: "Brick Game E-9999", category: "game", fee_required: false },
  { app_id: "snake-classic", app_name: "Snake Classic", category: "game", fee_required: false },
  { app_id: "youtube-music", app_name: "YouTube Music App", category: "media", fee_required: false },
];

export function seedApps(db) {
  const existing = db.read("apps");
  let added = 0;
  for (const app of DEFAULT_APPS) {
    if (!existing.find((a) => a.app_id === app.app_id)) {
      db.upsertApp(app);
      added += 1;
    }
  }
  return { total: db.read("apps").length, added };
}
