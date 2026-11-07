# Feedback Hub API v1

Base path: `/api/v1`  
Content type: `application/json`  
Credentials: `Authorization: Bearer <application-key>` for app APIs. Never put keys in URLs or browser source. Keys are shown once when the platform administrator issues them.

## Registration and administration

### `POST /api/v1/apps/register`

Public registration request. A new app is `pending` and cannot use write credentials before approval.

```json
{
  "app_id": "personal-ai-hub",
  "app_name": "Personal AI Hub",
  "description": "SoloHost application",
  "application_url": "http://personal-ai-hub:8080",
  "backend_api_url": "http://personal-ai-hub:8080/api"
}
```

Success: `202 Accepted`, `{ "ok": true, "data": { "application_id": "personal-ai-hub", "integration_status": "pending", ... } }`.

Registration is limited to three requests per IP per day. The platform caps the pending approval queue at 100 applications. An app discovered through the legacy first-feedback endpoint also stays pending and outside the managed app list until an administrator approves it; pending apps may submit at most one feedback item per client per hour and five items per app per day.

### Platform administrator routes

These routes require the existing Feedback Hub admin login session cookie.

- `GET /api/v1/apps` — list registered apps.
- `POST /api/v1/apps/:appId/approve` — approve a pending app.
- `DELETE /api/v1/apps/:appId` — disable and remove an app from the managed list. Existing feedback and history are retained.
- `POST /api/v1/apps/:appId/credentials` — issue a scoped credential. Supported scopes: `feedback:write`, `feedback:read`, `feedback:manage`, `notifications:write`, `notifications:read`, `fees:create`, `fees:read`, `fees:simulate`, `payments:create`, `payments:read`, `apps:read`.
- `POST /api/v1/credentials/:credentialId/revoke` — revoke a credential.

Credential response includes a one-time `secret`; the database stores only its SHA-256 hash. Create another credential before revoking an old one when rotating without downtime.

## Health

### `GET /api/v1/integration/health`

Unauthenticated readiness check. Returns API version and database readiness without exposing filesystem paths, credentials, or external-service details.

## Feedback

Allowed categories: `bug`, `feature_request`, `question`, `complaint`, `suggestion`, `general`. Rating is optional; when supplied it must be an integer from 1 to 5. Title is limited to 160 characters and message to 4,000 characters.

### `POST /api/v1/feedback`

Requires `feedback:write`. The tenant comes from the credential; a body `app_id` cannot select a different tenant.

```json
{
  "category": "bug",
  "title": "AI response was empty",
  "message": "The provider returned an empty response.",
  "rating": 2,
  "anonymous": true
}
```

Success: `201 Created` with the generated feedback `id`, server-selected `application_id`, status, and timestamps. Set `anonymous:false`, provide a valid `contact_email`, and set `follow_up:true` to receive a one-time plaintext `follow_up_token` and `follow_up_url` (`/feedback/track`). Store/deliver that token securely; only its SHA-256 hash is stored by the Hub and it expires in 30 days. Identical normalized messages for one app in the recent 10-minute window return `409 DUPLICATE_FEEDBACK`.

Customer tracking routes use `Authorization: Bearer <follow-up-token>` rather than an app credential:

- `GET /api/v1/customer/feedback` resolves the one feedback record bound to that token.
- `GET /api/v1/customer/feedback/:id` and `/messages` return customer-visible history only; private notes are filtered server-side.
- `POST /api/v1/customer/feedback/:id/messages` posts a customer reply.
- `GET /api/v1/customer/feedback/:id/attachments/:attachmentId` downloads a submission attachment.
- `DELETE /api/v1/customer/feedback/:id` permanently removes the customer's feedback, messages, token, and attachment metadata/files, and writes an audit event.

The browser page `/feedback/track` accepts the token in the form and keeps it out of the URL. Feedback attachments use the app credential routes `POST /api/v1/feedback/:id/attachments?filename=...` with raw PNG/JPEG/WebP/PDF bytes (max 5 MiB), and `GET /api/v1/feedback/:id/attachments/:attachmentId`; uploads are signature checked, stored under generated names, and downloaded as attachments with `nosniff`.

### `GET /api/v1/feedback?page=1&limit=25&status=new&category=bug`

