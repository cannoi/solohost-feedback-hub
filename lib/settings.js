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

function maskKey(k) {
  const s = String(k || "");
  if (s.length < 8) return s ? "••••" : "";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// Built-in donation info (owner's). Env vars PI_WALLET / MB_* override; Settings UI overrides; an EMPTY value falls back to these.
export const DEFAULT_DONATE = {
  pi_wallet: "GAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL",
  mb_bank: "MB Bank",
  mb_account: "0905428801",
  mb_name: "Tran Huu Nghi",
};
function mergeDonate(base, over) {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const v = over && over[k] != null ? String(over[k]).trim() : "";
    if (v) out[k] = v;
  }
  return out;
}

export function createSettings(dataDir, env) {
  const file = path.join(dataDir, "settings.json");
  const defaults = {
    hub_id: env.HUB_ID || "SHFH-CHANGE-ME",
    public_base_url: env.PUBLIC_BASE_URL || "",
    ingest_token: env.INGEST_TOKEN || "",
    donate: mergeDonate(DEFAULT_DONATE, { pi_wallet: env.PI_WALLET, mb_bank: env.MB_BANK, mb_account: env.MB_ACCOUNT, mb_name: env.MB_NAME }),
    ai: {
      provider: env.AI_PROVIDER || "",
      model: env.AI_MODEL || "",
      local_base_url: env.LOCAL_AI_BASE_URL || env.AI_BASE_URL || "",
      api_key: "",
    },
    admin_password_salt: "",
    admin_password_hash: "",
    updated_at: null,
  };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        ...defaults,
        ...raw,
        donate: mergeDonate(defaults.donate, raw.donate),
        ai: { ...defaults.ai, ...(raw.ai || {}) },
      };
    } catch {
      return { ...defaults, donate: { ...defaults.donate }, ai: { ...defaults.ai } };
    }
  }
  function save(next) {
    const t = file + ".tmp";
    fs.writeFileSync(t, JSON.stringify(next, null, 2));
    fs.renameSync(t, file);
    return next;
  }

  let state = load();

  return {
    file,
    get() { return state; },
    publicDonate() { return state.donate || defaults.donate; },
    ingestToken() { return state.ingest_token || env.INGEST_TOKEN || ""; },
    aiKey() { return state.ai?.api_key || env.AI_API_KEY || ""; },
    checkPassword(pw) {
      return verifyPassword(pw, state.admin_password_salt, state.admin_password_hash);
    },
    hasPassword() { return Boolean(state.admin_password_hash); },
    update(patch = {}) {
      const next = { ...state, donate: { ...state.donate }, ai: { ...state.ai } };
      if (patch.hub_id != null) next.hub_id = String(patch.hub_id).slice(0, 80);
      if (patch.public_base_url != null) next.public_base_url = String(patch.public_base_url).slice(0, 300);
      if (patch.ingest_token != null) next.ingest_token = String(patch.ingest_token).slice(0, 200);
      if (patch.donate) next.donate = mergeDonate(defaults.donate, { ...next.donate, ...patch.donate });
      if (patch.ai) {
        const a = { ...patch.ai };
        if (a.api_key === "" || a.api_key == null || String(a.api_key).includes("…")) delete a.api_key;
        next.ai = { ...next.ai, ...a };
      }
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
    const key = state.ai?.api_key || env.AI_API_KEY || "";
    return {
      hub_id: state.hub_id,
      public_base_url: state.public_base_url,
      ingest_token: state.ingest_token,
      donate: state.donate,
      ai: {
        provider: state.ai?.provider || "",
        model: state.ai?.model || "",
        local_base_url: state.ai?.local_base_url || "",
        has_api_key: Boolean(key),
        api_key_masked: maskKey(key),
      },
      has_password: Boolean(state.admin_password_hash),
      updated_at: state.updated_at,
    };
  }
}
