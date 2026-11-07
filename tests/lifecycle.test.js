import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachGracefulShutdown } from "../lib/lifecycle.js";

test("SIGTERM stops workers, drains HTTP server, and closes SQLite exactly once", async () => {
  const processEvents = new EventEmitter();
  const calls = [];
  const server = { close(callback) { calls.push("server.close"); callback(); } };
  const database = { close() { calls.push("database.close"); } };
  const messages = [];
  attachGracefulShutdown({ server, database, stopWorkers: async () => { calls.push("workers.stop"); }, processObject: processEvents, logger: (line) => messages.push(line), errorLogger: (line) => messages.push(line) });
  processEvents.emit("SIGTERM");
  processEvents.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["workers.stop", "server.close", "database.close"]);
  assert.ok(messages.some((line) => line === "graceful shutdown complete"));
});