Requires `feedback:read`; always lists only the credential's app. `limit` is clamped to 1–100. Response includes `data.items` and `meta` (`page`, `limit`, `total`, `pages`). Supported statuses: `new`, `pending`, `in_progress`, `resolved`, `closed`.

### `GET /api/v1/feedback/:id`

Requires `feedback:read`. Returns `404 FEEDBACK_NOT_FOUND` if the ID is absent or belongs to another app.

### Feedback management and conversation

- `PATCH /api/v1/feedback/:id` requires `feedback:manage`; accepts `status` (`new`, `pending`, `in_progress`, `resolved`, `closed`) and/or `priority` (`P1`, `P2`, `P3`).
- `GET /api/v1/feedback/:id/messages` requires `feedback:read`; returns public conversation messages for that tenant.
- `POST /api/v1/feedback/:id/messages` requires `feedback:manage`; body `{ "body": "We are investigating" }` creates a public application reply. Private notes remain limited to the existing admin workflow and are never returned from this API.

### Notifications

- `POST /api/v1/notifications` requires `notifications:write`; body includes `title`, `body`, optional `type` (`update`, `release`, `maintenance`, `security`, `payment`, `order`, `feedback`, `announcement`), optional `locale`, `scheduled_at`, and `expires_at`.
- `GET /api/v1/notifications` requires `notifications:read`; returns this application's due and unexpired notices only.

Notifications use a durable SQLite-backed worker and per-recipient delivery rows. `GET /api/v1/notifications` can accept `recipient_id` and `unread=true`; `POST /api/v1/notifications/:id/read` accepts `{ "recipient_id": "app-local-user-id" }` and records read state inside the caller's tenant. The app backend must derive that ID from its own authenticated session. Owner APIs can schedule notices; `POST /api/v1/notifications/:id/cancel` and `/retry` manage them. Notification templates can be listed/updated through owner routes `GET|PUT /api/v1/owner/apps/:appId/notifications/templates`; sending can include `template_key`, `locale`, and scalar `variables`. Email and Telegram adapters are injectable; default deployment does not configure external providers, so those channels enter bounded retry and then failed state. In-app delivery and read tracking are local to the tenant.

## Fee/order ledger

The provider-neutral ledger uses integer `amount_subunits` plus `amount_scale` (for example `1250` and `2` means `12.50`), an ISO-style currency code, and a provider identifier. All routes require an app credential; the credential-bound application is the only tenant considered.

- `POST /api/v1/fees/orders` requires `fees:create`; body: `idempotency_key`, positive integer `amount_subunits`, `amount_scale` from 0–7, `currency`, optional `provider` (defaults to `mock`), `order_reference`, `description`, and object `metadata`. Identical idempotency replays return the original order; key reuse with changed order data returns `409 IDEMPOTENCY_CONFLICT`.
- `GET /api/v1/fees/orders` and `GET /api/v1/fees/orders/:orderId` require `fees:read`. Reads are tenant-scoped; the order response includes `service_delivery_allowed`, true only after a matching, verified provider result is reconciled as paid.
- `GET /api/v1/fees/orders/:orderId/history` requires `fees:read` and returns append-only audit entries. Provider references are unique per app/provider; duplicate external provider event IDs cannot be rebound to different data.
- `POST /api/v1/fees/orders/:orderId/settle-mock` requires `fees:simulate` and is available only when the server operator explicitly sets `FEE_MOCK_PAYMENTS=true`. It simulates a server-confirmed result for development and acceptance tests; it is not a production payment provider.

Provider adapters must call the ledger's server-side event recording interface only after authenticating the provider result; client-supplied success callbacks are not authoritative. The reconciliation worker validates provider, currency, amount/scale, verification, terminal status, and provider-reference uniqueness before allowing delivery. Order creation and confirmation enqueue `payment.created`, `payment.completed`, or `payment.failed` app webhooks transactionally. Provider-specific authentication and Pi payment bridging are separate from this ledger.

## Webhooks

With `HUB_ENCRYPTION_KEY` configured, use app credentials with `webhooks:manage` or `webhooks:read`:

