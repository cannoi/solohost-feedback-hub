# Universal AI Panel — Feedback Notices

## This app's panel flow

- The browser uses `UniversalFeedback.create({ onUnread, onSync })`.
- Initial sync and periodic refresh (60 seconds while the page is visible) call `GET /api/feedback/sync?anonymous_id=...`.
- `sync.notices` drives the robot badge. The badge is hidden when the unread count is zero.
- Notice read actions call `POST /api/feedback/read/:id` with the anonymous ID.
- Donation details are rendered only from `sync.donate`; no wallet or bank details are hard-coded in the client.
- The panel feedback form calls `POST /api/feedback/panel-submit`. This local endpoint is rate-limited and stores feedback in the Hub.

## Why the panel uses a separate submit route

`POST /api/feedback` is the existing app-client ingest endpoint. Reusing it from the browser would either require exposing an ingest credential or cause the panel's request to collide with the protected client-ingest flow. The panel therefore uses `/api/feedback/panel-submit`; the original `/api/feedback` API remains available to app clients.

## Credentials

- Never place an ingest token in HTML, browser JavaScript, public configuration, or AI prompts.
- `INGEST_TOKEN` is a server-side secret for authenticating incoming app-client submissions.
- `SHFH_INGEST_TOKEN` is an optional server-side credential only when connecting to a separate upstream Hub. The local panel flow does not need it.
- Rotate any credential previously pasted into chat or committed to a file.

## Public config

`GET /api/feedback/config` returns non-secret metadata only: enabled, Hub ID, app ID, app name, and version. It must never return an ingest token.

## AI Panel

The single robot button opens Chat, Feedback, Settings, and Logs. Chat uses the local app guide when no provider is configured. Provider keys are stored server-side and masked in settings responses. AI settings and logs require an administrator session; public users can use the configured assistant but cannot change shared provider credentials.
