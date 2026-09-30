/**
 * SoloHost Feedback Hub client SDK v2
 * Drop into any app:
 *   <script src="FEEDBACK_HUB_URL/api/sdk.js"></script>
 *   const hub = SHFH.create({ hubUrl, ingestToken, appId, appName, version });
 *   hub.sendFeedback({ type:'bug', message:'...' });
 *   hub.reportPayment({ txn_id, method:'pi' });
 *   const notices = await hub.pullNotices();
 */
(function (root) {
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function anonKey(appId) { return "shfh_anon_" + (appId || "default"); }

  function create(opts) {
    const hubUrl = String(opts.hubUrl || "").replace(/\/$/, "");
    const ingestToken = opts.ingestToken || "";
    const appId = opts.appId;
    const appName = opts.appName || opts.appId;
    const version = opts.version || "";
    const platform = opts.platform || "solohost";
    if (!hubUrl || !appId) throw new Error("SHFH: hubUrl and appId required");
    let anonymousId = localStorage.getItem(anonKey(appId)) || uuid();
    localStorage.setItem(anonKey(appId), anonymousId);

    async function post(path, body) {
      const headers = { "Content-Type": "application/json" };
      if (ingestToken) headers.Authorization = "Bearer " + ingestToken;
      const r = await fetch(hubUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    }
    async function get(path) {
      const r = await fetch(hubUrl + path);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    }

    return {
      anonymousId,
      async config() { return get("/api/config"); },
      async sendFeedback({ type = "improvement", message, rating = 0, locale = "vi", license } = {}) {
        return post("/api/feedback", {
          schema_version: "2.0",
          event: "feedback",
          app_id: appId,
          app_name: appName,
          version,
          platform,
          type,
          rating,
          message,
          anonymous_id: anonymousId,
          license: license || { paid: false, plan: "free" },
          locale,
        });
      },
      async reportPayment({ txn_id, method = "pi", amount = "", locale = "vi" } = {}) {
        return post("/api/feedback", {
          schema_version: "2.0",
          event: "payment",
          app_id: appId,
          app_name: appName,
          version,
          platform,
          type: "payment",
          message: "payment:" + method + " " + (txn_id || ""),
          anonymous_id: anonymousId,
          license: { paid: true, plan: "supporter", txn_id, method, amount },
          locale,
        });
      },
      async pullNotices() {
        const q = new URLSearchParams({ app_id: appId, anonymous_id: anonymousId });
        return get("/api/notices?" + q.toString());
      },
      async markRead(id) {
        return post("/api/notices/" + encodeURIComponent(id) + "/read", {});
      },
      async updates() {
        return get("/api/updates?app_id=" + encodeURIComponent(appId));
      },
    };
  }

  root.SHFH = { create, SCHEMA: "2.0" };
})(typeof window !== "undefined" ? window : globalThis);
