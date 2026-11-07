#!/bin/sh
# Embedded Caddy HTTPS gateway — self-signed cert for IP/LAN (reliable) + optional ACME hostname.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
PORT="${PORT:-8090}"
SETUP_PORT="${SETUP_PORT:-}"
HTTPS_GATEWAY="${HTTPS_GATEWAY:-1}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
export LISTEN_HOST="${LISTEN_HOST:-0.0.0.0}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${SHFH_HUB_URL:-}}"
CADDY_EMAIL="${CADDY_EMAIL:-}"
CADDY_DATA_DIR="${CADDY_DATA_DIR:-$DATA_DIR/caddy}"
CADDY_CONFIG="${CADDY_CONFIG:-$DATA_DIR/Caddyfile}"
CERT_DIR="${CADDY_DATA_DIR}/certs"
CERT_FILE="${CERT_DIR}/server.crt"
KEY_FILE="${CERT_DIR}/server.key"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/integration/health"
APP_PID=""
CADDY_PID=""

log() { echo "[gateway] $*"; }

cleanup() {
  log "shutdown"
  if [ -n "${CADDY_PID}" ] && kill -0 "${CADDY_PID}" 2>/dev/null; then
    kill "${CADDY_PID}" 2>/dev/null || true
    wait "${CADDY_PID}" 2>/dev/null || true
  fi
  if [ -n "${APP_PID}" ] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

mkdir -p "${DATA_DIR}" "${CADDY_DATA_DIR}" "${CERT_DIR}"

if [ "${HTTPS_GATEWAY}" = "0" ] || [ "${HTTPS_GATEWAY}" = "false" ]; then
  log "HTTPS gateway disabled — starting Node only on ${LISTEN_HOST}:${PORT}"
  exec node /app/server.js
fi

export XDG_DATA_HOME="${CADDY_DATA_DIR}"
export XDG_CONFIG_HOME="${CADDY_DATA_DIR}/config"
export HOME="${CADDY_DATA_DIR}"

log "starting backend on ${LISTEN_HOST}:${PORT}"
node /app/server.js &
APP_PID=$!

i=0
backend_ok=0
while [ "${i}" -lt 90 ]; do
  if node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "${HEALTH_URL}" 2>/dev/null; then
    log "backend healthy at ${HEALTH_URL}"
    backend_ok=1
    break
  fi
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    log "backend exited early"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "${backend_ok}" != "1" ]; then
  log "backend health not ready after timeout — keeping process"
fi

# Derive IP/host for certificate SAN from PUBLIC_BASE_URL or PUBLIC_HOSTNAME
CERT_HOST="${PUBLIC_HOSTNAME}"
if [ -z "${CERT_HOST}" ] && [ -n "${PUBLIC_BASE_URL}" ]; then
  CERT_HOST=$(printf '%s' "${PUBLIC_BASE_URL}" | sed -E 's#^[a-zA-Z]+://##' | cut -d/ -f1 | cut -d: -f1)
fi
if [ -z "${CERT_HOST}" ]; then
  CERT_HOST="localhost"
fi

# Build SAN: DNS + IP when host looks like IPv4
SAN="DNS:localhost,DNS:127.0.0.1"
case "${CERT_HOST}" in
  *[a-zA-Z]*)
    SAN="${SAN},DNS:${CERT_HOST}"
    ;;
  *)
    SAN="${SAN},IP:${CERT_HOST},DNS:${CERT_HOST}"
    ;;
esac

need_cert=1
if [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
  need_cert=0
fi

if [ "${need_cert}" = "1" ]; then
  log "generating self-signed cert for SAN=${SAN}"
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 \
      -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
      -days 3650 -nodes \
      -subj "/CN=${CERT_HOST}" \
      -addext "subjectAltName=${SAN}" 2>/dev/null \
    || openssl req -x509 -newkey rsa:2048 \
      -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
      -days 3650 -nodes \
      -subj "/CN=${CERT_HOST}"
  else
    log "openssl missing — falling back to tls internal"
  fi
fi

if [ -n "${PUBLIC_HOSTNAME}" ] && [ -n "${CADDY_EMAIL}" ]; then
  # Public ACME path
  cat > "${CADDY_CONFIG}" <<EOF
{
  admin off
  auto_https off
  storage file_system {
    root ${CADDY_DATA_DIR}
  }
  servers {
    protocols h1 h2
  }
}

${PUBLIC_HOSTNAME}:${HTTPS_PORT} {
  tls ${CADDY_EMAIL}
  encode gzip
  reverse_proxy ${BACKEND_HOST}:${PORT}
}
EOF
  log "Caddyfile: ACME for ${PUBLIC_HOSTNAME}"
elif [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
  cat > "${CADDY_CONFIG}" <<EOF
{
  admin off
  auto_https off
  storage file_system {
    root ${CADDY_DATA_DIR}
  }
  servers {
    protocols h1 h2
  }
}

:${HTTPS_PORT} {
  tls ${CERT_FILE} ${KEY_FILE}
  encode gzip
  reverse_proxy ${BACKEND_HOST}:${PORT}
}
EOF
  log "Caddyfile: file cert ${CERT_FILE} (host=${CERT_HOST})"
else
  cat > "${CADDY_CONFIG}" <<EOF
{
  admin off
  auto_https off
  storage file_system {
    root ${CADDY_DATA_DIR}
  }
  servers {
    protocols h1 h2
  }
}

:${HTTPS_PORT} {
  tls internal
  encode gzip
  reverse_proxy ${BACKEND_HOST}:${PORT}
}
EOF
  log "Caddyfile: tls internal fallback"
fi

log "starting Caddy on :${HTTPS_PORT}; HTTP app on :${PORT}"
sed 's/^/[caddyfile] /' "${CADDY_CONFIG}" || true

if caddy validate --config "${CADDY_CONFIG}" --adapter caddyfile 2>&1 | sed 's/^/[caddy-validate] /'; then
  log "Caddyfile validated"
else
  log "Caddyfile validate warning — trying run anyway"
fi

if caddy run --config "${CADDY_CONFIG}" --adapter caddyfile & then
  CADDY_PID=$!
  sleep 1
  if kill -0 "${CADDY_PID}" 2>/dev/null; then
    log "Caddy running pid=${CADDY_PID}"
  else
    log "Caddy exited immediately — HTTP remains on :${PORT}"
    CADDY_PID=""
  fi
else
  log "Caddy failed to start — HTTP remains on :${PORT}"
  CADDY_PID=""
fi

caddy_fails=0
while true; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    log "backend stopped"
    exit 1
  fi
  if [ -n "${CADDY_PID}" ] && ! kill -0 "${CADDY_PID}" 2>/dev/null; then
    caddy_fails=$((caddy_fails + 1))
    log "Caddy stopped (fail=${caddy_fails}) — HTTP :${PORT} still up"
    if [ "${caddy_fails}" -lt 5 ]; then
      sleep 2
      if caddy run --config "${CADDY_CONFIG}" --adapter caddyfile & then
        CADDY_PID=$!
      else
        CADDY_PID=""
      fi
    else
      CADDY_PID=""
      log "Caddy disabled after failures; HTTP only on :${PORT}"
    fi
  fi
  sleep 3
done
