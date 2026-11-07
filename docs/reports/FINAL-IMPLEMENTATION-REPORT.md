# Feedback Hub implementation report

> **Historical snapshot:** this report's 2026-10-31 status predates the 2026-11-01 feedback/notices/fee-ledger/Pi integration and container acceptance work. Current results are in [`RELEASE-ACCEPTANCE-EVIDENCE.md`](RELEASE-ACCEPTANCE-EVIDENCE.md) and [`REMAINING-BLOCKERS.md`](REMAINING-BLOCKERS.md).

> The sections below preserve milestone history and are not the current acceptance status.

**Date:** 2026-10-31  
**Repository version:** 2.5.1 (package version retained)  
**Delivery status:** Partial implementation; not production ready as a universal service/payment hub.

## A. Executive summary

The repository now has a SQLite persistence foundation, repeatable schema migrations, a non-destructive JSON import path, a pending/approved application registry, hashed and revocable scoped credentials, and versioned tenant-scoped HTTP APIs. The existing JSON-shaped legacy routes remain available through a SQLite compatibility store. Added API workflows support feedback submission, tenant-scoped search/list/detail, status and priority changes, public conversation replies, scheduled notices, and idempotent payment session records. A small adapter implements documented Pi Platform API calls but is not wired to a verified payment state machine.

The original 78 regression checks remain green. The expanded suite passes 103 checks, including real HTTP startup, tenant isolation, persistence across process restart, migration failure handling, payment session idempotency, and mocked Pi Platform API requests. Docker Compose configuration parses. Docker image build and container health checks could not be verified because this environment cannot access the Docker Engine named pipe. No local customer JSON files were present to import.

This delivery does **not** meet the requested final-product acceptance criteria. Webhook delivery, customer identity/read state, attachments, owner self-service, true payment verification/completion/reconciliation, and several admin/product workflows remain missing. Do not describe the Pi payment module as live or production-ready.

## B. Completed work

### Persistence and migration

- Added `lib/db.js` and SQLite migrations `db/migrations/001-core.sql`, `002-json-import.sql`, and `003-workflows.sql`.
- Added applications, API credentials, feedback, legacy updates/notices/payments, feedback messages, notifications/recipients, webhook subscription/event/delivery, payment session/transaction, and audit-event tables with foreign keys, uniqueness constraints, checks, and indexes.
- Added the compatibility store and JSON importer (`lib/sqlite-compat-store.js`, `lib/json-import.js`, `scripts/migrate-json.js`). Imports are transactional and repeatable; malformed and duplicate inputs abort; source files are retained; legacy client-confirmed payment rows are downgraded to `legacy_unverified`.
- Verified migration and persistence with tests. The local `data/` dry run found 0 apps, feedback records, updates, notices, or payments, so no actual customer dataset was migrated in this workspace.

### Application registry, credentials, and APIs

- Added pending application registration, platform-admin approval, credential issue/rotation/revocation, exact scope checks, SHA-256 hashes at rest, one-time secret display, and disabled/expired/revoked credential rejection.
- Added `GET /api/v1/integration/health`, `POST /api/v1/apps/register`, admin app listing/approval/credential endpoints, and credential revocation.
- Added tenant-derived feedback submission and tenant-filtered feedback read/list. Client-supplied `app_id` cannot change tenant. Duplicate text detection is scoped to an app and time window; request size, categories, ratings, email shape, and pagination are bounded/validated.
- Added feedback `PATCH` status/priority and public conversation message read/reply endpoints. Private notes are not exposed through app credentials.
- Added tenant-scoped notification create/list endpoints, schedule and expiry validation, with supported notification categories.
- Added tenant-scoped payment session create/read endpoints with Pi precision validation, bounded metadata, idempotency replay, conflicting-key rejection, and explicit `verification_state: unverified`.
- Retained the unversioned legacy API and added real-server tests for startup, persistence, and rejection of false client payment confirmation.

### Pi integration adapter

