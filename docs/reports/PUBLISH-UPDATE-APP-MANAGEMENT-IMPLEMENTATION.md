# Publish Update and App Management Implementation Report

## Summary

The existing application now publishes updates and creates admin notices only for applications present in the authoritative SQLite registry and in an approved, active state. The admin setup and session behavior has been hardened without changing the authentication model, existing SDK response fields, notification workflow, database schema, or application architecture.

## Root causes and fixes

- **`Unauthorized` after a long-lived admin session:** the server previously extended its in-memory session on activity while the browser cookie kept a fixed 12-hour lifetime. The session store now uses the same fixed expiration deadline as the cookie; cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS requests. The admin UI returns to sign-in when an API request reports an expired session.
- **Initial admin takeover:** first-time setup is allowed only from a direct loopback TCP peer (`127.0.0.0/8`, `::1`, or IPv4-mapped loopback), or through Docker Compose's separately published setup listener bound exclusively to host `127.0.0.1`. It is rate-limited and disabled after a password is set. Forwarded-IP headers are ignored; the normal Docker app port cannot perform setup.
- **Password setup/login mismatch:** setup previously used the general-purpose `clean()` helper, which trimmed whitespace and truncated passwords while login hashed the exact submitted text. Setup now preserves the exact password string, enforces an explicit 6–200 character limit, and login rejects oversized values before hashing. The browser fields enforce the same maximum.
- **Publish Update validation and application-name mismatch:** the UI previously sent a manually entered app name and required a short notice even when release notes were provided. The server now resolves the name from SQLite by `app_id`, validates the app state and required update fields, accepts release notes as the notice fallback, validates release URLs, and retains full release notes, version, URL, and publication state. Public update records retain the SDK-compatible `app_id`, `app_name`, `version`, `notice`, `release_url`, and `published` fields.
- **Cross-application and stale UI state:** selectors now share one registry-backed active-app model; application selection is synchronized across update and notification forms. The existing feedback and admin-tools panels are reused in an app detail view, with feedback, notifications, updates, insights, and plans scoped to the selected app. App changes clear form/report state, reject stale responses, and browser back/forward navigation returns to the appropriate list or app.
- **Insecure deployment defaults/build context:** new installations no longer receive a hard-coded HTTP public URL. Docker build context now excludes the operator env file, runtime data, and database files. Existing persisted public URLs and application data are not rewritten.

## Completed scope

- Added regression coverage for loopback-only setup, direct-peer rate limiting despite spoofed forwarded headers, authentication failure, session expiry/revocation, publishing and validation, authoritative app-name resolution, SDK compatibility, active/pending/paused/disabled app rejection, notice creation and targeting, selector eligibility/synchronization, app-specific API scoping, and UI navigation/stale-state wiring.
- Added setup/login coverage for invalid lengths, passwords with leading/trailing spaces, persisted credentials after server restart, failed login, and successful subsequent login.
- Exercised the admin interface in a browser against a temporary local server: initial setup, app creation, synchronized selectors, publishing an update, creating a notice draft, switching apps without retaining notice/release-note state, and browser back navigation.
- Preserved existing migrations, notification approval/publishing/scheduling and recipient targeting, the pending-approval flow, AI Kernel/Universal AI Panel, feedback modules, SDK routes, Pi integration, webhooks, and existing JSON data. No database migration or reset was introduced.
- Updated setup, upgrade, integration, and SoloHost deployment instructions. No new npm dependency was added.
- Added a Docker-only setup listener on port `8091`, published by Compose exclusively on host `127.0.0.1`. Docker NAT presents host-loopback traffic to the container as a bridge peer rather than a loopback address, so the regular app port still rejects setup in Docker (including requests with forged `X-Forwarded-For`). The setup listener stops reporting availability after the password is saved.
- Added a required SoloHost secret option for the initial admin password. Compose injects this only for first boot; the server validates 6–200 characters, persists only its scrypt hash, deletes the variable from its process environment, and never overwrites an already configured password. This makes secure remote SoloHost onboarding possible without opening the password-setup endpoint through the SoloHost proxy.
- Synchronized all three Compose filenames expected across Docker/Pi Apps (`docker-compose.yml`, `compose.yml`, and `compose.yaml`) and removed the required local env-file dependency so fresh installations do not fail before startup. Pi Apps packaging documentation and regression coverage now check the root-level compose layout at a Windows-style directory containing spaces.

## Changed files

- `.dockerignore`
- `Dockerfile`
- `README.md`
- `compose.yaml`
- `config/solohost.env.example`
- `config/solohost.json`
- `config_options.yml`
- `compose.yml`
- `docker-compose.yml`
- `docs/AI-PANEL-KNOWLEDGE.md`
- `docs/DEPLOYMENT-SOLOHOST.md`
- `docs/UPGRADE.md`
- `docs/reports/PUBLISH-UPDATE-APP-MANAGEMENT-IMPLEMENTATION.md` (this report)
- `lib/admin-sessions.js` (new)
- `lib/network-address.js` (new)
- `lib/settings.js`
- `module/INTEGRATE_ONCE.md`
- `package.json`
- `public/admin-app-selector.js` (new)
- `public/admin.html`
- `server.js`
- `tests/admin-app-selector.test.js` (new)
- `tests/admin-sessions.test.js` (new)
- `tests/admin-ui-syntax.test.js` (new)
- `tests/network-address.test.js` (new)
- `tests/startup.test.js`

