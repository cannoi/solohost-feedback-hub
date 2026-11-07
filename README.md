# SoloHost Feedback Hub

Feedback Hub is a self-hosted, SQLite-backed integration hub for connected apps. The existing public feedback site and AI features remain available. New capabilities include tenant-scoped feedback management, customer follow-up, attachments, owner accounts, durable in-app notifications, signed webhooks, app-scoped APIs, and a mocked/tested Pi U2A payment workflow.

**Status:** This workspace implements and tests the core flows, but it is not yet a production-verified Pi payment service or a fully commercial SaaS package. See the [publish and app-management implementation report](docs/reports/PUBLISH-UPDATE-APP-MANAGEMENT-IMPLEMENTATION.md), the [final implementation report](docs/reports/FINAL-IMPLEMENTATION-REPORT.md), and [remaining blockers](docs/reports/REMAINING-BLOCKERS.md).

## Run locally

Requires Node.js 24.15 or later.

For Pi Network SoloHost installs, enter the required **Admin login password** in the app configuration prompt before starting the app. Compose passes it to the server for first boot; the server immediately hashes and persists it, removes it from its process environment, and does not permit the value to overwrite an existing password. If this option is not configured in a standalone/local installation, use the direct loopback setup page (`127.0.0.1`); remote setup requests are rejected and forwarded-IP headers are ignored. For deployments exposed beyond localhost, set the public URL to HTTPS and terminate TLS at the reverse proxy.

```sh
node server.js
npm test
```

Default local port is `8090`. SQLite lives under `data/`; set `PORT` and `DATA_DIR` to override. Numbered migrations run on startup. Legacy JSON import retains the source files and can be inspected using `npm run migrate:json -- --dry-run`.

## Main pages

- Admin and existing public application: `/admin`, `/`, `/feedback`
- App owner dashboard: `/owner`
- Customer feedback tracking portal: `/feedback/track`
- Readiness endpoint: `/api/v1/integration/health`

## Integration and deployment

- [REST API v1](docs/API-v1.md)
- [Pi payment workflow and Sandbox boundary](docs/PI-INTEGRATION.md)
- [SoloHost Docker deployment, backup, and recovery](docs/DEPLOYMENT-SOLOHOST.md)
- [Runnable SoloHost connector sample](examples/solohost-connector/README.md)
- [Upgrade and migration notes](docs/UPGRADE.md)

For encrypted webhook and per-app Pi server credentials, configure a persistent 32-byte base64url `HUB_ENCRYPTION_KEY` in the operator secret store. Keep it outside Git and preserve it with backups. Do not place application credentials or Pi tokens in browser code.

## Docker

```sh
docker compose -f compose.yaml config
docker compose -f compose.yaml build
docker compose -f compose.yaml up -d
```

Compose mounts `./data` persistently at `/app/data`, runs the Node image as an unprivileged user, and includes an HTTP health check. Docker build/start were not verified in the current restricted environment; see the report for evidence and operator commands.
