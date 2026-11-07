# Release acceptance evidence — 2026-11-01

## Result

Source and automated acceptance checks pass for the requested feedback, notice, provider-neutral fee ledger, and Pi integration stages. Docker image build and isolated container health checks pass. The release remains externally unverified for actual Pi Sandbox transactions, deployment on SoloHost, production TLS/secrets, and independent security/accessibility review.

The audit checkpoint is baseline commit `0aae105e8341964a28ea9a3a0188a695549847b4`, recorded before source changes. The implementation is currently in the worktree and has not been committed or published.

## Automated checks

- `npm test` — PASS: all syntax checks; 23 AI-discovery checks; 28 insights/donation checks; 27 AI-kernel self-checks; 57 Node tests; zero failures, skips, or todos.
- The same `npm test` command was rerun from the extracted release ZIP — PASS with the same results.
- The test suite covers feedback and customer-token tenant isolation, notice draft/preview/approval/publish and history, provider-neutral order idempotency and audit immutability, provider amount/reference validation, mock settlement gating, Pi identity/payment binding, authoritative completion, interrupted completion recovery, cancellation, fee-order reconciliation, connector HTTP behavior, and signed-webhook replay/security behavior.
- `git -c core.whitespace=cr-at-eol diff --check` — PASS.
- JSON-import dry-run and Compose parsing had passed during the baseline audit; see the repository's existing migration and startup tests.

## Container checks

- `docker compose config -q` — PASS. Docker reports three supported Compose filenames and selects `compose.yaml`; commands should continue specifying `-f compose.yaml`.
- `docker compose build` — PASS.
- An isolated container using a temporary data directory — PASS: HTTP readiness returned `ok`, Docker health reached `healthy`, and all 11 numbered migrations applied. The test container and temporary data were removed afterward.
- The isolated container check does not exercise the tracked operator environment file, real TLS/reverse proxy, actual SoloHost deployment, or persistent-volume recreation on the target host.

## Payment and QR verification

- Official Pi documentation was checked for the [U2A payment flow](https://developers.minepi.com/docs/accept-payment/Payments), [Client SDK](https://developers.minepi.com/docs/api-reference/SdkReference), [Platform API](https://developers.minepi.com/docs/api-reference/PlatformAPI), and [Testnet/Sandbox boundary](https://developers.minepi.com/docs/concepts/MainVsTest).
- The implementation uses the official browser Pi SDK flow in the connector sample and the documented server-side `/me`, payment lookup, approval, and completion Platform API calls. The provider-neutral ledger stays separate and records a Pi order as paid only after server-confirmed completion.
- The reviewed official SDK reference documents `Pi.createPayment` and callback-based approval/completion, but no static QR payment or QR-scan verification method. QR navigation may direct a customer to an app, but it is not payment evidence; no static QR is used to mark an order paid.
- Unit/integration tests use a mock Platform client. No real Pi Sandbox transaction, Pi Browser device test, or QR/device behavior was run because authorized app credentials and Sandbox access were not available.

## Release contents and exclusions

The release archive includes source, migrations, tests, setup/API/Pi integration documentation, acceptance evidence, and `config/solohost.env.example`. It excludes `.git`, local `data/`, `node_modules`, build outputs, release artifacts, and the tracked runtime-specific `config/solohost.env`; no runtime key or token is packaged.

The service delivery gate is `service_delivery_allowed`, which remains false unless the Pi session has authoritative `completed` / `verified` state and, when linked, the fee ledger order is `paid` / `verified`.
