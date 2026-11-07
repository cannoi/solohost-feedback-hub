# Local ZIP Upgrade Report — 2026-10-31

## Scope
Applied focused edits to the uploaded v2.5.1 source archive. No unrelated backend/payment behavior was intentionally changed.

## Completed
- Removed the duplicate `Application owner` link from `public/admin.html`.
- Replaced the corrupted Vietnamese translation dictionary and repaired visible encoding artifacts in `public/owner.html`; kept UTF-8 and the existing language-selection mechanism.
- Added an explicit visible FAB styling override for the AI Panel in `public/admin.html` so global admin button rules cannot hide it. Existing AI Panel markup and controller remain in place.
- Updated `lib/app-adapter.js` app knowledge to include the owner dashboard, current feature boundaries, and safer secret handling.
- Added `docker-compose.yml` as a compatibility copy of the existing `compose.yaml`.
- Added `config_options.yml` with non-secret app metadata and a server-side secret option. Its exact schema still needs confirmation against the target SoloHost version.
- Synchronized the non-secret Hub ID and public base URL in `config/solohost.env` with the existing server defaults. No ingest token was embedded.

## Tests
- `npm test`: 48/48 Node test cases passed; AI discovery/insights and AI kernel self-tests passed.
- Static checks: exactly one Application owner link; owner page contains the corrected Vietnamese language label; no common mojibake markers remain in `public/owner.html`.
- Docker build/start, browser interaction, Pi Sandbox, and target SoloHost installation were not run in this environment. The repository declares Node >=24.15; available runtime was Node 22.16.0, so the successful test run is useful but not a full supported-runtime release validation.

## Not completed / remaining verification
- AI Panel visibility and chat were not verified in a real browser; the source already contained its markup and scripts. The visibility override is a focused mitigation, not proof of runtime behavior.
- `config_options.yml` has not been validated against the actual SoloHost schema/version; confirm before production deployment.
- No live Pi payment was performed. Existing payment tests are automated tests, not proof of a real Pi Sandbox transaction.
- No Docker image was built or started.
- No ingest token is included. Rotate any token exposed in chat and configure a fresh scoped credential server-side.