- Added `lib/pi-platform.js`, which only targets `https://api.minepi.com/v2`, uses server-side `Authorization: Key ...`, validates path identifiers, applies a request timeout, and hides remote error bodies. It implements documented payment lookup/approval/completion and user verification calls.
- Added mocked tests for the official paths, headers, request body, input rejection, and error redaction. These tests do not contact Pi and do not prove Sandbox or production payment behavior.
- Removed the repository's hardcoded legacy ingest bearer fallback. Existing deployments that require the legacy token must configure `INGEST_TOKEN`; no replacement credential is embedded in code.

### Deployment and docs

- SQLite starts before the HTTP listener; startup imports JSON once and startup errors prevent listening. Graceful shutdown closes the server/database through the existing lifecycle hook.
- Docker configuration uses Node 24, persistent `/app/data`, a health endpoint, non-root execution, dropped Linux capabilities, and no-new-privileges. The Docker image no longer copies the local config directory.
- Added/updated `docs/API-v1.md`, `docs/UPGRADE.md`, and `docs/PI-INTEGRATION.md`; baseline, design, plan, and progress artifacts remain in `docs/audit/`, `docs/superpowers/`, and `docs/reports/`.

## C. Incomplete work

| Area | State and missing work | What is needed |
|---|---|---|
| Feedback support | Submission/read/status/public replies are implemented. Customer follow-up tokens, customer tracking portal, internal notes/reply UI, upload storage/scanning, attachment limits beyond request size, spam tooling, richer filtering/search, export/deletion, and analytics are not complete. | Engineering work; no external access required. |
| Notifications | Tenant-scoped notices and schedule/expiry persistence/listing are implemented. There is no durable scheduler/worker, recipient targeting, read/unread API, delivery retry state machine, templates, email/Telegram adapter, or delivery reporting. | Engineering work; provider credentials only if email/Telegram delivery is selected. |
| Webhooks | Tables exist. There is no registration/rotation API, SSRF-safe destination resolver, event enqueue path, signed delivery worker, exponential retry, delivery log UI, manual retry, or receiver SDK. | Engineering work and security review; no credentials required for an HTTP mock. |
| Pi payments | Idempotent unverified session storage and a mocked official API adapter exist. No app-specific encrypted Pi credentials, user-to-payment identity/order binding, approve/complete route, authoritative transaction reconciliation, payment webhook, or Sandbox validation exists. | Engineering work plus Pi Developer app access, app-specific server credentials, and actual Pi Sandbox access/configuration. Do not send secrets in chat; configure through an operator-controlled secret store after an enrollment design is implemented. |
| Owner/admin product | Existing admin dashboard and legacy controls remain. No app-owner accounts, role/membership model, owner-scoped UI, credentials/webhook management interface, operational event viewer, or full dashboard KPIs were added. | Engineering work. |
| SoloHost integration | Versioned API examples and Pi backend boundary are documented. There is no complete SoloHost payment handoff/webhook example that can be run end to end because Hub payment verification and webhooks are incomplete. | Engineering work; connected app must add an adapter and keep its own identity, business logic, and Pi app credentials. |
| UI/language | Existing public/admin pages are preserved. The requested responsive glass refresh, English/Vietnamese selection, dedicated module screens, and accessibility review were not performed. | Engineering work and visual/accessibility review. |
| Deployment verification | Compose config passes, but the Docker image, container startup, in-container health check, persistent-volume recreation, and Pi SoloHost installation were not executed. | Docker Engine access and then a SoloHost test deployment. |
| External services | Pi Sandbox was not run. Email/Telegram and external webhook targets were not configured or contacted. | Operator-owned service setup and credentials if those features are pursued. |

## D. Testing and verification

### Baseline regression suite

