# SQLite and Tenant-Safe Connector Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (subagent-driven approach) or superpowers:executing-plans (native approach) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a migration-safe SQLite foundation and versioned, tenant-scoped app/feedback APIs while preserving the current SoloHost Feedback Hub behavior.

**Architecture:** Keep the existing Node modular monolith and native HTTP server. Add a focused SQLite store, one-time JSON importer, app credential/scope services, and `/api/v1` routing modules; retain old endpoints behind compatibility adapters. Store only API credential hashes and require app identity to come from authenticated credentials on versioned routes.

**Tech Stack:** Node.js >=24.15 LTS, ES modules, built-in `node:sqlite` `DatabaseSync`, `node:test`, Docker Compose using Node 24 Alpine. Node 20 reached EOL before this implementation date; do not keep the production image on that EOL runtime.

**Spec:** `docs/superpowers/specs/2026-10-31-universal-pi-service-hub-design.md`

## Global Constraints

- Preserve current unversioned feedback, updates, notices, app, admin, AI, and SDK behavior through compatibility adapters.
- Preserve and import all existing JSON records and stable IDs; never migrate legacy `confirmed` payment records as verified Pi payments.
- All new app-owned reads and writes must include an authorized `application_id` boundary.
- App registration requests start pending; credentials are generated only for approved apps.
- Store API credential hashes, show generated secrets once, and keep Pi secrets out of this milestone.
- No implementation claim is complete without executing its named tests.
- This workspace has no Git metadata; do not invent commit hashes or rely on Git rollback. Keep the baseline archive and use task-level file backups where a destructive migration is involved.

## Review Focus

1. **Two apps with similar IDs/records** must never read or mutate one another’s rows; pin with cross-tenant feedback API tests (Task 4).
2. **Wrong or revoked credential / missing scope** must not reach handlers; pin with auth and scope tests (Task 3).
3. **Interrupted or repeated JSON import** must not duplicate or partially import records; pin with import atomicity/idempotency tests (Task 2).
4. **Legacy payment marked `confirmed`** must remain unverified after import and be excluded from verified totals; pin with migration fixture assertions (Task 2).
5. **Legacy feedback for a previously unseen app ID** must retain the old submission behavior while creating only an unapproved legacy-discovered app and applying rate limits; pin with compatibility HTTP tests (Task 4).

---

## File Map

- `lib/db.js`: open/close SQLite, pragmas, migration runner, transaction helper.
- `db/migrations/001-core.sql`: normalized apps, credentials, feedback, updates, notices, legacy payments, migration marker schema and indexes.
- `lib/sqlite-compat-store.js`: implement the existing `read`, `write`, and `upsertApp` store interface against SQLite so existing handlers and AI modules keep working.
- `lib/json-import.js`: one-time validated JSON import with stable IDs and a report; source files remain unchanged.
- `lib/apps.js`: app registration/approval and API credential issuance, rotation, revocation, and lookup.
- `lib/api-auth.js`: bearer credential parsing, constant-time hash comparison, scope enforcement, and authenticated app context.
- `lib/api-v1.js`: versioned health, registration, feedback endpoints and stable response/error serialization.
- `server.js`: initialize DB/import before listening and dispatch `/api/v1` through the new router without rewriting legacy routes.
- `package.json`, `Dockerfile`, `compose.yaml`, `.env.example`: dependency/build/runtime configuration and migration command.
- `tests/db.test.js`, `tests/json-import.test.js`, `tests/apps.test.js`, `tests/api-auth.test.js`, `tests/api-v1.test.js`, `tests/startup.test.js`: focused unit/integration coverage.
- `docs/API-v1.md`, `docs/UPGRADE.md`: first connector contract and operator migration/backup instructions.

## Interfaces

- `openDatabase({ dataDir, migrationsDir }) -> { db, close() }`; enables SQLite foreign keys, bounded busy timeout, WAL, and applies migrations transactionally.
- `createSqliteCompatStore(sqliteDb)` returns the current `createFileDb` interface: `read(collection)`, `write(collection, rows)`, `upsertApp(partial)`; supported collections are `apps`, `feedback`, `updates`, `notices`, and legacy `payments`.
- `importJsonData({ db, dataDir }) -> { imported, skipped, warnings }`; idempotent, transaction-bound, never modifies source JSON.
- `createAppService(db)` returns `requestRegistration(input)`, `approveApp(appId)`, `issueCredential(appId, scopes)`, `revokeCredential(credentialId)`, and `authenticateCredential(secret)`.
- `authorizeCredential(authContext, requiredScope) -> boolean` is provided by `lib/api-auth.js`; route modules use it after credential authentication.
- `createApiV1({ db, appService, isPlatformAdmin, clock }) -> async (req, res, url) => handledBoolean`; handlers derive tenant identity only from credential auth or approved admin session, never from a body-supplied `app_id`.
- API result envelope: success `{ ok: true, data, meta? }`; failure `{ ok: false, error: { code, message, details? }, request_id }`.

