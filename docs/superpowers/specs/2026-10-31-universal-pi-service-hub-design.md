# Universal Pi Application Service Hub — Design

Date: 2026-10-31  
Status: Draft for owner approval  
Selected direction: SQLite-backed Node modular monolith with a legacy compatibility layer

## Intent

Evolve the existing self-hosted SoloHost Feedback Hub into a shared service that independent Pi Web3, Pi Browser, SoloHost, Docker, and web applications can integrate for feedback, customer notifications, verified Pi payment workflows, and signed webhooks. Each connected application keeps its own frontend, backend, identity, business rules, and customers. Feedback Hub provides common infrastructure and tenant-scoped APIs without merging customer data across apps.

The work is incremental. Existing public feedback routes, legacy client SDK behavior, admin login, app/feedback/update/notice content, and Docker deployment remain usable while versioned APIs and new modules are added.

## Goals

- Add durable, transactional, migration-managed persistence suited to a lightweight single-host deployment.
- Register apps independently and authenticate API requests with revocable per-app credentials, scopes, rate limits, and origin restrictions.
- Provide versioned feedback, notification, integration health, payment-session, and webhook APIs with consistent errors and pagination.
- Give app owners an app-scoped management experience and retain a controlled platform administrator role.
- Record feedback conversations, private notes, notification delivery state, payment lifecycle, webhook attempts, request activity, and security audit events.
- Integrate Pi U2A payments only through the official Pi SDK in a supported frontend and the official Pi Platform API on the server.
- Ship migration, API documentation, SoloHost integration samples, Docker deployment guidance, and automated coverage for critical boundaries.

## Non-goals and anti-goals

- Do not store private keys, seed phrases, or passphrases; do not custody user funds or act as a wallet.
- Do not call a frontend callback, transaction hash, old donation receipt, or client-supplied status proof of settlement.
- Do not claim that arbitrary external Pi applications can use one Hub Pi API key. Payment authorization must use credentials and app identity valid for the Pi application that created the payment.
- Do not implement undocumented Pi endpoints, promise refunds/payouts unless official Platform capabilities and permissions support them, or run real Pi transactions in tests.
- Do not split the app into microservices or remove existing AI, feedback, notice, donation, or update functionality.
- Do not make email, Telegram, OAuth identity providers, or paid services mandatory for self-hosting.

## Existing system and constraints

The source is a Node.js 20 ES module application using native `http`, JSON files (`apps`, `feedback`, `updates`, `notices`, `payments`), an admin password session, and no declared runtime dependencies. Existing routes are unversioned and live in `server.js`. The app includes a public feedback page, admin dashboard, client SDK, AI tools, update notices, and Docker Compose. Existing tests pass 78 checks, but do not exercise HTTP auth isolation, payment verification, webhook retries, or tenant boundaries. The workspace has no Git metadata; a full local baseline archive and audit report have been made.

The SQLite implementation must fit the current Node and SoloHost Docker model. Migrations must be repeatable and must preserve JSON data and existing identifiers. The existing general-purpose settings file contains unrelated AI and admin settings; new app/payment secrets must not be exposed through it or public config endpoints.

## Approaches considered

1. **Keep JSON files and incrementally add features.** Lowest initial effort and minimal deployment changes, but concurrent writes can lose updates, and file arrays cannot provide reliable transactions, foreign keys, idempotency constraints, or durable job claims. Rejected as the platform foundation.
2. **SQLite in the existing modular monolith with a compatibility/migration layer.** Selected. It retains one service/container and local deployment while adding transactions, indexes, constraints, and atomic state transitions. It requires a database dependency, migration tooling, and a one-time import path.
3. **External relational database or separate services.** Offers multi-node growth but adds operational services and network failure modes that conflict with the lightweight self-hosted goal. Not selected unless future scale requires it.

## Architecture

Keep one Node service and separate internal modules for identity/app registry, feedback, notifications, payments, webhooks, audit/health, and legacy routes. Route handlers validate and authorize requests, call module services, and serialize stable JSON responses. Modules own state transitions and persistence rather than mutating collection arrays.

Add a SQLite database file under the persistent data mount (for example `data/feedback-hub.sqlite`) with versioned SQL migrations. Use one database connection for the process, foreign keys enabled, bounded busy timeout, WAL where supported, explicit transactions for writes spanning records, and indexes aligned to tenant filters. The chosen SQLite driver and Node base image will be confirmed against current SoloHost architecture and Docker build constraints during implementation. No required remote database.

The legacy API remains available. Existing JSON files are imported once with a migration marker; original files are retained as backup until the operator removes them. Legacy payment rows are preserved with a clear legacy/unverified classification and are excluded from verified Pi revenue statistics. During migration, updates to legacy routes write to SQLite after import; no dual-write window is allowed unless a tested reconciliation design proves it safe.