| Test name | Expected result | Actual result | Status | Evidence |
|---|---|---|---|---|
| AI discovery legacy checks | Existing behavior passes | 23 checks passed | PASS | `npm test` output: `ai-discovery: 23 checks passed` |
| Insights/donate legacy checks | Existing behavior passes | 28 checks passed | PASS | `npm test` output: `insights+donate: 28 checks passed` |
| AI kernel selftest | Existing kernel checks pass | 27/27 passed | PASS | `npm test` output |
| Baseline total | No regressions | 78 checks passed before changes; all 78 still run and pass | PASS | Baseline report and final `npm test` |

### New tests

| Test name | Expected result | Actual result | Status | Evidence |
|---|---|---|---|---|
| SQLite migration/constraints/compatibility | Migrations apply once; FK/index and compatibility behavior hold | Included in final Node suite | PASS | `tests/db.test.js` |
| JSON import | Import preserves valid legacy data, rejects malformed/duplicate input atomically, and does not expose records in dry-run output | Included in final Node suite | PASS | `tests/json-import.test.js` |
| App registration/credentials/auth scopes | Pending approval, key hashing, rotation, revocation, exact scope enforcement | Included in final Node suite | PASS | `tests/apps.test.js`, `tests/api-auth.test.js` |
| HTTP connector and tenant isolation | App A cannot read app B feedback; validation, duplicate, scope, feedback management, notices, and payment session rules hold | 7/7 route tests passed | PASS | `tests/api-v1.test.js` |
| Pi Platform adapter | Documented endpoint shape, server-only auth header, timeout/error boundary and identifier validation | 2/2 mocked adapter tests passed | PASS | `tests/pi-platform.test.js`; no Pi network used |
| Startup/restart integration | Actual HTTP server imports once, API works, data survives restart, DB errors block listener | 2/2 tests passed | PASS | `tests/startup.test.js` |
| Lifecycle handler | Shutdown hook drains server and closes DB once | 1/1 simulation passed | PASS | `tests/lifecycle.test.js`; Windows process-level SIGTERM was not verified |
| Combined `npm test` | All regression and new tests pass | 103 checks total: 78 previous checks + 25 Node tests; zero failures | PASS | Final command executed 2026-10-31 |
| Local JSON dry run | Report counts without modifying source data | 0 apps, feedback, updates, notices, payments | PASS | `npm run migrate:json -- --dry-run` |
| Docker Compose config | Compose file resolves | Exit code 0; warnings for inaccessible Docker user config and multiple compose filenames; `compose.yaml` selected | PASS WITH WARNINGS | `docker compose config` |
| Docker image build | Build image | Docker CLI could not connect to `npipe:////./pipe/docker_engine` after using a temporary writable Docker config | BLOCKED | `docker build -t feedback-hub:final .` |
| Container startup and HTTP health | Start container and call health endpoint | Not run; Docker Engine unavailable | BLOCKED | Same Docker Engine access failure |
| Pi Sandbox end-to-end payment | Authoritative approve/complete and reconciliation | Not run; no app credentials/Sandbox verification and no Hub callback state machine | BLOCKED | Mock tests only; official integration boundary documented in `docs/PI-INTEGRATION.md` |

## E. Security review

### Verified in code/tests

- Per-application credential secrets are randomly generated and hashed at rest; scopes are explicit; disabled apps, revoked keys, and expired keys fail authentication.
- Tenant IDs for API data queries derive from authenticated credentials. Cross-tenant feedback and payment session lookups return not found.
- SQL values are parameterized; schema enforces foreign keys, checks, and unique idempotency constraints. Payment session writes use an immediate SQLite transaction.
- JSON body size is capped at 160 KiB. Feedback and session input are validated; pagination is bounded. API errors do not include unexpected internal error details.
- Pi API key is passed only in the server-side adapter's `Authorization` header; no private key/passphrase storage is implemented. Legacy payment statuses cannot be promoted by client callbacks.
- Docker config uses a non-root process and drops capabilities; no privileged mode or Docker socket mount is configured.

### Open security risks/findings

