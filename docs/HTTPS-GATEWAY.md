# Embedded Caddy HTTPS Gateway

## Architecture

**Before:** Client → HTTP :8090 → Node

**After (default):** Client → HTTPS :8443 → Caddy → HTTP 127.0.0.1:8090 → Node

Optional HTTP :8080 redirects to HTTPS.

## Enable / disable

- `HTTPS_GATEWAY=1` (default in image): gateway on
- `HTTPS_GATEWAY=0`: legacy Node-only on `LISTEN_HOST` (set `0.0.0.0`)

## Caddyfile note

When no hostname is set, global `auto_https off` avoids catch-all automation policy conflicts between `:8443` (tls internal) and `:8080` (redirect).

## Certificates

- Default: Caddy **internal CA** (works offline / LAN / public IP without ACME)
- Public ACME: set `PUBLIC_HOSTNAME` and `CADDY_EMAIL` (requires inbound reachability)
- Storage: `$DATA_DIR/caddy` (persistent volume)

Clients using internal CA must trust Caddy’s local root once.

## Ports

| Port | Role |
|------|------|
| 8443 | HTTPS (map host 443→8443 if desired) |
| 8080 | HTTP redirect helper |
| 8090 | Backend (bound 127.0.0.1 when gateway on) |
| 8091 | Setup (unchanged policy) |

## Status

`GET /api/v1/integration/health` includes `data.https` with gateway and certificate mode.

## Security

- No Docker socket, no privileged
- Backend not published when gateway mode binds 127.0.0.1
- Forwarded headers set by Caddy only

## Rollback

Set `HTTPS_GATEWAY=0` and `LISTEN_HOST=0.0.0.0`, rebuild/restart.


## CI / smoke tests

Port **8090** remains the primary health target. Caddy failures must not stop the Node process so image smoke tests can pass.

## IP-only deployments (no PUBLIC_HOSTNAME)

Only **one** catch-all site is generated (`:8443` with `tls internal`).
The `:8080` redirect site is omitted on purpose — two hostname-less sites conflict in Caddy cert automation.

Use:
- `http://IP:8090` — primary app URL
- `https://IP:8443` — HTTPS (trust internal CA in browser)

SoloHost compose must publish host port **8443** (or map 443→8443).
