# SoloHost deployment and recovery

## Requirements and secrets

- Node.js 24.15 or later for local execution; Docker uses the repository's Node 24 Alpine image.
- Writable persistent storage for `/app/data` (SQLite database, WAL, attachments, settings, and imported legacy JSON).
- TLS termination in front of owner login, application credentials, and Pi configuration. The owner session cookie is `Secure`.
- During Pi Apps configuration, enter a strong password in the required **Admin login password** secret option. Compose passes `ADMIN_INITIAL_PASSWORD` to the server for first boot; it is consumed only if no admin password exists, validated at 6–200 characters, hashed with scrypt, persisted in `settings.json`, and removed from the server process environment. Subsequent restarts never replace the saved password from this option. The app's normal admin login page then accepts the configured password. If the option is not supplied in a standalone install, initial setup remains loopback-only, rate-limited and disabled after password creation; forwarded-IP headers are ignored.
- `HUB_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64url. Generate using `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Keep it in SoloHost's secret store or `config/solohost.env`, outside source control. Back it up securely and preserve it across restarts. It encrypts per-app webhook and Pi Platform API secrets. If this key is lost, those secrets cannot be decrypted; re-entering them rotates them. There is no automated master-key rotation migration yet.
- Set `PUBLIC_BASE_URL` to the canonical HTTPS deployment URL. Fresh installations no longer fall back to an insecure public HTTP endpoint; existing persisted URLs are not rewritten.
- `INGEST_TOKEN` and AI settings continue to use their current configuration mechanisms. No email/Telegram credentials are required for local or in-app notification delivery.
- `FEE_MOCK_PAYMENTS`: leave unset or `false` in production. Set it to `true` only for isolated development/acceptance environments; the mock settlement API also requires the app credential's `fees:simulate` scope.

## Local startup

From the repository root:

```sh
node server.js
```

For Pi Apps, enter the first password in the required secret option during app configuration, then open the app's primary URL and sign in with that password. The separate Docker loopback setup listener remains bound to host `127.0.0.1:8091`; it is not exposed by the Pi app's primary route. Standalone Node deployments with no configured install password accept setup on `PORT` (default `8090`) only from a direct loopback TCP peer. Do not expose a setup listener through a reverse proxy. Use HTTPS for any normally exposed service. Set `PORT` and `DATA_DIR` in the environment to override standalone defaults. Schema migrations run in numbered order during startup. The legacy JSON importer is non-destructive and repeatable. Use `npm run migrate:json -- --dry-run` to inspect counts before importing a separate data directory; it does not delete source JSON.

Check readiness with `GET http://localhost:8090/api/v1/integration/health`. The owner dashboard is `/owner`; customer tracking is `/feedback/track`; the existing public feedback form is `/feedback`.

## Docker Compose

`compose.yaml` uses `./data:/app/data`, runs as the unprivileged `node` user, drops Linux capabilities, enables `no-new-privileges`, and does not mount the Docker socket or use host networking. The image exposes port `8090` internally. Set `HOST_PORT` in `.env` for the host mapping. Copy `config/solohost.env.example` to the project root as `.env`, or set the same values through SoloHost environment/secret settings (especially `PUBLIC_BASE_URL` and `HUB_ENCRYPTION_KEY`); do not commit `.env` or secret values. Compose passes configured values via environment interpolation; it does not require `config/solohost.env` to exist.

Pi Apps expects `docker-compose.yml` in the installed application directory root. The source package keeps that filename at its root (not nested under an extra source folder); `docker-compose.yml`, `compose.yml`, and `compose.yaml` are kept synchronized. Compose receives configured values through environment interpolation, so a fresh install does not fail because a local env file has not been created.

```sh
docker compose -f compose.yaml config
docker compose -f compose.yaml build
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 feedback-hub
```

On SoloHost, configure the same container port, environment variables, and persistent data mount in its deployment interface. Ensure the mount is writable by the image's unprivileged UID. Use an HTTPS reverse proxy for owner sessions and payment handoff callbacks. Pi SDK code belongs in the connected Pi Browser frontend; a Docker backend must not execute it.

Health check:

```sh
curl -fsS http://localhost:8090/api/v1/integration/health
```

Docker's image health check calls that route inside the container. It checks local application/database readiness, not external Pi API or webhook reachability.

## Backup and restore

Stop the app before copying the database directory so SQLite WAL content remains consistent:

```sh
docker compose -f compose.yaml stop feedback-hub
cp -a data "data-backup-$(date +%Y%m%d-%H%M%S)"
docker compose -f compose.yaml start feedback-hub
```

Include `data/` and a separately protected copy of `HUB_ENCRYPTION_KEY` in the recovery plan. Restore by stopping the service, moving the current directory to a retained recovery name, restoring the full backup directory to `data/`, restoring the matching encryption key, and starting the same or a compatible newer build. Verify health, migration version, and record counts before retiring any backup. Never restore a database without its matching encryption key if encrypted secrets are needed.

## Troubleshooting

- Startup migration errors fail closed; inspect the sanitized logs and database permissions before retrying.
- A `WEBHOOKS_DISABLED` or `PI_PAYMENTS_DISABLED` response means the master encryption key is not configured. A malformed key fails startup when secret encryption is initialized.
- Email and Telegram channels require an injected provider adapter; default startup only dispatches in-app notifications. Without a provider, external deliveries enter bounded retry and then failed state with safe error codes.
- SQLite is intended for a single service instance on one local persistent volume, not multiple replicas sharing a network filesystem.
- If Docker reports that it cannot connect to the Engine named pipe/socket, Compose parsing alone does not prove build or runtime. Start the authorized Docker Engine and rerun the build, container health, persistent restart, and HTTP checks.

## Pi configuration and Sandbox verification

The shared Hub owner/admin configures each app's Pi Developer App ID, network, and Server API key from **Pi payments**; separate owner logins are not required. The Hub uses the encrypted server key only from its backend. The Pi-enabled frontend must use the matching official Pi app configuration. Follow [Pi payment integration](PI-INTEGRATION.md). Automated tests use mocks; this repository session has not performed a real Pi Sandbox transaction. Before using a connected app commercially, the operator must run and verify the official testnet/Sandbox approve, user-sign, complete, interrupted-payment recovery, and webhook flow using that app's authorized Developer App configuration.