- No webhook delivery currently exists; webhook destination SSRF controls and HMAC/replay implementation are therefore not verified.
- No attachment endpoint/storage exists, so upload scanning/content-type/path controls are not implemented.
- Existing admin session/CSRF behavior was preserved and not subjected to a full security audit. A production review should add CSRF controls to cookie-authenticated state-changing routes and verify secure-cookie behavior behind SoloHost TLS.
- App registration accepts descriptive HTTP(S) URLs but does not fetch them. If future workers contact registered URLs, enforce DNS/IP allowlists and redirect restrictions at connection time.
- API rate limiting is process-local and in-memory; it does not coordinate across replicas/restarts. The architecture is a single-host modular monolith.
- At-rest encryption for app-owned Pi credentials is absent because no credential enrollment feature was implemented. Never store those credentials in the current schema's unused ciphertext column without authenticated encryption and key rotation design.
- No dependency audit command was run; there are no mandatory npm runtime dependencies added, but transitive/OS image vulnerability status is not established.
- `node:sqlite` requires Node >=24.15 and is a built-in API with release-candidate stability in this Node line; this runtime floor is documented.

## F. Deployment instructions

### Configuration and local startup

1. Use Node.js 24.15 or newer.
2. Copy `.env.example` to the operator-controlled `config/solohost.env` (or export environment values directly). Set `PORT` (default 8090), `DATA_DIR` if desired, `HUB_ID`, `PUBLIC_BASE_URL`, and a strong `INGEST_TOKEN` only if an existing legacy client requires it. Do not commit secrets.
3. Set the first admin password in the existing admin setup page. Issue scoped app credentials only after reviewing each app registration.
4. Start with `npm start`. On first start, SQLite migrations run and existing JSON collections under `data/` are imported once. Keep a backup of the full data directory before migration.
5. Check `GET http://localhost:8090/api/v1/integration/health` and the existing `GET /api/health`.

### Migration and database backup

Preview with `npm run migrate:json -- --dry-run`, then run `npm run migrate:json`. The importer does not delete JSON source files. For backup, stop the service and copy the complete `data/` directory, including `feedback-hub.sqlite` and any JSON originals. Restore while stopped by replacing the data directory with a verified backup. See `docs/UPGRADE.md` for the upgrade sequence and compatibility notes.

### Docker Compose / SoloHost

1. Configure `config/solohost.env` without committing it. Keep the persistent `./data:/app/data` mount.
2. Build and start with `docker compose up --build -d`; use `HOST_PORT` to change the host port. The app listens inside the container on `8090`.
3. Verify `docker compose ps`, then request `http://<host>:<HOST_PORT>/api/v1/integration/health`. The container healthcheck probes that same endpoint.
4. Back up the host `data/` directory with the container stopped. For upgrades, preserve the volume, pull/copy the new source, rebuild, and let the numbered migration run at startup.

Docker build, startup, healthcheck, and SoloHost installation instructions are documented but were **not executed successfully in this environment** because Docker Engine access was denied.

### Pi configuration

No `PI_API_KEY` is currently consumed by the Hub because Pi Platform calls are not wired to sessions. Connected Pi applications must follow `docs/PI-INTEGRATION.md`, keep their own Pi key in their backend secret store, and test the official Sandbox flow in a Pi-supported environment before using any production payment flow.

## G. Changed files

### Important files created

- `lib/db.js`, `lib/json-import.js`, `lib/sqlite-compat-store.js`, `scripts/migrate-json.js` — SQLite startup, compatibility, and import.
- `lib/apps.js`, `lib/api-auth.js`, `lib/api-v1.js`, `lib/lifecycle.js`, `lib/pi-platform.js` — registry, credential auth, versioned API, shutdown hook, and documented Pi API adapter.
- `db/migrations/001-core.sql`, `002-json-import.sql`, `003-workflows.sql` — core and workflow schema.
- `tests/db.test.js`, `json-import.test.js`, `apps.test.js`, `api-auth.test.js`, `api-v1.test.js`, `pi-platform.test.js`, `startup.test.js`, `lifecycle.test.js` — new/expanded verification.
- `docs/API-v1.md`, `docs/UPGRADE.md`, `docs/PI-INTEGRATION.md`, baseline/design/plan/progress artifacts, and this report.

