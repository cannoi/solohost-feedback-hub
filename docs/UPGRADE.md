# Upgrade and deployment guide

## Runtime and configuration

- Node.js **24.15 or newer** is required. The prior Node 20 runtime reached end of life; do not deploy this build on Node 20.
- Default port: `8090`. `HOST_PORT` controls the published host port in Compose; the container listens on `8090`.
- Runtime data directory: `data/` locally or `/app/data` in the container. It contains `feedback-hub.sqlite`, SQLite WAL/SHM files while active, and legacy JSON source files retained as migration backups.
- Compose reads project-root `.env` values for interpolation; the file is optional. Do not bake it into a container image or publish it. Set `HUB_ID`, the canonical HTTPS `PUBLIC_BASE_URL`, `INGEST_TOKEN` if the legacy ingest route needs a shared token, and any optional AI/donation settings there, or configure them through SoloHost environment/secret settings. No default ingest secret is supplied by the server.
- Pi Apps asks for the required **Admin login password** secret during application configuration. Compose passes it as `ADMIN_INITIAL_PASSWORD`; first boot hashes and stores it only when no password already exists, then removes it from the server process environment. Existing passwords are never overwritten. Without this option, standalone first setup is only available from a direct loopback peer and never trusts forwarded-IP headers. Docker Compose's fallback setup port is host-loopback-only.

## Existing JSON installations

1. Stop the existing container before backing up data so all JSON writes have finished.
2. Copy the complete existing `data/` directory to a dated backup. Do not overwrite the source JSON.
3. Preview import counts:

   ```powershell
   $env:DATA_DIR = (Join-Path $PWD 'data')
   npm run migrate:json -- --dry-run
   Remove-Item Env:DATA_DIR
   ```

4. Import with Node 24.15+:

   ```powershell
   $env:DATA_DIR = (Join-Path $PWD 'data')
   npm run migrate:json
   Remove-Item Env:DATA_DIR
   ```

5. Start the service. Startup runs the same idempotent importer automatically; imported data is not duplicated. If a source JSON file is malformed or has duplicate IDs, migration exits without partial writes; fix the source using the backup and rerun.
6. Original JSON remains unchanged as a recovery source. Once SQLite is active, new writes go to SQLite; copying old JSON back over the running data directory does not roll back the database.

Legacy payment rows are imported as `legacy_unverified`. Previous client-supplied “confirmed” values are not treated as Pi verification or completed settlement.

## Local startup

```powershell
npm test
$env:DATA_DIR = (Join-Path $PWD 'data')
npm start
```

In Pi Apps, provide the password at the required secret prompt during app configuration, start the app, then sign in through its primary app URL with that password. The Docker fallback setup listener (`127.0.0.1:8091`) remains host-loopback-only and is not the remote onboarding path. Standalone Node without a configured password only permits setup over a direct loopback TCP connection. A reverse proxy or forged forwarded-IP header cannot authorize setup. Use HTTPS through a reverse proxy for normal app use. Check `http://127.0.0.1:8090/api/v1/integration/health` for Docker health. `npm test` retains the original AI and insights checks and includes the SQLite, migration, API, and startup tests.

## Admin updates and application management

The admin update and notification forms use selectors populated from the managed application registry. Only applications with approved integration state and `active` registry status can be selected for new publications or notices; the server repeats this check and resolves `app_name` from SQLite rather than trusting browser-supplied names. The update endpoint continues to accept the legacy `app_id`, `version`, and `notice` fields; `release_notes` is additionally retained, and raw notes can supply the short notice when one was not entered. The public update response continues to include the SDK-compatible `notice`, `version`, `release_url`, and publication flag.

Selecting a managed app opens its scoped feedback, notice history, update history, and existing action forms in one view. Query/mutation calls from that view include the selected `app_id`, and stale responses are discarded when the selected app changes. Existing database records are not rewritten; the SQLite application registry remains the source of display names and status.

Admin login passwords are preserved exactly as entered, including leading/trailing spaces. Initial setup accepts 6–200 characters; login accepts 1–200 characters. After the first password is set, sign in with that password; initial setup cannot be repeated.

## Docker Compose / SoloHost

Copy the project files to the SoloHost app directory, optionally create project-root `.env` with operator-owned settings, and keep `data/` on persistent storage. Set the optional host port there (`HOST_PORT=8090`). Then run:

```sh
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 feedback-hub
```

The image runs as the unprivileged `node` user, uses `/app/data`, drops Linux capabilities, enables `no-new-privileges`, does not use host networking or the Docker socket, and includes an HTTP readiness check. The app port is `8090` in-container. Allow the container UID to write to the persistent data mount. No Pi payment credential is currently needed or consumed by this foundation release.

## Health and troubleshooting

- Health endpoint: `GET /api/v1/integration/health`.
- If the service exits before listening, inspect logs for malformed JSON, duplicate IDs, database path permissions, or a failed migration. It intentionally fails closed rather than serving a partially migrated database.
- `docker compose ps` should show `healthy` after startup; Compose may emit a warning because both `compose.yaml` and `compose.yml` exist. Docker uses `compose.yaml` by default.
- If the database is locked, stop duplicate app instances and inspect that only one Hub process writes the database. SQLite is intended for one service instance, not a multi-replica shared volume.

## Backup and recovery

For a consistent file-copy backup, stop the app first:

```sh
docker compose stop feedback-hub
cp -a data "data-backup-$(date +%Y%m%d-%H%M%S)"
docker compose start feedback-hub
```

Keep the entire data directory so the database and any WAL files stay together. To restore, stop the app, preserve the current directory separately, restore the backup directory to `data/`, then start the same compatible app version. Verify the health endpoint and key counts before removing any backup. The project checkpoint `.checkpoints/feedback-hub-baseline-2026-10-31.zip` is source/baseline recovery, not a substitute for deployment data backups.

## Current integration boundaries

The current continuation adds tenant-scoped customer feedback tracking and attachments, owner accounts and dashboards, durable in-app notifications, signed webhook delivery, and a server-side Pi payment workflow backed by the official Platform API shape. See `docs/reports/PUBLISH-UPDATE-APP-MANAGEMENT-IMPLEMENTATION.md` for the latest admin and Docker verification, and `docs/reports/REMAINING-BLOCKERS.md` for external deployment and Pi Sandbox requirements. The Docker image, isolated container startup, and HTTP health check have been verified locally; deployment on the target SoloHost and real Pi Sandbox verification have not. Do not treat the payment module as production-ready until an operator verifies the authorized Sandbox flow and configures production credentials securely. Existing wallet donation information remains separate from Pi Platform payments.
