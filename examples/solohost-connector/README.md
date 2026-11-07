# SoloHost connector sample

This runnable Node 24 sample demonstrates server-to-server feedback and notification calls, tenant-safe app credential storage, the Pi Browser payment handoff, and a persistent signed-webhook receiver with event deduplication.

## Connect it

1. Start Feedback Hub and set its operator-managed `HUB_ENCRYPTION_KEY`.
2. Register the sample application with `POST /api/v1/apps/register`, have a platform admin approve it, and issue an app credential with `feedback:write`, `notifications:read`, `payments:create`, and `payments:read` scopes. Add `fees:create` and `fees:read` if using the independent fee/order ledger; grant `fees:simulate` only for local mock acceptance tests.
3. Add an application owner and configure the sample app's Pi Developer App ID, Pi network, and Pi Server API key in the owner dashboard. These must all identify the same Pi app.
4. Configure a webhook at the sample's public HTTPS endpoint `/webhooks/feedback-hub`, subscribe to `payment.completed`, `feedback.created`, and other events you need, and store the secret shown once.
5. Set environment variables below in a private `.env` file or the SoloHost secret configuration. Never use a browser variable for either key.

```dotenv
PORT=8080
DATA_DIR=./data
FEEDBACK_HUB_URL=https://feedback.example.com
FEEDBACK_HUB_APP_KEY=shfh_live_replace_with_issued_credential
FEEDBACK_HUB_WEBHOOK_SECRET=shfh_whsec_replace_with_one_time_secret
ORDER_AMOUNT_PI=1
```

Start with `node --env-file=.env server.mjs`. `GET /health` reports local storage and whether Hub settings are present. The sample stores its order-to-session/payment mapping and received webhook IDs in `DATA_DIR/connector.sqlite`, so event deduplication and payment lookup survive process restarts.

The included page at `/` provides a feedback submission and Pi SDK payment flow. Pi's official SDK is loaded from `https://sdk.minepi.com/pi-sdk.js` because Pi requires that SDK in Pi-enabled clients. The sample sets `sandbox: true`; only use it with the registered development URL and Developer App Sandbox. It is not a general production storefront.

## Routes

- `POST /feedback`: forwards validated customer feedback using the server-side Hub credential.
- `GET /notifications?recipient_id=...`: reads only the application's tenant and requested recipient's due notifications.
- `POST /payments/session`: creates an idempotent order-linked Hub payment session.
- `POST /payments/:sessionId/approve`: validates the payment through Feedback Hub using the app credential.
- `POST /payments/:sessionId/complete`: completes only after Hub/Pi authoritative validation.
- `POST /payments/incomplete`: resolves an interrupted payment using the saved order/session mapping.
- `POST /webhooks/feedback-hub`: verifies HMAC-SHA256, five-minute timestamp tolerance, and deduplicates event IDs in SQLite.

The Hub signs the exact raw JSON as `HMAC_SHA256(secret, timestamp + "." + event_id + "." + raw_body)` and sends `X-SHFH-Event-Id`, `X-SHFH-Timestamp`, and `X-SHFH-Signature: t=<timestamp>,v1=<hex>`. Keep your receiver behind HTTPS. The sample is intentionally small; before commercial use, add your application's session authentication, CSRF protection for browser mutations, order authorization, abuse controls, and business-specific event processing. Do not treat any browser callback or unverified session state as a paid order.

## SoloHost container notes

Mount a persistent writable directory at `/app/data`, set `DATA_DIR=/app/data`, and expose only the configured application port. No Docker socket, privileged mode, host networking, or host filesystem access is needed. Ensure Hub can reach the sample's HTTPS webhook endpoint and the sample can resolve/reach Hub's backend API from its network; a browser URL such as `http://personal-ai-hub:8080` is not necessarily routable from the Hub container.