### Important files modified

- `server.js` — SQLite/import startup, API mounting, lifecycle integration, and removal of hardcoded ingest-token fallback.
- `lib/feedback-module/feedback-service.cjs` — removed its embedded ingest-token default.
- `Dockerfile`, `compose.yaml`, `compose.yml`, `.env.example` — runtime, volume, health, privilege, and port configuration.
- `package.json` — Node runtime floor and test script for new modules.
- `tests/db.test.js` and `tests/api-v1.test.js` — updated expected migration version and added route coverage.

### Deleted files

None.

## H. Remaining actions

### Codex can complete independently

- Implement safe webhook subscriptions, HMAC signing/receiver verification, SSRF-safe HTTP delivery, durable retries, and delivery UI.
- Add owner identities/roles, app-owner UI, private support notes, customer follow-up tokens, attachments, exports/deletion, and analytics.
- Connect payment sessions to a carefully reviewed app-specific credential model and authoritative state machine; add mock tests, recovery/reconciliation, and secure result webhooks.
- Add notification recipients/read state, background scheduling, retry worker, templates, and optional delivery adapters.
- Conduct CSRF/session, dependency/image, and full threat-model reviews after those modules exist.

### Requires operator authorization/configuration

- Configure secure environment values and first platform administrator password on deployment.
- Approve connected applications and issue their scoped Hub credentials.
- Provide/authorize access to a Pi Developer app and its server-side credentials via an operator-controlled secret mechanism after the enrollment design exists. Do not send secrets through chat.
- Decide whether external email/Telegram providers are desired and configure credentials if so.

### Requires external access

- Docker Engine access to build and start the image; a Pi SoloHost test host to verify persistent-volume and healthcheck behavior.
- Pi Browser/Sandbox and Developer Portal configuration to validate a real U2A payment approval/completion cycle. Production access/approval is separate.
- External webhook endpoint for a controlled integration test, after delivery security implementation.

## I. Final delivery status

- **Ready to use:** Existing app behavior and legacy endpoints, SQLite migration foundation, app registration/credentials, tested tenant-scoped feedback/status/replies, scheduled tenant notifications, unverified payment session storage, API health, and documented API examples.
- **Ready for integration testing:** Feedback Hub REST APIs, credential scope and tenant boundaries, JSON migration fixtures, and mocked Pi Platform client.
- **Not production ready:** Universal notification delivery, webhooks, customer identity/read tracking, attachments, app-owner SaaS dashboard, and Hub-managed Pi payment processing.
- **Docker build:** Not successful/verified; Docker Engine named pipe access denied.
- **Container startup and health:** Not run; blocked by unavailable Docker Engine.
- **Pi Sandbox payment verification:** Not performed. No payment has been authoritatively verified or completed by this delivery.
- **Deleted files:** None.

## J. Version and release notes

The repository package version remains **2.5.1**. This implementation adds schema migrations 001–003 (migration 003 is the current workflow schema), versioned APIs, Node 24.15 runtime requirements, SQLite-backed legacy compatibility, and a testable but not wired Pi Platform API adapter. Treat this as an incomplete development milestone, not a commercial or payment-production release.

## K. Continuation implementation and verification — 2026-10-31

### Executive summary

The continuation builds on the current SQLite modular monolith and preserves legacy endpoints, JSON import, existing AI/insights/donation features, and user data. It adds feedback customer tracking and attachments, durable in-app notification delivery, signed webhooks, owner accounts/dashboard, a server-side Pi payment workflow, and a runnable SoloHost connector sample. Status: substantially implemented but incomplete and not production-ready. Latest `npm test` passed 126 checks: 78 existing regression checks and 48 Node tests. Docker Engine execution and real Pi Sandbox payment verification remain externally blocked.