The settings, deployment, integration, and Docker-ignore changes are directly related to the setup/HTTPS security findings and preventing secret/runtime files from entering the Docker build context. No unrelated application behavior was intentionally changed.

## Verification evidence

| Check | Result |
|---|---|
| `npm test` | Passed: all 61 Node test cases; existing AI-discovery, insights, and AI-kernel self-tests also passed. The script runs JavaScript syntax checks, including the added admin code. |
| `npm ls --depth=0` | Passed; the project declares no top-level npm dependencies. |
| `git -c core.whitespace=cr-at-eol diff --check` | Passed; the repository uses CRLF working files. |
| Browser admin smoke test | Passed for setup, app creation/selection, update publication, notice draft creation, app switching/state clearing, and browser back navigation. |
| Docker Compose configuration | Passed for all three synchronized root-level compose filenames without creating an env file or exposing operator secrets. |
| SoloHost password bootstrap | Passed startup/login regression tests for persisted salted-hash provisioning, no overwrite/re-setup, invalid-input startup failure, and subsequent login. |
| Pi Apps compose path | Passed regression checks for root-level compose aliases, no missing generated env file, and a package path containing `Pi Network` spaces; `docker compose -f docker-compose.yml config --quiet` also passed from that spaced path. |
| Docker image build | Passed with Docker Engine 29.9.2. |
| Container startup and readiness | Passed; HTTP health returned 200 and Docker reported `healthy`. The configured install password provisioned first admin login; wrong password was rejected (401), correct password accepted (200), and first-time setup was disabled. The isolated container, temporary image, and data directory were removed. Separate setup-listener verification confirmed the normal Docker app port rejects setup despite a spoofed loopback header, while the host-loopback-only port supports fallback setup and disables it after password creation. |
| Source ZIP | Passed: 133 required/source files, CRC integrity and required-file checks; excludes secrets, runtime data, databases, `.git`, `node_modules`, and temporary files. |

No separate dependency-advisory scan was run: there is no lockfile and `npm ls --depth=0` reports no declared dependencies. Repository security regression tests cover authentication, tenant isolation, webhook validation, and related API boundaries; this report does not claim a formal external SAST/DAST assessment.

## Security findings and disposition

| Severity | Finding | Disposition |
|---|---|---|
| HIGH (confidence 9/10) | First-time admin password setup could be claimed without operator authorization. | Fixed by requiring the SoloHost install-time admin password secret for remote provisioning, restricting fallback setup to direct loopback peers (or Docker's host-loopback-only setup port), rate-limiting by socket peer, ignoring forwarded-IP headers, and disabling setup once a password is set. |
| MEDIUM (confidence 9/10) | A hard-coded HTTP public URL could expose credentials or public API traffic without TLS in a non-local deployment. | Fixed for fresh installations by removing the insecure URL default and documenting HTTPS/reverse-proxy setup. Existing persisted settings are deliberately not silently rewritten. |

## Partial or unverified work

- No production deployment was performed. On SoloHost, operators must enter the required `ADMIN_INITIAL_PASSWORD` secret in app configuration; the remote Pi app route then presents the normal admin sign-in. Port 8091 is only a loopback fallback and must not be reverse-proxied. Standalone Node setup accepts only direct loopback peers. Deployments reachable beyond localhost must set `PUBLIC_BASE_URL` to HTTPS and terminate TLS at a trusted reverse proxy for normal use.
- An existing deployment with a previously persisted HTTP public URL must update that setting explicitly after backing up its data. It is not automatically migrated.
- Browser interaction was smoke-tested at a desktop viewport; a separate mobile-device/manual accessibility review was not performed. The existing responsive layout was retained.
- No formal external SAST/DAST or third-party dependency advisory scan was available for this dependency-free, lockfile-free package.

## Deployment and rollback notes

Configure the required `ADMIN_INITIAL_PASSWORD` as a secret through Pi Apps, or set it in an operator-only project `.env` for direct Compose deployments. On first boot the server stores only the salted hash; the Pi app's primary URL then presents admin sign-in. Keep standalone fallback setup loopback-only, set the canonical HTTPS `PUBLIC_BASE_URL` for exposed deployments, retain a persistent writable `/app/data` volume, and use the existing Docker Compose flow documented in `docs/DEPLOYMENT-SOLOHOST.md`. Do not commit runtime `.env` values.

The changes do not rewrite existing database records or add migrations. Back up the existing `data/` directory before deploying and use the previous application image/source plus that backup if rollback is required.
