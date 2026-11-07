import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

function fault(code, message) { return Object.assign(new Error(message), { code }); }

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family !== 6) return false;
  const value = address.toLowerCase();
  if (value.includes("%") || value.startsWith("::ffff:") || value.startsWith("2001:db8:") || value === "2001:db8::" || value.startsWith("2001:0000:") || value.startsWith("2001:0:") || value.startsWith("2001:0002:") || value.startsWith("2001:2:") || value.startsWith("2001:0010:") || value.startsWith("2001:10:") || value.startsWith("2001:0020:") || value.startsWith("2001:20:") || value.startsWith("2002:")) return false;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff;
}

function defaultResolve(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export async function normalizeWebhookEndpoint(input, { resolve = defaultResolve, dnsTimeoutMs = 3000 } = {}) {
  let url;
  try { url = new URL(String(input)); } catch { throw fault("INVALID_WEBHOOK_URL", "Webhook URL must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" || net.isIP(url.hostname) || url.hostname.endsWith(".") || url.hostname.length > 253 || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) throw fault("INVALID_WEBHOOK_URL", "Webhook URL must use HTTPS on a public DNS hostname without credentials or fragments");
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      resolve(url.hostname),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fault("WEBHOOK_DNS_TIMEOUT", "Webhook DNS resolution timed out")), dnsTimeoutMs); }),
    ]);
  } catch (error) {
    if (error?.code === "WEBHOOK_DNS_TIMEOUT") throw error;
    throw fault("WEBHOOK_DNS_FAILED", "Webhook hostname could not be resolved");
  } finally { clearTimeout(timer); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 16 || answers.some((answer) => !answer || !isPublicAddress(answer.address) || Number(answer.family) !== net.isIP(answer.address))) throw fault("UNSAFE_WEBHOOK_DESTINATION", "Webhook hostname must resolve only to globally routable addresses");
  return { url, addresses: answers.map((answer) => ({ address: answer.address, family: Number(answer.family) })) };
}

export function createWebhookHeaders({ secret, eventId, rawBody, timestamp = Math.floor(Date.now() / 1000) }) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || !/^evt_[A-Za-z0-9_-]{12,80}$/.test(eventId) || typeof rawBody !== "string" || !Number.isSafeInteger(timestamp)) throw fault("INVALID_WEBHOOK_SIGNATURE_INPUT", "Webhook signing input is invalid");
  const digest = crypto.createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`, "utf8").digest("hex");
  return { timestamp: String(timestamp), signature: `t=${timestamp},v1=${digest}`, eventId };
}

export function verifyWebhookSignature({ secret, eventId, rawBody, signature, now = Date.now(), toleranceSeconds = 300 }) {
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(String(signature || ""));
  if (!match || !/^evt_[A-Za-z0-9_-]{12,80}$/.test(String(eventId || ""))) throw fault("INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid");
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) throw fault("WEBHOOK_TIMESTAMP_EXPIRED", "Webhook timestamp is outside the permitted window");
  const expected = createWebhookHeaders({ secret, eventId, rawBody, timestamp }).signature.split("v1=")[1];
  const actualBytes = Buffer.from(match[2], "hex"), expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) throw fault("INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid");
  return { eventId, timestamp };
}

function sendPinned({ url, addresses, headers, body, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const selected = addresses[crypto.randomInt(addresses.length)];
    const request = https.request({
      protocol: "https:", hostname: url.hostname, port: 443, method: "POST", path: `${url.pathname}${url.search}`,
      servername: url.hostname, agent: false, rejectUnauthorized: true,
      lookup(_hostname, _options, callback) { callback(null, selected.address, selected.family); },
      headers: { ...headers, Host: url.host, "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) request.destroy(fault("WEBHOOK_RESPONSE_TOO_LARGE", "Webhook response exceeded limit"));
      });
      response.on("end", () => resolve({ statusCode: response.statusCode || 0 }));
      response.on("error", () => reject(fault("WEBHOOK_RESPONSE_FAILED", "Webhook response failed")));
    });
    request.setTimeout(timeoutMs, () => request.destroy(fault("WEBHOOK_TIMEOUT", "Webhook request timed out")));
    request.on("error", (error) => reject(error?.code ? error : fault("WEBHOOK_REQUEST_FAILED", "Webhook request failed")));
    request.end(body);
  });
}

export async function postWebhook({ endpoint, event, secret, resolve, requestImpl = sendPinned, timeoutMs = 5000, dnsTimeoutMs = 3000, maxResponseBytes = 32 * 1024, clock = () => Date.now() }) {
  const { url, addresses } = await normalizeWebhookEndpoint(endpoint, { resolve, dnsTimeoutMs });
  const rawBody = JSON.stringify(event);
  if (Buffer.byteLength(rawBody) > 256 * 1024) throw fault("WEBHOOK_PAYLOAD_TOO_LARGE", "Webhook payload exceeded limit");
  const signed = createWebhookHeaders({ secret, eventId: event.id, rawBody, timestamp: Math.floor(clock() / 1000) });
  const response = await requestImpl({ url, addresses, body: rawBody, timeoutMs, maxResponseBytes, headers: {
    "Content-Type": "application/json", "User-Agent": "SoloHost-Feedback-Hub/2", "X-SHFH-Event-Id": signed.eventId,
    "X-SHFH-Timestamp": signed.timestamp, "X-SHFH-Signature": signed.signature,
  } });
  if (response.statusCode >= 300 && response.statusCode < 400) throw Object.assign(fault("WEBHOOK_REDIRECT_BLOCKED", "Webhook redirects are not followed"), { statusCode: response.statusCode });
  if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(fault("WEBHOOK_HTTP_STATUS", "Webhook endpoint returned a non-success status"), { statusCode: response.statusCode });
  return { statusCode: response.statusCode };
}