### Architecture and schema

Existing Node and SQLite architecture remains. Migrations 004–008 add customer tokens/attachment metadata; notification jobs, attempts, recipient read state and templates; tenant-bound webhook subscriptions/events/deliveries; owner memberships/sessions/reset tokens; encrypted per-app Pi configuration and append-only payment audit records. Migrations 001–003 remain. JSON import remains non-destructive. Current `npm run migrate:json -- --dry-run` exited 0 and reported zero apps, feedback, updates, notices, payments for this workspace. Checkpoint: `.checkpoints/continuation-before-modules-2026-10-31.zip`. No files or data were intentionally deleted.

`HUB_ENCRYPTION_KEY` must be a persistent operator secret: 32 random bytes base64url-encoded. It encrypts Pi and webhook secrets. Losing it makes stored secrets unreadable; master-key rotation is manual. Back up the key securely alongside a separate protected recovery copy.

### Module delivery and remaining gaps

| Module | Status and evidence | Incomplete/boundary |
|---|---|---|
| SQLite/import | Migrations 001–008, relational integrity, compatibility and non-destructive import; database/import/restart tests pass. | Operator production data migration not run; single host/process SQLite only. |
| App connector/auth | Pending app registration/admin approval; hashed scoped credentials, rotation/revocation, versioned tenant APIs; scope and cross-tenant HTTP tests pass. | Generic OAuth 2.0 authorization server and owner self-registration are absent. |
| Feedback | Hashed expiring follow-up tokens, customer portal, own-record history/reply/delete, public replies/private staff notes, statuses, safe attachments, filters/search/sort/paging/analytics/CSV; isolation tests pass. | No email follow-up; no malware scanner. Upload allowlist PNG/JPEG/WebP/PDF, max 5 MiB. |
| Notifications | SQLite scheduler/worker, scheduled/immediate in-app delivery, recipient selection/read state, locale templates, expiry/cancel, idempotency, attempts and bounded retries; mock retry tests pass. | Email/Telegram are injectable adapters only; no credentials or real delivery. Editing and external provider end-to-end flow incomplete. |
| Webhooks | Tenant-scoped subscriptions/events, AES-GCM secrets, rotation, HMAC signatures, timestamp/replay defense, DNS address validation/pinning, private/metadata/IPv4/IPv6 defenses, redirects disabled, time/response bounds, persistent retries/history/manual retry; adversarial tests pass. | External endpoint delivery not run. At-least-once; receiver must deduplicate. Network behavior needs SoloHost validation. |
| Owner management | Invited app memberships/roles, scrypt passwords, hashed sessions, Secure/HttpOnly/SameSite cookie, CSRF, throttling, reset session revocation, tenant-scoped owner APIs/dashboard; HTTP role tests pass. | No invite/recovery email transport; platform admin manages invitations. HTTPS required. |
| Pi payments | Per-app encrypted Developer App configuration; create/idempotency; Pi token `/me`, authoritative payment lookup and app/user/order/amount/memo/metadata/direction/network checks; approval/completion claims, authoritative completion, audit/reconciliation; mocked HTTP/concurrency/recovery tests pass. | Real Sandbox blocked by lack of operator-authorized Developer App credentials and Pi Browser environment. No production-ready claim; no undocumented refund capability. |
| SoloHost sample | Runnable sample HTTP server, backend-only Hub key, local order/session, feedback/notification/payment coordination, signed webhook verification and duplicate protection; test passes with mock Hub. | Connected app provides its own Pi Browser frontend and authorized Developer App. |
| UI | Owner dashboard sections for feedback/notifications/webhooks/payments/analytics/settings/team/API, customer tracking form and EN/VI selection; JS parse and HTTP routes tested. | No visual browser/mobile, full accessibility, translation or platform-admin UI audit. |
| Docker/SoloHost | `docker compose -f compose.yaml config` exits 0; persistent volume, non-root image, capability drop, no-new-privileges and health config remain. | Build/start/container health/recreate persistence not executed because Docker Engine named pipe is denied. No SoloHost host available. |