### Initial data model

- `users`: local dashboard identities, password hashes, role, status, timestamps.
- `applications`: stable app ID, owner, profile, approved status, allowed origins, feature flags, rate policy, timestamps.
- `application_members`: user-to-app role mapping if multiple owners/staff are enabled.
- `api_credentials`: app, credential ID, secret hash, scopes, created/last-used/expiry/revocation timestamps. Store only one-time displayed random secrets as hashes; allow multiple active keys for rotation.
- `feedback`: tenant app, legacy/client external ID, category, title/message, rating, severity/priority/status, contact/anonymous fields, spam/duplicate flags, created/updated timestamps.
- `feedback_messages`: feedback, author type/user, public reply or private note, text, timestamps.
- `attachments`: feedback, safe generated storage key, original filename metadata, MIME/size/hash, scan/status metadata. Keep uploads outside executable/public paths.
- `notifications`: tenant app, type/template/locale, target/group, scheduled/expiry timestamps, state, content.
- `notification_recipients` and `notification_deliveries`: app-scoped recipient/read status and optional channel state/retry diagnostics.
- `payment_sessions`: app, local order/invoice reference, idempotency key, Pi environment, amount, currency/unit, memo/metadata, app user reference, expected state, expiry.
- `payment_transactions`: payment session, Pi payment ID, txid, authorization/chain/server-verification/completion state, timestamps, sanitized result/failure classification. Uniqueness constraints on idempotency key and provider payment ID/transaction identifiers where applicable.
- `webhook_subscriptions`: app, endpoint, encrypted secret, enabled event types, status, rotation metadata.
- `webhook_events` and `webhook_attempts`: immutable event ID/payload snapshot, tenant, delivery state, attempt schedule/result, response code, retry-after and timestamps.
- `api_request_logs`, `audit_records`, and `schema_migrations`: bounded operational records with retention and secret redaction.

All tenant-owned tables include `application_id`; queries enforce it in service methods and tests. Database FKs and unique indexes supplement, but do not replace, authorization checks.

## Identity, application registration, and API security

- Preserve the existing platform-admin password login and add explicit role checks. App owner dashboard users have app membership and cannot query cross-tenant records.
- Registration is public only as an application request. A new app starts pending/disabled; platform admin approval is required before credentials enable writes. This prevents open app-ID creation and abusive resource use.
- Platform admins can create/disable apps, grant app owners, and issue scoped credentials. App owners can manage their own app, rotate/revoke its keys, choose allowed features, register webhooks, and view only its data. Credential secrets appear once; only salted/secure hashes are persisted. Pi Platform server keys are separately encrypted at rest using an environment-provided master key, never returned from APIs, and omitted from logs/backups where possible.
- API credentials have independent IDs and scopes such as `feedback:write`, `feedback:read`, `notifications:write`, `notifications:read`, `payments:create`, `payments:read`, and `webhooks:manage`. Administrative dashboard sessions are distinct from app API credentials.
- HMAC request signatures are an optional stronger mode for server-to-server calls; enforce timestamp tolerance and nonce/replay storage. Bearer credentials are supported for SoloHost compatibility over HTTPS. Do not put secrets in URLs.
- Enforce per-app and per-IP rate limits, maximum body sizes, strict validation, origin allowlists for browser-facing endpoints, safe CORS preflight behavior, CSRF protections on cookie-authenticated writes, secure session cookies on HTTPS, and constant-time secret comparisons.
- Validate webhook destinations against SSRF: HTTPS by default, reject loopback/private/link-local/reserved IP ranges after DNS resolution and on redirects, restrict ports, revalidate at delivery, and cap response size/time. Do not follow redirects to an unvalidated host.
- Keep error details useful but redact tokens, contact information, and Pi identifiers where not necessary. Add retention controls and app-scoped export/deletion workflows.

## API contract

Add `/api/v1` while preserving existing routes. Standard success response: `{ "ok": true, "data": ..., "meta": ... }`; error response: `{ "ok": false, "error": { "code": "...", "message": "...", "details": ... }, "request_id": "..." }`. Use conventional HTTP status codes, bounded cursor or page pagination, consistent validation errors, and explicit API version documentation.

Initial surface:

