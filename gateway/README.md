# Embedded Caddy HTTPS Gateway

SoloHost Feedback Hub ships Caddy inside the same Docker image.

## Flow

```
Client → HTTPS (:8443, map host 443 if needed) → Caddy → HTTP 127.0.0.1:8090 → Node
```

## Defaults

| Setting | Default | Notes |
|---|---|---|
| `HTTPS_GATEWAY` | `1` | Set `0` for legacy Node-only mode |
| `HTTPS_PORT` | `8443` | Non-root safe; compose can map `443:8443` |
| `HTTP_PORT` | `8080` | Redirect helper to HTTPS |
| `LISTEN_HOST` | `127.0.0.1` when gateway on | Backend not exposed publicly |
| TLS | `tls internal` | Works offline; clients must trust Caddy local CA |
| Public ACME | optional | Set `PUBLIC_HOSTNAME` + `CADDY_EMAIL` |

## Certificate storage

Persistent under `DATA_DIR/caddy` (compose volume `./data`). Survives restarts and upgrades.

## Limits

- Public Let's Encrypt needs reachable hostname and ports 80/443 as required by ACME.
- IP-only public certs depend on CA support; default is internal CA for SoloHost LAN/IP.
- Non-root containers cannot bind 443 without `CAP_NET_BIND_SERVICE`; default uses 8443.

## Disable gateway

```yaml
environment:
  HTTPS_GATEWAY: "0"
  LISTEN_HOST: "0.0.0.0"
```