### APIs and integration

See `docs/API-v1.md` for payloads and response formats. Main routes include registration/admin approval and credential rotation; tenant-scoped feedback and customer follow-up routes; `/feedback/track`; notifications, templates and read/cancel/retry; webhook register/list/rotate/disable/delivery/retry; payment create/read/approve/complete; owner routes under `/api/v1/owner`; and `GET /api/v1/integration/health`. App keys are server-side bearer credentials with scopes. Customer IDs are app-local; Pi identity tokens are not shared across applications.

### Pi payment workflow

The connected app's supported Pi frontend runs the official SDK. The Hub backend holds the app-specific encrypted Platform API key, checks user token and authoritative payment data before approval, then records `completed`/`verified` only after authoritative completion confirmation bound to app, user, amount, and transaction. Frontend callbacks are not proof. Implementation follows the official [Pi payment guide](https://developers.minepi.com/docs/accept-payment/Payments) and [Pi Platform API reference](https://developers.minepi.com/docs/api-reference/PlatformAPI). Automated tests mock Platform calls. No Sandbox payment or real transaction happened; refunds are not claimed.

### Verification results

| Test | Expected | Actual | Result/evidence |
|---|---|---|---|
| Existing AI discovery | 23 | 23 | PASS, `npm test` output |
| Existing insights/donation | 28 | 28 | PASS, `npm test` output |
| Existing AI kernel | 27 | 27 | PASS, `npm test` output |
| Existing regressions subtotal | 78 | 78 | PASS |
| SQLite/import/migration/failures | Preserve data; reject malformed input | Test suite passed; dry-run exit 0 and zero local counts | PASS, `tests/db.test.js`, `tests/json-import.test.js` |
| Credential/scope/tenant API | Reject invalid/cross-tenant requests | Passed | PASS, `tests/apps.test.js`, `tests/api-auth.test.js`, `tests/api-v1.test.js` |
| Customer access/private notes/attachments | Own public records only; safe tenant-bound files | Passed | PASS, API and `tests/feedback-attachments.test.js` |
| Notification scheduling/retry/locales | Durable/idempotent delivery and bounded retries | Passed using mock provider | PASS, `tests/notifications.test.js` |
| Webhook HMAC/replay/SSRF/retries | Reject unsafe destinations and invalid signatures | Passed against policy/mocks | PASS, `tests/webhook-security.test.js`, `tests/webhooks.test.js` |
| Owner role/session/CSRF | Enforce membership, revoke reset sessions | Passed | PASS, `tests/owners.test.js`, API tests |
| Pi state/idempotency/concurrency/recovery | Only authoritative mocked completion | Passed using mocks | PASS, `tests/pi-platform.test.js`, `tests/pi-payments.test.js`, API test |
| Sample connector HTTP/signature | Routes work; invalid/duplicate signatures rejected | Passed against mock Hub | PASS, `tests/connector-sample.test.js` |
| Startup/health/restart/shutdown | HTTP works; persistent data survives process restart | Passed | PASS, `tests/startup.test.js`, `tests/lifecycle.test.js` |
| Full current tests | 126, no failures | 48 Node pass, 0 fail/skip + 78 existing = 126 | PASS, latest `npm test` exit 0 |
| JSON migration dry-run | Read-only count preview | Exit 0, all counts 0 | PASS, command output |
| Compose config | Resolve deploy configuration | Exit 0, Docker config access warning | PASS with warning |
| Docker image/container health/persistence | Build, healthy container, restart retention | Not run; Engine npipe access denied | BLOCKED |
| Real Pi Sandbox | Authorized approve/sign/complete | Not run; credentials/environment unavailable | BLOCKED |
| External email/Telegram/public webhook | Real network/provider delivery | Not run; mock/in-process only | NOT RUN |