### Task 1: SQLite Store and Migration Runner

**Files:**
- Create: `lib/db.js`
- Create: `lib/sqlite-compat-store.js`
- Create: `db/migrations/001-core.sql`
- Modify: `package.json`
- Modify: `Dockerfile`
- Test: `tests/db.test.js`

**Interfaces:** Produces `openDatabase({ dataDir, migrationsDir })` for Tasks 2–4.

- [x] **Step 1: Write failing DB tests** for migration creation, foreign-key enforcement, unique app IDs, repeat-open migration idempotence, and close behavior.
- [x] **Step 2: Run `node --test tests/db.test.js`** and confirm it fails because the DB module/schema do not exist.
- [x] **Step 3: Use Node’s built-in `node:sqlite` and set the package engine to `>=24.15.0`; move the Docker base to `node:24-alpine`.** This avoids a third-party native module and registry access, at the cost of using Node SQLite’s release-candidate API; pin the runtime floor and add smoke tests for every API used.
- [x] **Step 4: Implement `openDatabase` and migration 001** with `schema_migrations`, `applications`, `api_credentials`, `feedback`, `updates`, `notices`, `payments_legacy`, and tenant/time indexes. Keep a serialized legacy JSON payload for existing records where the old API depends on fields not yet normalized. Enable `foreign_keys`, `busy_timeout`, and WAL; apply each migration in a transaction.
- [x] **Step 5: Implement `createSqliteCompatStore`** so existing code can continue using `read`, `write`, and `upsertApp` without direct JSON array persistence; preserve legacy IDs and fields.
- [x] **Step 6: Run `node --test tests/db.test.js`** and require all assertions to pass, including reopening an initialized database and compatibility store round trips.

### Task 2: Idempotent Legacy JSON Import

**Files:**
- Create: `lib/json-import.js`
- Create: `tests/fixtures/legacy-data/` (small synthetic JSON fixtures)
- Create: `tests/json-import.test.js`
- Modify: `package.json`

**Interfaces:** Produces `importJsonData({ db, dataDir })` for startup and operator CLI use.

- [x] **Step 1: Write failing import tests** for apps, feedback, updates/notices if represented in schema, old payment classification, stable IDs, malformed files, duplicate IDs, and repeated import.
- [x] **Step 2: Run `node --test tests/json-import.test.js`** and verify import tests fail before implementation.
- [x] **Step 3: Implement import as one transaction**; record a completion marker only after success. Keep JSON files byte-for-byte unchanged. Import old confirmed payments into `payments_legacy` with `verification_state='legacy_unverified'`; do not count them as verified transactions.
- [x] **Step 4: Add a dry-run/import report command** that shows row counts and warnings without printing message content, tokens, or personal details.
- [x] **Step 5: Run `node --test tests/json-import.test.js`** and confirm repeat runs do not duplicate rows and a failed transaction can be retried cleanly.

### Task 3: App Registration and Credential Scopes

**Files:**
- Create: `lib/apps.js`
- Create: `lib/api-auth.js`
- Create: `tests/apps.test.js`
- Create: `tests/api-auth.test.js`

**Interfaces:** Implements app service and auth functions in the Interfaces block. Raw credential secret is returned only by `issueCredential`; DB stores a cryptographic hash. `authenticateCredential` returns `{ applicationId, credentialId, scopes }` or `null`.

