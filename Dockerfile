# SoloHost Feedback Hub — Node app + embedded Caddy HTTPS gateway
FROM caddy:2.8.4-alpine AS caddy_src

FROM node:24-alpine
WORKDIR /app

COPY --from=caddy_src /usr/bin/caddy /usr/bin/caddy

RUN apk add --no-cache openssl

COPY package.json server.js ./
COPY lib ./lib
COPY db ./db
COPY scripts ./scripts
COPY public ./public
COPY module ./module
COPY docs ./docs
COPY ai-app-kernel ./ai-app-kernel
COPY gateway ./gateway

RUN chmod +x /app/gateway/entrypoint.sh \
  && mkdir -p /app/data \
  && chown -R node:node /app

USER node
ENV PORT=8090 \
    DATA_DIR=/app/data \
    HTTPS_GATEWAY=1 \
    HTTPS_PORT=8443 \
    HTTP_PORT=8080 \
    LISTEN_HOST=0.0.0.0

EXPOSE 8090
EXPOSE 8091
EXPOSE 8443
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/v1/integration/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/gateway/entrypoint.sh"]