### Security review

Verified in tests/code: auth-derived tenant boundaries and scopes; hashed credentials, follow-up tokens and sessions; request validation/body bounds; parameterized SQL; generated attachment paths, allowlisted signature-checked content, size and tenant checks; CSRF/session protections and throttling; AES-GCM secret storage; webhook HTTPS/private/loopback/link-local/metadata/IPv4/IPv6 filtering, DNS pinning, redirect prohibition, bounded time/response, exact-body HMAC and replay checks; payment idempotency, server verification, concurrency claims and append-only audit.

Residual risks: no dependency vulnerability scan, independent penetration test or external code review; network/DNS pin behavior unverified on SoloHost; attachments have no malware scanning; master key rotation manual; email/Telegram transport absent; generic OAuth, cross-origin widget/CORS product, complete API metering/audit dashboard and multi-replica operation absent; owner invite/recovery email absent; visual accessibility/mobile testing not run. Do not represent this as fully security-audited or production-ready.

### Deployment and recovery

Require Node >=24.15, a single service process and writable persistent `data/`. Put secrets in `config/solohost.env`/SoloHost secret manager, not source control. Generate the encryption key with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set `HUB_ENCRYPTION_KEY`, preserve it, and use HTTPS for owner sessions. Preview import with `npm run migrate:json -- --dry-run`; back up the full data directory before migrating operator records. Local start: `npm start`; health: `GET /api/v1/integration/health`.

Docker commands (not verified in this environment):

```sh
docker compose -f compose.yaml config
docker compose -f compose.yaml build
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
curl -fsS http://localhost:8090/api/v1/integration/health
docker compose -f compose.yaml logs --tail=100 feedback-hub
```

Verify `healthy`, create a record, recreate the container with the same `./data` mount, then confirm record retention. This was not run. Back up with service stopped and include database/WAL plus attachments; restore the matching encryption key separately and securely. Detailed config/recovery steps: `docs/DEPLOYMENT-SOLOHOST.md`, `docs/UPGRADE.md`.

### Changed files

Added `db/migrations/004-customer-feedback.sql` through `008-pi-payment-workflow.sql`; modules `lib/feedback-attachments.js`, `lib/notifications.js`, `lib/webhooks.js`, `lib/webhook-security.js`, `lib/secret-box.js`, `lib/owners.js`, `lib/pi-payments.js`; expanded `lib/api-v1.js`, `server.js`, `package.json` and API/DB/startup tests; added `public/feedback-track.html`, owner dashboard updates and `examples/solohost-connector/`; added notification, webhook, attachment, owner, payment and sample tests; updated API/Pi/deployment/upgrade docs, README and `.env.example`; added `docs/reports/REMAINING-BLOCKERS.md`. No intentionally deleted files, release tag, public image, deployment or GitHub push.

### Remaining actions and final state

Codex completed the independent implementation and mock testing. Operator/external actions: provide authorized Docker Engine or SoloHost test host; configure TLS, persistent volume and secrets; run build/health/recreate-persistence checks; configure authorized Pi Developer App and Pi Browser Sandbox; run real Sandbox approval/user-sign/completion and recovery; optionally configure email/Telegram; test against controlled public webhook receiver; conduct dependency, security and accessibility reviews. See `docs/reports/REMAINING-BLOCKERS.md` for exact commands and requirements.

**Ready for local integration tests:** feedback/customer tracking, owner flows, in-app notices, mocked webhook delivery, connector sample and mocked Pi flow. **Externally unverified:** live webhook delivery, external providers, Docker runtime, Pi Sandbox. **Not production-ready:** Pi pending Sandbox verification; external providers and security review; multi-instance deployment. Docker build was blocked by Docker Engine access, not asserted successful. Container health/persistence not performed. Pi Sandbox not performed. Latest tests: 126 passed, 0 failed. Package version remains 2.5.1.