- [x] **Step 1: Write failing app-service tests** for pending registration, admin approval, disabled app denial, app ID collision, one-time credential secret shape, independent active credentials, rotation, and revocation.
- [x] **Step 2: Write failing API-auth tests** for bearer parsing, correct/wrong/revoked key, unknown key, and exact scope enforcement.
- [x] **Step 3: Run the new test files** and verify they fail on missing services.
- [x] **Step 4: Implement app registration and credential storage** with secure random secrets, hash-at-rest, scope allowlist (`feedback:write`, `feedback:read`, `apps:read`), app status enforcement, and admin-only approval/credential issuance at this milestone.
- [x] **Step 5: Implement `authenticateCredential` and scope guard** using a fixed-length cryptographic digest comparison and constant-time comparison; update last-used timestamp without logging the secret.
- [x] **Step 6: Run `node --test tests/apps.test.js tests/api-auth.test.js`** and require all tests to pass.

### Task 4: Versioned Tenant-Scoped Feedback API

**Files:**
- Create: `lib/api-v1.js`
- Create: `tests/api-v1.test.js`
- Modify: `server.js`
- Create: `tests/helpers/http.js` (only if a shared test helper is needed)

**Interfaces:** Consumes DB, app service, and credential authentication from Tasks 1–3. Exposes `POST /api/v1/apps/register`, admin-protected app approval/credential routes, `GET /api/v1/integration/health`, `POST /api/v1/feedback`, `GET /api/v1/feedback`, and `GET /api/v1/feedback/:id`.

- [x] **Step 1: Write failing HTTP tests** for unauthenticated request, pending app key, missing scope, successful feedback create, app ID body spoofing, tenant-isolated list/get, pagination cap, invalid category/body, and rate-limited legacy unknown-app behavior. Versioned feedback accepts categories `bug`, `feature_request`, `question`, `complaint`, `suggestion`, and `general`; rating is optional or an integer from 1 to 5.
- [x] **Step 2: Run `node --test tests/api-v1.test.js`** and verify it fails before route integration.
- [x] **Step 3: Implement stable request ID and response envelopes** with validation errors, correct HTTP status codes, bounded page size, and JSON content type. Add the new `node --test` files to the `npm test` script without removing any existing checks.
- [x] **Step 4: Implement registration and feedback handlers**. A feedback `application_id` is always taken from the authenticated credential; body `app_id` is ignored/rejected. Registration is pending until a platform admin approves. Only approved apps receive write credentials.
- [x] **Step 5: Mount `/api/v1` in the existing server** and leave old route handlers in place. Route all legacy reads/writes through `createSqliteCompatStore`. Retain legacy auto-discovery only on the legacy feedback ingest path, mark discovered apps unapproved, and rate limit submissions; versioned APIs never auto-create apps.
- [x] **Step 6: Run `node --test tests/api-v1.test.js` and `npm test`**. Existing tests must remain green, and HTTP tests must prove app A cannot read app B records.

### Task 5: Startup, Docker, and Migration Operations

**Files:**
- Modify: `server.js`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Create: `docs/UPGRADE.md`
- Create: `tests/startup.test.js`

- [x] **Step 1: Write startup tests** for first boot import, already-imported boot, database failure preventing listen, health readiness, and graceful SIGTERM DB close.
- [x] **Step 2: Initialize and verify DB/import before `server.listen`**, using `DATA_DIR` when configured and the existing `data/` directory otherwise; add a migration CLI mode that exits after report/import and does not expose server credentials.
- [x] **Step 3: Configure persistent database path under `/app/data`**, non-root write permissions, DB readiness health, and graceful shutdown. Preserve unprivileged container, no host networking, and no Docker socket access.
- [x] **Step 4: Document backup, restore, migration, rollback-to-baseline archive, and legacy API credential transition** in `docs/UPGRADE.md`.
- [ ] **Step 5: Run `node --test tests/startup.test.js`, `npm test`, `docker compose config`, and `docker build -t feedback-hub:foundation .`**. Record actual output and test count; do not claim Docker verification if the build cannot access dependencies or target architecture.

## Follow-on Plans

This plan delivers only the foundation milestone. Before implementation of each independent subsystem, create a reviewed plan against the approved design:

1. Feedback conversations, attachments, anti-spam, customer follow-up, analytics, and embed widget.
2. Notifications, templates/scheduling/delivery adapters, webhook subscriptions, signed durable delivery/retries, and event logs.
3. Pi payment Sandbox spike and official SDK/Platform API state machine, app-specific Pi credentials/adapter, reconciliation, and payment dashboard.
4. App-owner accounts/dashboard, SoloHost and Pi Web3 integration guides/client SDK, export/deletion, and final deployment/security review.

A follow-on plan must not call Pi payment completion production-ready before the official Sandbox workflow, app authorization, and required Developer credentials have all been verified.
