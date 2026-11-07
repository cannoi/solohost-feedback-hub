import test from "node:test";
import assert from "node:assert/strict";
import { createPiPlatformClient } from "../lib/pi-platform.js";

test("Pi Platform adapter uses official API paths and keeps server key in authorization header", async () => {
  const calls = [];
  const client = createPiPlatformClient({ apiKey: "sandbox-server-key", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } });
  await client.getPayment("payment_123");
  await client.approvePayment("payment_123");
  await client.completePayment("payment_123", "a".repeat(64));
  assert.equal(calls[0].url, "https://api.minepi.com/v2/payments/payment_123");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[2].url.endsWith("/complete"), true);
  assert.deepEqual(JSON.parse(calls[2].options.body), { txid: "a".repeat(64) });
  assert.equal(calls[0].options.headers.Authorization, "Key sandbox-server-key");
});

test("Pi Platform adapter validates identifiers and hides Platform response bodies on errors", async () => {
  const client = createPiPlatformClient({ apiKey: "secret", fetchImpl: async () => new Response("private error detail", { status: 500 }) });
  await assert.rejects(client.getPayment("../me"), { code: "INVALID_PAYMENT_ID" });
  await assert.rejects(client.approvePayment("ok"), (error) => error.code === "PI_PLATFORM_ERROR" && !error.message.includes("private error"));
});
