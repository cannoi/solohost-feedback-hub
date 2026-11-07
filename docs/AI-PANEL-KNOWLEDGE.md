# SoloHost Feedback Hub — AI Panel Knowledge

This file is the authoritative, current product manual loaded by `lib/app-adapter.js` for the Universal AI Panel. Update it whenever routes, features, configuration, or operational behavior change. Do not describe unverified behavior as available.

## Product identity
- Name: SoloHost Feedback Hub (SHFH)
- Version in this release: 2.5.1
- Purpose: central feedback, notices, updates, and AI-assisted insights for applications hosted on Pi SoloHost.
- Default Hub ID: `SHFH-CANNOI-0905428801` (public metadata).
- Set the public base URL to the deployment's HTTPS address; no insecure HTTP default is used.
- Default server port: `8090`.
- HTTP health and default client URL: port `8090`. Optional HTTPS via embedded Caddy: port `8443`.
- Hub ID and public base URL are preconfigured; the admin UI does not ask users to enter them.

## Main interfaces
- Public feedback and updates: `/` and `/feedback`.
- Admin: `/admin` (administrator authentication required).
- Application owner: `/owner` (invitation/account and application-scoped access).
- SDK: `/api/sdk.js`.
- API documentation: `docs/API-v1.md`; integration guide: `INTEGRATION.md`.
- AI Panel: one floating robot button with Chat, Feedback, Settings, and Logs tabs.

## AI Panel
- Provider catalog: OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, and Local.
- API keys are configured and stored server-side; responses must mask them. Never ask users to paste secrets into chat.
- Without a configured provider, the panel should use the adapter's offline local guide.
- The assistant must answer in the language used by the user, especially English or Vietnamese.
- AI Insights and notice rewriting use the same Universal AI provider configuration.
- AI output is advisory; do not claim actions were completed unless the host confirms them.

## Feedback, notices, and donation information
- The panel's feedback submission is handled by the local server route `/api/feedback/panel-submit`; it is rate-limited and stores feedback in the Hub.
- The existing authenticated client-ingest route remains `/api/feedback`; do not repurpose it for browser submissions.
- Panel sync uses `/api/feedback/config` and `/api/feedback/sync?anonymous_id=...`.
- Public config contains only non-secret metadata: enabled, hub ID, app ID, app name, and version.
- Marking a notice read uses `/api/feedback/read/:id`; a notice must belong to the Hub app and any targeted anonymous ID must match.
- The unread badge appears only when unread count is greater than zero.
- Donation details are rendered only from `sync.donate`; never hard-code wallet or bank account details in frontend code.

## Credentials and security
- Ingest credentials belong only on the server. Use `SHFH_INGEST_TOKEN` for an outbound Hub credential when needed; do not embed it in source, public config, HTML, or client JavaScript.
- Treat any credential pasted into a chat or public artifact as compromised and rotate it.
- AI provider keys are stored server-side in the app's data directory and must be masked in GET responses.
- Never log secrets, include them in AI prompts, or expose them through `/api/feedback/config`.
- Do not give the model shell, Docker, filesystem, or unrestricted administrative tools.

## User guidance
- Feedback: use the public form or AI Panel Feedback tab; never submit passwords, API keys, tokens, or seed phrases.
- Notices: open the Feedback tab, review notices, and mark each one as read.
- AI setup: open Settings, choose provider, configure key/base URL/model, save, then use Check token or Load models.
- App integration: use the SDK and docs; use unique application credentials and keep them server-side.
- New apps discovered through first-time legacy feedback are marked pending and omitted from the managed app list until an administrator approves them in `/admin`. The limited first feedback is retained for review.
- Strict limits for unapproved apps: one submission per client per hour and five feedback submissions per app per day. New registration is capped at three per IP per day, with at most 100 pending registrations.
- Removing an app from `/admin` disables credentials and hides it from the managed list. Existing feedback and history are retained; this is a reversible-data-preserving removal, not a physical purge.
- To review pending applications, sign in at `/admin`, approve a pending app, or remove it. Only approved apps enter the managed list.
- Deployment: inspect the included Compose and SoloHost configuration files; verify behavior on the target SoloHost version before production release.

## Verification status
The AI Panel knowledge describes intended/current source behavior, not proof of production deployment. Distinguish code presence, automated-test results, browser verification, Docker runtime verification, and Pi Sandbox verification.

## HTTPS gateway (embedded Caddy)
- The Docker image may run an embedded Caddy process that terminates TLS on port `8443` and proxies to the Node backend on port `8090`.
- Default public HTTP service for health checks, CI smoke tests, SoloHost probes, and legacy clients remains `http://HOST:8090`.
- Optional HTTPS URL: `https://HOST:8443` (internal CA by default; browsers may warn until the local CA is trusted).
- Optional HTTP redirect helper: port `8080` → HTTPS on `8443`.
- Environment: `HTTPS_GATEWAY=1|0`, `HTTPS_PORT` (default 8443), `HTTP_PORT` (default 8080), `LISTEN_HOST` (default `0.0.0.0`), `PUBLIC_HOSTNAME`, `CADDY_EMAIL` (optional ACME).
- Certificate data persists under `DATA_DIR/caddy`. Disabling the gateway (`HTTPS_GATEWAY=0`) runs Node only.
- Health payload `GET /api/v1/integration/health` includes `data.https` with gateway status when available.
- Tell users: keep existing SoloHost client base URL on port 8090 unless the operator deliberately switches clients to HTTPS on 8443.
- Do not claim public Let's Encrypt certificates are active unless `PUBLIC_HOSTNAME` and `CADDY_EMAIL` are configured and ACME succeeded.

## Correct public URLs
- App/API over HTTP (always available when container is up): `http://HOST:8090` — example `http://14.176.78.46:8090`.
- Optional HTTPS via Caddy: `https://HOST:8443` — example `https://14.176.78.46:8443` (internal CA; browser may warn).
- Do **not** use `https://HOST:8090` — port 8090 is plain HTTP (Node). Mixing HTTPS scheme with 8090 fails in the browser.
- Port 8080 only redirects to HTTPS on 8443 when the gateway is healthy.

## SoloHost port publishing
- SoloHost publishes ports declared in `config_options.yml`. HTTP uses `HOST_PORT` (default 8090).
- HTTPS uses optional `HTTPS_HOST_PORT` (default 8443) mapped to container port 8443. If this option is missing from an older install, the host will not accept connections to 8443 even when Caddy logs "Caddy running".
- After upgrading, re-apply app config or reinstall so SoloHost regenerates compose with the 8443 mapping, and allow 8443/TCP on the Windows host firewall if needed.
- Browser may show a certificate warning for `tls internal`; that is expected without a public domain and ACME email.

## Notices & updates workspace (admin)
- Admin main dashboard has a combined **Notices & updates** card: scope all apps / single app / publish update.
- **Send now** calls `POST /api/admin/notices/send` which creates, approves, publishes, and mirrors the notice into the client JSON notice store used by the SDK (`GET /api/notices`).
- Publishing an update still uses `POST /api/updates` and also creates a client-visible notice.
- Activity feed: `GET /api/admin/activity?days=7` (default 7, selectable 1–30 on UI) lists recent notices, feedback, and updates.