- `POST /api/v1/apps/register` — submit a pending registration request.
- `GET /api/v1/apps` — list authorized apps (admin cross-app, owner membership only).
- `GET/PATCH /api/v1/apps/:appId` — read/update authorized app config.
- `POST /api/v1/apps/:appId/credentials`, `POST /api/v1/credentials/:credentialId/revoke` — issue/rotate/revoke scoped keys.
- `GET /api/v1/integration/health` and `GET /api/v1/apps/:appId/integration` — service/app-scoped health.
- `POST /api/v1/feedback`, `GET /api/v1/feedback`, `GET/PATCH /api/v1/feedback/:id`, `POST /api/v1/feedback/:id/replies` — ingest and manage tenant feedback.
- `POST/GET /api/v1/notifications`, `GET /api/v1/notifications/:id`, `POST /api/v1/notifications/:id/read` — create and access app-scoped notifications.
- `POST /api/v1/payments/create`, `GET /api/v1/payments/:id`, plus server-only approval/completion callback endpoints bound to an existing session.
- `POST/GET /api/v1/webhooks/register`, `GET /api/v1/webhooks/:id/deliveries`, `POST /api/v1/webhooks/:id/retry` — subscription, logs, controlled retry.
- `GET /api/v1/analytics` and admin dashboard endpoints with the same tenant enforcement.

The API reference will include scopes, request/response examples, status/error codes, idempotency semantics, limits, and credential setup. OpenAPI is preferred if it can be added without disproportionate runtime weight; otherwise ship a checked-in human-readable reference and examples.

## Feedback, notifications, and dashboard behavior

Feedback retains legacy categories through compatibility mapping while adding requested categories (bug, feature request, question, complaint, suggestion, general), status workflow (new, pending, in progress, resolved, closed), rating, severity/priority, identity/contact opt-in, and anonymous support. Search/filter/sort/pagination happen server-side with app scope. Duplicate detection is advisory (normalized text/time-window; no destructive merging); rate limits and honeypot/challenge hooks reduce spam. Replies are customer-visible; internal notes are private and must never appear in public API responses. Attachments use strict allowlisted media types, byte and count limits, generated names, and safe download authorization.

Notifications belong to one application and target all app users or explicit app-scoped IDs/groups. In-app delivery/read state is core. Scheduling and expiry are persisted and processed by restart-safe jobs using leases/transactions. Email/Telegram adapters are optional and disabled unless configured. Templates are app-scoped and locale-aware with English/Vietnamese defaults. Delivery errors are safe, bounded, and retryable.

The admin dashboard grows into platform overview and app-scoped owner views for feedback, notifications, payment states, API health, webhooks, credentials, analytics, and configuration. Keep advanced settings away from ordinary feedback customers. Use responsive, accessible English/Vietnamese screens and clear distinctions among payment authorization, transaction submission, verification, and completion.

## Pi payment workflow and boundary

