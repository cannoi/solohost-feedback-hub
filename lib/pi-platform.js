const PLATFORM_BASE = "https://api.minepi.com/v2";

function paymentId(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw Object.assign(new Error("Payment identifier is invalid"), { code: "INVALID_PAYMENT_ID" });
  return text;
}

function txid(value) {
  const text = String(value || "");
  if (!/^[a-fA-F0-9]{16,128}$/.test(text)) throw Object.assign(new Error("Transaction identifier is invalid"), { code: "INVALID_TXID" });
  return text;
}

export function createPiPlatformClient({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof apiKey !== "string" || apiKey.length < 1) throw new TypeError("A server-side Pi API key is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  async function request(path, { method = "GET", body, userToken } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${PLATFORM_BASE}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: userToken ? `Bearer ${userToken}` : `Key ${apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw Object.assign(new Error("Pi Platform request failed"), { code: "PI_PLATFORM_ERROR", status: response.status });
      return data;
    } catch (error) {
      if (error?.code) throw error;
      throw Object.assign(new Error("Pi Platform is temporarily unavailable"), { code: error?.name === "AbortError" ? "PI_PLATFORM_TIMEOUT" : "PI_PLATFORM_UNAVAILABLE" });
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({
    async getPayment(id) { return request(`/payments/${encodeURIComponent(paymentId(id))}`); },
    async approvePayment(id) { return request(`/payments/${encodeURIComponent(paymentId(id))}/approve`, { method: "POST" }); },
    async completePayment(id, chainTxid) { return request(`/payments/${encodeURIComponent(paymentId(id))}/complete`, { method: "POST", body: { txid: txid(chainTxid) } }); },
    async verifyUser(accessToken) {
      if (typeof accessToken !== "string" || accessToken.length < 1 || accessToken.length > 4096) throw Object.assign(new Error("Pi user access token is invalid"), { code: "INVALID_USER_TOKEN" });
      return request("/me", { userToken: accessToken });
    },
  });
}
