import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress } from "../lib/network-address.js";

test("initial setup accepts IPv4 and IPv6 loopback socket addresses", () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, `${address} should be loopback`);
  }
});

test("initial setup rejects non-loopback, malformed, and forwarded-only addresses", () => {
  for (const address of ["192.168.1.10", "10.0.0.1", "172.20.0.2", "203.0.113.4", "::ffff:192.168.1.10", "", "127.invalid"]) {
    assert.equal(isLoopbackAddress(address), false, `${address} should not be loopback`);
  }
});
