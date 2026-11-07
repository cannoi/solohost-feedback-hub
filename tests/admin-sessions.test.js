import test from "node:test";
import assert from "node:assert/strict";
import { createAdminSessionStore } from "../lib/admin-sessions.js";

test("admin sessions expire at the configured deadline and revoked sessions stay invalid", () => {
  let time = 10_000;
  const sessions = createAdminSessionStore({ ttlMs: 1_000, now: () => time, createId: () => "session-one" });
  const sessionId = sessions.create();
  assert.equal(sessions.has(sessionId), true);
  time = 10_999;
  assert.equal(sessions.has(sessionId), true);
  time = 11_000;
  assert.equal(sessions.has(sessionId), false);
  assert.equal(sessions.has(sessionId), false);

  const revokedId = sessions.create();
  assert.equal(sessions.delete(revokedId), true);
  assert.equal(sessions.has(revokedId), false);
});

test("admin session store rejects invalid expiration configuration", () => {
  assert.throws(() => createAdminSessionStore({ ttlMs: 0 }), { name: "TypeError" });
});
