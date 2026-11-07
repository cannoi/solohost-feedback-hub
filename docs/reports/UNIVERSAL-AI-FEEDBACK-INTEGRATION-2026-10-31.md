# Universal AI + Feedback Integration — Release Report

Date: 2026-10-31
Base archive: `solohost-feedback-hub-v2.5.1-upgraded.zip`
Release version field: retained at 2.5.1

## Completed

- Normalized the existing Universal AI module integration while retaining its CommonJS `.cjs` bridge for the host app's ESM runtime.
- Fixed the Feedback Panel submission collision: browser panel submissions now use `POST /api/feedback/panel-submit`; the existing app-client `POST /api/feedback` ingest endpoint remains unchanged.
- Added server-side validation/rate limiting for panel submissions and local, app-scoped notice-read handling.
- Made panel sync use the Hub's local data/settings, avoiding a request back to the configured public IP from inside the same container.
- Kept Hub ID and public base URL as non-secret defaults and environment overrides.
- Kept ingest credentials out of source and browser code. Added documented server-side secret options only.
- Restricted shared AI settings, model refresh, provider test, and logs to an administrator session. Added a public AI chat rate limit.
- Added English/Vietnamese language selection to the panel, with browser/local preference detection, translated panel controls/statuses, and language-matched offline replies.
- Removed the behavior that cleared unread count merely by opening the Feedback tab; unread count now decreases when a notice is marked read.
- Added 60-second panel notice sync while the page is visible.
- Updated the AI Panel knowledge source at `docs/AI-PANEL-KNOWLEDGE.md`; the adapter loads this file at startup so guidance has one maintained source.
- Updated Dockerfile to include `docs/`, required because the adapter loads the knowledge file at runtime.
- Added/updated integration documentation, secret configuration notes, and regression assertions.

## Verification performed

- `npm test`: 48 tests passed, 0 failed (Node 22.16.0 in this environment).
- The startup integration test now checks: public feedback config contains no token, panel submission persists, notices sync and mark-read work, provider catalog includes all ten required providers, offline chat responds, unauthenticated AI settings are rejected, and authenticated settings return a masked key.
- `node --check` passed for server, adapter, and panel/client scripts through the test command.
- `docker-compose.yml` and `config_options.yml` parsed successfully as YAML.
- Static checks confirmed one AI FAB and one overlay per integrated page, correct script order, and no exact pasted ingest-token value in the release source/public assets.

## Not verified in this environment

- Browser-based visual/interaction testing was not run.
- Docker build/container startup and SoloHost installation were not run; Docker commands are unavailable/permission-denied in this environment.
- Pi Sandbox payment testing was not run.
- The project declares Node >=24.15.0; tests passed here on Node 22.16.0, but the target Node 24 Docker runtime still needs deployment verification.

## Scope and forced changes

Only the AI/Feedback integration, its app knowledge, related configuration/docs, and regression tests were changed. The main application workflows and existing client-ingest route were preserved.

The panel submit endpoint differs from the module's generic `/api/feedback` example because this host already uses that route for authenticated app-client ingestion. Keeping a separate local panel endpoint avoids exposing an ingest token in the browser.

The AI settings/log endpoints now require an admin session because they control shared server-side provider credentials and logs. This means public users can chat with the configured assistant but cannot edit shared AI settings.

## Credential action required

The ingest token pasted into the conversation must be considered exposed. Rotate it in SoloHost/server-side secret settings before production use. Do not put the replacement token into source code or the release ZIP.
