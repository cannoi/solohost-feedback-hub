import crypto from "node:crypto";

export const APP_SCOPES = Object.freeze(["feedback:write", "feedback:read", "feedback:manage", "notifications:write", "notifications:read", "fees:create", "fees:read", "fees:simulate", "payments:create", "payments:read", "webhooks:manage", "webhooks:read", "apps:read"]);
const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanText(value, max, field, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) throw fail("INVALID_APP", `${field} is required`);
  if (text.length > max) throw fail("INVALID_APP", `${field} is too long`);
  return text;
}

function webUrl(value, field) {
  const text = cleanText(value, 500, field);
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { throw fail("INVALID_APP", `${field} must be an absolute HTTP(S) URL`); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw fail("INVALID_APP", `${field} must be an absolute HTTP(S) URL without credentials`);
  return url.toString();
}

function appView(row) {
  return row ? {
    application_id: row.application_id,
    app_name: row.app_name,
    category: row.category,
    description: row.description,
    application_url: row.application_url,
    backend_api_url: row.backend_api_url,
    integration_status: row.integration_status,
    allowed_origins: JSON.parse(row.allowed_origins_json || "[]"),
    enabled_features: JSON.parse(row.enabled_features_json || "[]"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  } : null;
}

export function createAppService(db, { clock = () => new Date() } = {}) {
  function requestRegistration(input = {}) {
    const applicationId = cleanText(input.app_id ?? input.application_id, 64, "app_id", true).toLowerCase();
    if (!APP_ID_RE.test(applicationId)) throw fail("INVALID_APP", "app_id must be a 2–64 character slug");
    const appName = cleanText(input.app_name ?? input.name, 120, "app_name", true);
    const description = cleanText(input.description, 1000, "description");
    const applicationUrl = webUrl(input.application_url ?? input.url, "application_url");
    const backendApiUrl = webUrl(input.backend_api_url, "backend_api_url");
    const now = clock().toISOString();
    try {
      db.prepare(`INSERT INTO applications(application_id, app_name, category, description, application_url, backend_api_url,
        integration_status, allowed_origins_json, enabled_features_json, legacy_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', '[]', '{}', ?, ?)`)
        .run(applicationId, appName, cleanText(input.category || "general", 60, "category"), description,
          applicationUrl, backendApiUrl, now, now);
    } catch (error) {
      if (error.code === "ERR_SQLITE_ERROR" || /UNIQUE constraint failed/i.test(error.message)) {
        if (db.prepare("SELECT 1 FROM applications WHERE application_id=?").get(applicationId)) throw fail("APP_EXISTS", "Application ID is already registered");
      }
      throw error;
    }
    return appView(db.prepare("SELECT * FROM applications WHERE application_id=?").get(applicationId));
  }

  function approveApp(applicationId) {
    const now = clock().toISOString();
    const result = db.prepare("UPDATE applications SET integration_status='approved', updated_at=? WHERE application_id=? AND integration_status IN ('pending','approved')")
      .run(now, applicationId);
    if (!result.changes) {
      if (!db.prepare("SELECT 1 FROM applications WHERE application_id=?").get(applicationId)) throw fail("APP_NOT_FOUND", "Application not found");
      throw fail("APP_NOT_APPROVABLE", "Application is disabled or rejected");
    }
    const row = db.prepare("SELECT * FROM applications WHERE application_id=?").get(applicationId);
    let legacy = {};
    try { legacy = JSON.parse(row.legacy_json || "{}"); } catch {}
    if (legacy.approval_status === "pending") {
      legacy.approval_status = "approved";
      legacy.status = "active";
      db.prepare("UPDATE applications SET legacy_json=? WHERE application_id=?").run(JSON.stringify(legacy), applicationId);
    }
    return appView(row);
  }

  function disableApp(applicationId) {
    const row = db.prepare("SELECT legacy_json FROM applications WHERE application_id=?").get(applicationId);
    if (!row) throw fail("APP_NOT_FOUND", "Application not found");
    let legacy = {};
    try { legacy = JSON.parse(row.legacy_json || "{}"); } catch {}
    legacy.__hidden_from_legacy_list = true;
    const result = db.prepare("UPDATE applications SET integration_status='disabled', legacy_json=?, updated_at=? WHERE application_id=?")
      .run(JSON.stringify(legacy), clock().toISOString(), applicationId);
    if (!result.changes) throw fail("APP_NOT_FOUND", "Application not found");
    return appView(db.prepare("SELECT * FROM applications WHERE application_id=?").get(applicationId));
  }

  function issueCredential(applicationId, scopes) {
    const app = db.prepare("SELECT integration_status FROM applications WHERE application_id=?").get(applicationId);
    if (!app) throw fail("APP_NOT_FOUND", "Application not found");
    if (app.integration_status !== "approved") throw fail("APP_NOT_APPROVED", "Application must be approved before issuing credentials");
    if (!Array.isArray(scopes) || !scopes.length) throw fail("INVALID_SCOPES", "At least one API scope is required");
    const normalized = [...new Set(scopes.map((scope) => String(scope)))].sort();
    if (normalized.some((scope) => !APP_SCOPES.includes(scope))) throw fail("INVALID_SCOPES", "One or more API scopes are not enabled");
    const secret = `shfh_live_${crypto.randomBytes(32).toString("base64url")}`;
    const secretHash = crypto.createHash("sha256").update(secret, "utf8").digest("hex");
    const credentialId = `cred_${crypto.randomBytes(12).toString("hex")}`;
    const createdAt = clock().toISOString();
    db.prepare(`INSERT INTO api_credentials(credential_id, application_id, secret_hash, scopes_json, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(credentialId, applicationId, secretHash, JSON.stringify(normalized), createdAt);
    return { credential_id: credentialId, application_id: applicationId, secret, scopes: normalized, created_at: createdAt };
  }

  function revokeCredential(credentialId) {
    const result = db.prepare("UPDATE api_credentials SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL")
      .run(clock().toISOString(), credentialId);
    return result.changes > 0;
  }

  function authenticateCredential(secret) {
    if (typeof secret !== "string" || !/^shfh_live_[A-Za-z0-9_-]{40,60}$/.test(secret)) return null;
    const digest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");
    const row = db.prepare(`SELECT c.credential_id, c.application_id, c.secret_hash, c.scopes_json,
      c.expires_at, c.revoked_at, a.integration_status
      FROM api_credentials c JOIN applications a USING(application_id) WHERE c.secret_hash=?`).get(digest);
    if (!row) {
      crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.alloc(32));
      return null;
    }
    const actual = Buffer.from(row.secret_hash, "hex");
    const expected = Buffer.from(digest, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    if (row.revoked_at || row.integration_status !== "approved" || (row.expires_at && Date.parse(row.expires_at) <= clock().getTime())) return null;
    let scopes;
    try { scopes = JSON.parse(row.scopes_json); } catch { return null; }
    if (!Array.isArray(scopes) || scopes.some((scope) => !APP_SCOPES.includes(scope))) return null;
    db.prepare("UPDATE api_credentials SET last_used_at=? WHERE credential_id=?").run(clock().toISOString(), row.credential_id);
    return { applicationId: row.application_id, credentialId: row.credential_id, scopes };
  }

  return { requestRegistration, approveApp, disableApp, issueCredential, revokeCredential, authenticateCredential };
}
