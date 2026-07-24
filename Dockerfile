FROM node:22.19.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json system_prompt.md ./
COPY src ./src
COPY scripts ./scripts
COPY locales ./locales

RUN npm run build
RUN npm prune --omit=dev

FROM node:22.19.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="Pi-powered Telegram agent with OpenSandbox command execution"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    DB_URL=sqlite:/app/data/bot.db \
    BASH_WORKSPACE_ROOT=/app/data/bash \
    AGENT_SHARED_ROOT=/data \
    MANAGED_FILE_ROOT=/data/.chat-files \
    OPEN_SANDBOX_DOMAIN=opensandbox-server:8080 \
    OPEN_SANDBOX_PROTOCOL=http \
    OPEN_SANDBOX_USE_SERVER_PROXY=true \
    OPEN_SANDBOX_IMAGE=ghcr.io/karilaa-dev/ai-agent-box:latest \
    OPEN_SANDBOX_USER=agent \
    OPEN_SANDBOX_GROUP=agent \
    OPEN_SANDBOX_UID=1000 \
    OPEN_SANDBOX_GID=1000 \
    APP_UID=1000 \
    APP_GID=1000 \
    PI_CODING_AGENT_DIR=/app/data/pi

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/locales ./locales
COPY --from=build --chown=node:node /app/system_prompt.md ./system_prompt.md
COPY docker/entrypoint.sh /usr/local/bin/ai-tg-bot-entrypoint

RUN chmod 0755 /usr/local/bin/ai-tg-bot-entrypoint \
    && install -d -o 1000 -g 1000 /app/data /app/data/pi /app/data/bash /data

VOLUME ["/app/data", "/data"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ai-tg-bot-entrypoint"]
CMD ["node", "dist/src/main.js"]
