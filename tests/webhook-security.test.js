import test from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, normalizeWebhookEndpoint, createWebhookHeaders, verifyWebhookSignature } from "../lib/webhook-security.js";

test("webhook destinations reject private, metadata, link-local, and IPv6 bypass addresses", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(normalizeWebhookEndpoint("http://example.com", { resolve: async () => [{ address: "8.8.8.8", family: 4 }] }), { code: "INVALID_WEBHOOK_URL" });
  await assert.rejects(normalizeWebhookEndpoint("https://localhost/hook", { resolve: async () => [{ address: "127.0.0.1", family: 4 }] }), { code: "INVALID_WEBHOOK_URL" });
  await assert.rejects(normalizeWebhookEndpoint("https://example.com/hook", { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.9", family: 4 }] }), { code: "UNSAFE_WEBHOOK_DESTINATION" });
});

test("webhook signatures bind exact body and event ID and reject stale timestamps", () => {
  const secret = "s".repeat(48), eventId = "evt_0123456789abcdef", rawBody = '{"event":"feedback.created"}', now = 1_800_000_000_000;
  const signed = createWebhookHeaders({ secret, eventId, rawBody, timestamp: Math.floor(now / 1000) });
  assert.equal(verifyWebhookSignature({ secret, eventId, rawBody, signature: signed.signature, now }).eventId, eventId);
  assert.throws(() => verifyWebhookSignature({ secret, eventId, rawBody: "{}", signature: signed.signature, now }), { code: "INVALID_WEBHOOK_SIGNATURE" });
  assert.throws(() => verifyWebhookSignature({ secret, eventId, rawBody, signature: signed.signature, now: now + 301_000 }), { code: "WEBHOOK_TIMESTAMP_EXPIRED" });
});
