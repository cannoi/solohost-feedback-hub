import crypto from "node:crypto";

export function createAdminSessionStore({ ttlMs, now = Date.now, createId = () => crypto.randomBytes(24).toString("hex") } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive number");
  const sessions = new Map();
  return Object.freeze({
    create() {
      const sessionId = createId();
      sessions.set(sessionId, now() + ttlMs);
      return sessionId;
    },
    has(sessionId) {
      if (!sessionId || !sessions.has(sessionId)) return false;
      const expiresAt = sessions.get(sessionId);
      if (now() >= expiresAt) {
        sessions.delete(sessionId);
        return false;
      }
      return true;
    },
    delete(sessionId) {
      return sessions.delete(sessionId);
    },
  });
}
