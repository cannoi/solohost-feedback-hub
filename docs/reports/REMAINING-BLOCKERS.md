# Remaining blockers and operator verification — 2026-11-01

This is the current external-verification checklist. Automated test and isolated Docker results are recorded in [`RELEASE-ACCEPTANCE-EVIDENCE.md`](RELEASE-ACCEPTANCE-EVIDENCE.md); earlier milestone reports are historical.

## 1. Pi Sandbox/device acceptance — BLOCKED

No live Pi Platform request, Pi Browser user signing, Sandbox approval/completion, or real callback was performed. Automated Pi tests use a mock Platform client. Complete the documented U2A flow with an operator-authorized Developer App and Pi Browser: create/link a fee order; authenticate; verify server-side identity and exact payment binding; approve; complete only after Pi's user-sign flow; repeat callbacks; interrupt and recover completion; reconcile; and verify the signed `payment.completed` webhook. Use only authorized Sandbox/testnet credentials. Do not send API keys or tokens in chat.

**Required access:** operator-owned Pi Developer App, its server-side testnet credential and matching app configuration, and an authorized Pi Browser Sandbox session. Pi credentials must be entered via the owner UI and remain encrypted/server-side.

The official SDK reference documents the `Pi.createPayment` callback flow and server-side Platform API operations, but the reviewed docs do not document static QR payment or QR-scan verification. A QR that opens/navigates to an app is not payment evidence; no static QR path is treated as settlement. Actual device/browser behavior remains unverified.

## 2. SoloHost deployment — TARGET HOST NOT AVAILABLE

Docker image build and an isolated container health/migration check passed locally. This does not verify deployment on the target SoloHost, its ingress, storage permissions, backups, or persistence after recreation.

**Operator action:** deploy the release on the authorized SoloHost host, configure the persistent writable `/app/data` volume and HTTPS ingress, then verify health, logs, record creation, and record retention after container recreation. Use the commands in [`../DEPLOYMENT-SOLOHOST.md`](../DEPLOYMENT-SOLOHOST.md). The service is intended for one process with local persistent storage, not multi-replica SQLite.

## 3. Production secret and TLS setup — OPERATOR CONFIGURATION REQUIRED

The tracked `config/solohost.env` is excluded from Docker build context and the release ZIP. Its values are not copied into this report or package. Set production values using the SoloHost secret manager, especially `HUB_ENCRYPTION_KEY`, and configure HTTPS before exposing owner sessions or payment endpoints. The release includes the blank/placeholder-only `config/solohost.env.example`.

Generate the encryption key securely on the operator's machine:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Back up this key separately from the database and retain it across restarts/restores; encrypted per-app secrets cannot be decrypted without the matching key. Keep `FEE_MOCK_PAYMENTS` unset/false in production. Do not paste credentials into chat, reports, source, or the release archive.

## 4. External delivery — NOT RUN

Email/Telegram transport adapters are not implemented; in-app notifications are implemented, and delivery interfaces are tested with mocks. No real email, Telegram, or public webhook receiver delivery was performed. If external channels are required, choose providers and add their adapters/configuration with operator-owned credentials. Independently test exact-body HMAC, timestamp/replay rejection, duplicate delivery, retry/timeout/5xx, manual retry, and endpoint disablement against an operator-controlled HTTPS receiver.

## 5. Independent security and accessibility review — NOT RUN

Automated tests cover tenant isolation, credential scopes, validation, payment idempotency/reconciliation, and webhook protections. This is not an independent penetration test or full security audit. No dependency vulnerability scan, external security review, browser accessibility audit, or mobile-device layout walkthrough was run. Conduct these against the release build and target deployment before commercial use. Attachment malware scanning and automated master-key rotation are not provided.

## Resume checklist

1. Deploy on the actual SoloHost target with persistent storage, operator-managed secrets, and HTTPS.
2. Execute and retain sanitized evidence for Pi Sandbox and supported Pi Browser flows, including interrupted-payment recovery.
3. Exercise public webhooks against an authorized receiver; configure external notification delivery only if needed.
4. Complete independent security, dependency, accessibility, and mobile reviews.

No credentials are required from the user to finish the local release package; the remaining items require operator-controlled services and access.
