import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(crypto.scryptSync(String(password), salt, 32));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSettings(dataDir, env) {
  const file = path.join(dataDir, "settings.json");
  const defaults = {
    hub_id: env.HUB_ID || "SHFH-CHANGE-ME",
    public_base_url: env.PUBLIC_BASE_URL || "",
    ingest_token: env.INGEST_TOKEN || "",
    donate: {
      pi_wallet: env.PI_WALLET || "",
      mb_bank: env.MB_BANK || "MB Bank",
      mb_account: env.MB_ACCOUNT || "",
      mb_name: env.MB_NAME || "",
    },
    ai: {
      provider: env.AI_PROVIDER || "",
      model: env.AI_MODEL || "",
      local_base_url: env.LOCAL_AI_BASE_URL || env.AI_BASE_URL || "",
    },
    admin_password_salt: "",
    admin_password_hash: "",
    updated_at: null,
  };

  function load() {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { ...defaults };
    }
  }
  function save(next) {
    const t = file + ".tmp";
    fs.writeFileSync(t, JSON.stringify(next, null, 2));
    fs.renameSync(t, file);
    return next;
  }

  let state = load();
  if (!state.admin_password_hash) {
    const bootstrap = env.ADMIN_PASSWORD || env.ADMIN_TOKEN || "";
    if (bootstrap) {
      const hp = hashPassword(bootstrap);
      state.admin_password_salt = hp.salt;
      state.admin_password_hash = hp.hash;
      state.updated_at = new Date().toISOString();
      save(state);
    }
  }

  return {
    file,
    get() { return state; },
    publicDonate() { return state.donate || defaults.donate; },
    ingestToken() { return state.ingest_token || env.INGEST_TOKEN || ""; },
    checkPassword(pw) {
      return verifyPassword(pw, state.admin_password_salt, state.admin_password_hash);
    },
    hasPassword() { return Boolean(state.admin_password_hash); },
    update(patch = {}) {
      const next = { ...state };
      if (patch.hub_id != null) next.hub_id = String(patch.hub_id).slice(0, 80);
      if (patch.public_base_url != null) next.public_base_url = String(patch.public_base_url).slice(0, 300);
      if (patch.ingest_token != null) next.ingest_token = String(patch.ingest_token).slice(0, 200);
      if (patch.donate) next.donate = { ...next.donate, ...patch.donate };
      if (patch.ai) next.ai = { ...next.ai, ...patch.ai };
      if (patch.admin_password) {
        const hp = hashPassword(patch.admin_password);
        next.admin_password_salt = hp.salt;
        next.admin_password_hash = hp.hash;
      }
      next.updated_at = new Date().toISOString();
      state = save(next);
      return publicView();
    },
    publicView() {
      return publicView();
    },
  };

  function publicView() {
    return {
      hub_id: state.hub_id,
      public_base_url: state.public_base_url,
      ingest_token: state.ingest_token,
      donate: state.donate,
      ai: {
        provider: state.ai?.provider || "",
        model: state.ai?.model || "",
        local_base_url: state.ai?.local_base_url || "",
        has_api_key: Boolean(env.AI_API_KEY || env.XAI_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY),
      },
      has_password: Boolean(state.admin_password_hash),
      updated_at: state.updated_at,
    };
  }
}