- `POST /api/v1/webhooks/register` body `{ "endpoint": "https://…", "events": ["feedback.created", "payment.completed"] }`; returns the secret once.
- `GET /api/v1/webhooks` lists app endpoints and active state without the secret.
- `POST /api/v1/webhooks/:webhookId/rotate` returns a replacement secret once; `/disable` revokes delivery.
- `GET /api/v1/webhooks/deliveries` shows attempts/status; `POST /api/v1/webhooks/deliveries/:deliveryId/retry` queues a failed event again.

Webhook delivery verifies HTTPS host DNS answers, pins the selected public IP at connection time, rejects redirects, and applies time/response limits. Payloads are signed over the exact serialized raw body using `HMAC-SHA256(secret, timestamp + "." + event_id + "." + raw_body)`. Headers are `X-SHFH-Event-Id`, `X-SHFH-Timestamp`, and `X-SHFH-Signature: t=<timestamp>,v1=<hex>`. Receivers must verify timestamp freshness (300 seconds), compare signatures in constant time, and persist event IDs to reject duplicates. Delivery is at-least-once with bounded exponential retries; consumers must be idempotent.

## Pi payment integration boundary

`POST /api/v1/payments/create` requires `payments:create`; body includes `amount` (Pi, at most 7 decimals), `memo`, `idempotency_key`, and optional `order_reference`, object `metadata`, and `fee_order_id`. A linked fee order must belong to this app, use provider `pi`, currency `PI`, scale 7, match the exact amount, and not already be bound to another payment session. The response adds `metadata.hub_session_id` (and the server-set `fee_order_id` when linked) and safe app/network readiness without exposing secrets. Reusing a key with identical data returns the existing session; different data returns `409 IDEMPOTENCY_CONFLICT`.

- `POST /api/v1/payments/:sessionId/approve` requires `payments:create`; body `{ "payment_id": "…", "user_access_token": "…" }`. The app token selects the tenant; Hub verifies the Pi user token and payment through the configured per-app Platform API key. User access tokens are never persisted.
- `POST /api/v1/payments/:sessionId/complete` requires `payments:create`; body `{ "payment_id": "…", "txid": "…" }`. The Hub refetches authoritative Pi state and completes only the exact verified transaction.
- `GET /api/v1/payments/:sessionId` requires `payments:read`; it returns tenant-scoped Hub state, safe transaction identifiers, verification state, optional linked `fee_order_id`, and `service_delivery_allowed`.
- Owner endpoints `GET|PUT /api/v1/owner/apps/:appId/pi-config` configure (PUT only) an app's Pi Developer App ID, network, and server API key. PUT is CSRF protected and requires app admin membership. The response never includes the server key.

States distinguish `created`, `approving`, `approved`, `completion_pending`, `completed`, and `failed`. `approved` does not mean blockchain verified. `completed` and `verification_state: verified` are written only after authoritative Pi confirmation. A linked Pi fee order is reconciled from that same server-confirmed completion; service delivery must additionally require its fee-order state to be `paid` and `verified`. Mock tests do not verify the real Sandbox. See [Pi integration](PI-INTEGRATION.md) and [Pi's official payment guide](https://developers.minepi.com/docs/accept-payment/Payments).
## Response formats

Success:

```json
{ "ok": true, "data": {}, "request_id": "..." }
```

Failure:

```json
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "category is not supported", "details": { "field": "category" } },
  "request_id": "..."
}
```

Relevant status codes: `400` validation/JSON errors, `401` missing or invalid credential/admin session, `403` missing scope, `404` missing or cross-tenant record, `409` duplicate or invalid app state, `413` body over 160 KiB, `415` non-JSON body, `429` rate limit, `500` generic internal error. Responses include `X-Request-Id` and `Cache-Control: no-store`.

## Example SoloHost backend

```js
const response = await fetch(`${FEEDBACK_HUB_URL}/api/v1/feedback`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.FEEDBACK_HUB_APP_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    category: "question",
    title: "Need help with setup",
    message: "The provider configuration page is unclear.",
    anonymous: false,
    contact_email: "customer@example.com"
  })
});
const result = await response.json();
if (!response.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
```

The routes above describe the current implemented surface. Routes not listed here (including cross-application identity, generic OAuth authorization, or browser-side use of application secrets) are not implied and must not be assumed. See `docs/reports/FINAL-IMPLEMENTATION-REPORT.md` for verified limits and incomplete provider integrations.
