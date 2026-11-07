import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_LENGTH_MIN = 12;
const PASSWORD_LENGTH_MAX = 200;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function hashToken(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function emailAddress(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail("INVALID_EMAIL", "Email address is invalid");
  return email;
}
function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_LENGTH_MIN || password.length > PASSWORD_LENGTH_MAX || /[\u0000-\u001f]/.test(password)) throw fail("INVALID_PASSWORD", "Password must be 12 to 200 characters");
}
async function passwordHash(password, salt = crypto.randomBytes(16)) {
  validatePassword(password);
  const derived = await scryptAsync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: Buffer.from(salt).toString("base64url"), hash: Buffer.from(derived).toString("hex") };
}
function constantEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "hex"), bb = Buffer.from(String(b || ""), "hex");
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function createOwnerService({ db, clock = () => new Date() }) {
  if (!db) throw new TypeError("db is required");

  function createInvite({ applicationId, email, role = "owner" }) {
    const targetEmail = emailAddress(email);
    if (!["owner", "admin", "member"].includes(role)) throw fail("INVALID_ROLE", "Membership role is invalid");
    const app = db.prepare("SELECT integration_status FROM applications WHERE application_id=?").get(applicationId);
    if (!app || app.integration_status !== "approved") throw fail("APP_NOT_AVAILABLE", "An approved application is required");
    const token = `shfh_invite_${crypto.randomBytes(32).toString("base64url")}`;
    const now = clock();
    db.prepare("INSERT INTO owner_invites(invite_id,application_id,email,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(`inv_${crypto.randomUUID()}`, applicationId, targetEmail, role, hashToken(token), new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString(), now.toISOString());
    return { token, application_id: applicationId, email: targetEmail, role, expires_at: new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString() };
  }

  async function claimInvite({ token, email, password }) {
    const targetEmail = emailAddress(email);
    if (typeof token !== "string" || !/^shfh_invite_[A-Za-z0-9_-]{40,60}$/.test(token)) throw fail("INVITE_INVALID", "Invitation is invalid or expired");
    const tokenDigest = hashToken(token);
    const now = clock().toISOString();
    const invite = db.prepare("SELECT * FROM owner_invites WHERE token_hash=? AND claimed_at IS NULL AND expires_at>? AND email=? COLLATE NOCASE").get(tokenDigest, now, targetEmail);
    if (!invite) throw fail("INVITE_INVALID", "Invitation is invalid or expired");
    let user = db.prepare("SELECT user_id,email,status FROM owner_users WHERE email=? COLLATE NOCASE").get(targetEmail);
    let credentials;
    if (!user) credentials = await passwordHash(password);
    else validatePassword(password);
    return tx(db, () => {
      const current = db.prepare("SELECT * FROM owner_invites WHERE invite_id=? AND claimed_at IS NULL AND expires_at>? ").get(invite.invite_id, clock().toISOString());
      if (!current) throw fail("INVITE_INVALID", "Invitation is invalid or expired");
      if (!user) {
        const userId = `usr_${crypto.randomUUID()}`;
        db.prepare("INSERT INTO owner_users(user_id,email,password_salt,password_hash,status,created_at,updated_at) VALUES(?,?,?,?, 'active',?,?)")
          .run(userId, targetEmail, credentials.salt, credentials.hash, now, now);
        user = { user_id: userId, email: targetEmail, status: "active" };
      }
      if (user.status !== "active") throw fail("OWNER_DISABLED", "Owner account is disabled");
      db.prepare("INSERT INTO application_memberships(application_id,user_id,role,created_at) VALUES(?,?,?,?)")
        .run(invite.application_id, user.user_id, invite.role, now);
      const claimed = db.prepare("UPDATE owner_invites SET claimed_at=? WHERE invite_id=? AND claimed_at IS NULL").run(now, invite.invite_id);
      if (!claimed.changes) throw fail("INVITE_INVALID", "Invitation is invalid or expired");
      return { user_id: user.user_id, email: user.email, application_id: invite.application_id, role: invite.role };
    });
  }

  async function login({ email, password }) {
    const targetEmail = emailAddress(email);
    const user = db.prepare("SELECT * FROM owner_users WHERE email=? COLLATE NOCASE AND status='active'").get(targetEmail);
    if (!user) throw fail("OWNER_LOGIN_FAILED", "Email or password is incorrect");
    let computed;
    try { computed = await scryptAsync(String(password || ""), Buffer.from(user.password_salt, "base64url"), 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    catch { throw fail("OWNER_LOGIN_FAILED", "Email or password is incorrect"); }
    if (!constantEqual(Buffer.from(computed).toString("hex"), user.password_hash)) throw fail("OWNER_LOGIN_FAILED", "Email or password is incorrect");
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const now = clock();
    db.prepare("INSERT INTO owner_sessions(session_id,user_id,session_hash,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)")
      .run(`ses_${crypto.randomUUID()}`, user.user_id, hashToken(sessionToken), hashToken(csrfToken), now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
    return { user_id: user.user_id, email: user.email, sessionToken, csrfToken, expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString() };
  }

  function cookieToken(req) {
    const raw = String(req.headers?.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("SHFH_OWNER="));
    if (!raw) return null;
    try { return decodeURIComponent(raw.slice("SHFH_OWNER=".length)); } catch { return null; }
  }

  function authenticate(req, { mutation = false } = {}) {
    const token = cookieToken(req);
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw fail("OWNER_SESSION_INVALID", "Owner session is invalid");
    const session = db.prepare(`SELECT s.session_id,s.user_id,s.csrf_hash,s.expires_at,u.email,u.status
      FROM owner_sessions s JOIN owner_users u USING(user_id) WHERE s.session_hash=? AND s.revoked_at IS NULL`).get(hashToken(token));
    if (!session || session.status !== "active") throw fail("OWNER_SESSION_INVALID", "Owner session is invalid");
    if (Date.parse(session.expires_at) <= clock().getTime()) {
      db.prepare("UPDATE owner_sessions SET revoked_at=? WHERE session_id=?").run(clock().toISOString(), session.session_id);
      throw fail("OWNER_SESSION_EXPIRED", "Owner session has expired");
    }
    if (mutation && !constantEqual(hashToken(req.headers?.["x-csrf-token"]), session.csrf_hash)) throw fail("CSRF_REJECTED", "A valid CSRF token is required");
    db.prepare("UPDATE owner_sessions SET last_used_at=? WHERE session_id=?").run(clock().toISOString(), session.session_id);
    return { user_id: session.user_id, email: session.email };
  }

  function listApps({ userId }) {
    return db.prepare(`SELECT a.application_id,a.app_name,a.integration_status,a.application_url,m.role
      FROM application_memberships m JOIN applications a USING(application_id) WHERE m.user_id=? ORDER BY a.app_name`).all(userId);
  }

  function listMembers({ userId, applicationId }) {
    membership({ userId, applicationId, minimumRole: "admin" });
    return db.prepare("SELECT m.user_id,u.email,m.role,m.created_at FROM application_memberships m JOIN owner_users u USING(user_id) WHERE m.application_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.email").all(applicationId);
  }

  function revokeMember({ actorId, applicationId, targetUserId }) {
    membership({ userId: actorId, applicationId, minimumRole: "owner" });
    return tx(db, () => {
      const target = db.prepare("SELECT role FROM application_memberships WHERE application_id=? AND user_id=?").get(applicationId, targetUserId);
      if (!target) throw fail("MEMBER_NOT_FOUND", "Application member was not found");
      if (target.role === "owner") {
        const count = db.prepare("SELECT count(*) AS total FROM application_memberships WHERE application_id=? AND role='owner'").get(applicationId).total;
        if (count <= 1) throw fail("LAST_OWNER", "The application must retain at least one owner");
      }
      db.prepare("DELETE FROM application_memberships WHERE application_id=? AND user_id=?").run(applicationId, targetUserId);
      return { revoked: true, user_id: targetUserId };
    });
  }

  function membership({ userId, applicationId, minimumRole = "member" }) {
    const row = db.prepare("SELECT role FROM application_memberships WHERE user_id=? AND application_id=?").get(userId, applicationId);
    const rank = { member: 1, admin: 2, owner: 3 };
    if (!row || rank[row.role] < rank[minimumRole]) throw fail("APP_ACCESS_DENIED", "Application access is not available");
    return row.role;
  }

  function createPasswordReset({ email }) {
    const targetEmail = emailAddress(email);
    const user = db.prepare("SELECT user_id FROM owner_users WHERE email=? COLLATE NOCASE AND status='active'").get(targetEmail);
    if (!user) return { token: null };
    const token = `shfh_reset_${crypto.randomBytes(32).toString("base64url")}`;
    const now = clock();
    db.prepare("INSERT INTO owner_password_resets(reset_id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(`rst_${crypto.randomUUID()}`, user.user_id, hashToken(token), new Date(now.getTime() + 60 * 60 * 1000).toISOString(), now.toISOString());
    return { token, expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString() };
  }

  async function completePasswordReset({ token, password }) {
    const credentials = await passwordHash(password);
    const now = clock().toISOString();
    return tx(db, () => {
      const reset = db.prepare("SELECT reset_id,user_id FROM owner_password_resets WHERE token_hash=? AND consumed_at IS NULL AND expires_at>? ").get(hashToken(token), now);
      if (!reset) throw fail("RESET_INVALID", "Password reset is invalid or expired");
      db.prepare("UPDATE owner_users SET password_salt=?,password_hash=?,updated_at=? WHERE user_id=?").run(credentials.salt, credentials.hash, now, reset.user_id);
      db.prepare("UPDATE owner_password_resets SET consumed_at=? WHERE reset_id=?").run(now, reset.reset_id);
      db.prepare("UPDATE owner_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now, reset.user_id);
      return { reset: true };
    });
  }

  function logout(req) {
    const token = cookieToken(req);
    if (!token) return false;
    return db.prepare("UPDATE owner_sessions SET revoked_at=? WHERE session_hash=? AND revoked_at IS NULL").run(clock().toISOString(), hashToken(token)).changes > 0;
  }

  return Object.freeze({ createInvite, claimInvite, login, authenticate, listApps, listMembers, revokeMember, membership, createPasswordReset, completePasswordReset, logout });
}