Official Pi documentation describes a browser Pi SDK flow and server-side Platform API approval/completion. The SDK calls `Pi.createPayment`; server API calls use `Authorization: Key ...`; user verification uses the access token with `/me`. The payment is completed only after the Platform API returns success from server-side completion. References: [Pi Payments](https://developers.minepi.com/docs/accept-payment/Payments), [Platform API](https://developers.minepi.com/docs/api-reference/PlatformAPI), [Pi SDK reference](https://developers.minepi.com/docs/api-reference/SdkReference), and [Getting Started](https://developers.minepi.com/docs/build-first-app/GettingStarted).

For connected apps, the Hub creates a local order-bound session and returns a payment handoff descriptor. The SDK must execute inside a supported Pi-enabled frontend associated with the originating Pi application. A Docker backend never attempts to invoke browser APIs. The connected app’s adapter passes the real Pi `paymentId` and `txid` to authenticated Hub endpoints; Hub calls Pi using that app’s configured, server-only credentials (if Pi Developer configuration permits that deployment model). Before approval/completion, the server checks the local session/order, app ownership and configured Pi app, expected amount, currency/unit, memo/metadata policy, user/app binding, expiry, and idempotency. It also queries the official Platform API as required to validate the payment and its association with the app. A payment state transition is committed transactionally and the originating application receives signed events only after authoritative state changes.

If Pi credentials or platform policy do not permit a central service to operate a connected app’s payment, the app must call its own backend adapter for the official approval/completion handshake and then send a signed, verifiable result to the Hub; the Hub records it only after server-side validation. This is a release-blocking architecture decision to confirm in a Pi Sandbox spike before production payment work. No fallback accepts a client callback as proof.

Record at least: `created`, `sdk_pending`, `authorized/approved`, `transaction_submitted`, `server_verified`, `completed`, `cancelled`, `failed`, and `expired`, plus separate Pi response state and timestamps. Do not conflate authorization, blockchain transaction submission, server verification, and Platform completion. Retries are safe/idempotent; reconciliation finds interrupted sessions and incomplete official Pi payments without asserting success. Refunds are a separate workflow and are exposed only if current official app capabilities support them; do not promise automatic reversal. Tests use mocks and Pi Sandbox only.

## Webhooks and background work

Events are immutable records with unique IDs and tenant IDs. Sign raw payload bytes with a per-subscription HMAC secret and include timestamp, event ID, and signature headers. Consumers can deduplicate by event ID. Delivery worker claims due rows transactionally, uses bounded timeouts, records each response, and retries retryable errors with capped exponential backoff and jitter. Permanent errors pause or dead-letter according to policy; app owners can inspect logs and manually requeue authorized events. Secret rotation allows overlap for a documented grace period. Use a persisted job/lease model that survives process restart; initial deployment runs one worker in the same process, with DB locking to prevent duplicate claims.

## Migration and compatibility

1. Add SQLite migrations and a dry-run/report command; snapshot current JSON before import.
2. Import existing apps, feedback, updates, notices, payments, and settings references in one transaction with stable IDs and uniqueness checks. Preserve original JSON files unchanged.
3. Convert known legacy feedback types/statuses to normalized new values while retaining `legacy_type`/`legacy_status` for exports; preserve display semantics for existing admin clients.
4. Mark old `payments` rows as legacy/unverified; never migrate a client-supplied `confirmed` row into the verified Pi payment ledger.
5. Keep legacy endpoint request/response fields through adapters; new routes use versioned models. Do not break the existing feedback form, SDK, AI panel, public update feed, or donation information.
6. Add backup/restore and upgrade instructions. Restore must be tested against a copied database, not production data.

## Testing and verification

Add automated tests incrementally before/with each implementation slice. Include migration fixtures, legacy route contract tests, tenant isolation, scopes/revocation/rotation, session and CSRF behavior, input validation, rate limits, upload limits, notification idempotency and retry, webhook signature/replay/retry/SSRF rejection, SQLite transaction and restart recovery, payment state-machine and ownership checks, duplicate callbacks, Pi API mocked failures/success, and an optional explicitly configured Pi Sandbox flow. Never use real Pi in automated tests.

Run tests, lint/syntax checks if added, container build, Compose config validation, migration dry run, health check, graceful shutdown, and backup/restore verification before release. Report actual counts and distinguish local mock checks from Pi Sandbox checks and production Developer credential setup.

## Deployment and operations

- Keep non-root Docker execution, configurable port, persistent DB and upload volumes, environment-based secrets, no Docker socket/host networking/privileged mode.
- Add `/api/v1/integration/health` or a compatible health endpoint with database readiness separate from external Pi reachability.
- On shutdown, stop claiming jobs, finish or release leases, close DB, and flush logs.
- Provide structured logs with request IDs, secret/PII redaction, retention/size bounds, backup instructions, migration/upgrade sequence, and restore procedure.
- Preserve current SoloHost deployment shape where possible; document required SQLite file permissions and persistent mount.

## Milestones and acceptance gates

1. **Foundation:** DB driver/build decision; migrations, JSON import/export, app registry and ownership, credentials/scopes, versioned health; tests prove no cross-tenant read/write.
2. **Feedback:** categories/statuses, replies/private notes, search/pagination, attachments, widget/client SDK support, notification to customer follow-up; legacy form and API contract remain working.
3. **Notifications/webhooks:** app scoped in-app notices, templates/schedule/expiry, durable signed webhook queue, delivery logs/retries/manual retry; tests prove tenant boundary and deduplication.
4. **Pi payments:** first run a Pi Developer/Sandbox spike to confirm per-app credential and frontend identity constraints; then implement app-bound session, official SDK handoff, server approval/verification/completion, reconciliation, immutable audit, callbacks, dashboard; no production claim without sandbox and credentials.
5. **SoloHost and Pi Web3 integration:** onboarding/request/approval, settings/health, examples, SDK/widget guides, callbacks, per-app credential lifecycle.
6. **Commercial readiness:** bilingual responsive dashboard, analytics/export/deletion, security review, load and recovery validation, Docker build/Compose/deployment docs, final acceptance matrix and release notes.

Each milestone is independently reviewable and retains backward compatibility. A later milestone may refine earlier schema through additive migrations. No module is called complete until the corresponding automated checks and acceptance criteria pass.

## Decisions left to implementation

- Select a SQLite Node driver and Node Alpine/glibc image after proving builds for SoloHost target CPU architectures.
- Set concrete attachment limits, API rate limits, retry ceilings, data retention defaults, and pagination caps as secure defaults documented in configuration.
- Confirm whether a central Hub deployment can securely use distinct connected Pi app credentials for SDK-created payments; otherwise implement the per-app backend adapter route.
- Keep optional email/Telegram adapters behind interfaces; implement only when credentials and operator need are present.
- Use conservative app registration requiring administrator approval initially; owner self-service billing or public auto-approval is outside the first release unless explicitly requested later.

## Implementation reporting

Release notes and the final delivery report must distinguish implemented/tested behavior, behavior implemented but not verified, Pi Sandbox results, required Pi Developer setup/approval, connected-app adapter work still required, and known limitations. In particular, do not call payment functionality production-ready without an end-to-end official Pi Sandbox verification and the required app credentials/capabilities.
