FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY config ./config
COPY module ./module
COPY ai-app-kernel ./ai-app-kernel
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=8090
EXPOSE 8090
CMD ["node","server.js"]
