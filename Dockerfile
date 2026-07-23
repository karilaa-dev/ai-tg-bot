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
RUN node -e "import('@boxlite-ai/boxlite').then(({ JsBoxlite }) => { if (typeof JsBoxlite !== 'function') process.exit(1); })"

FROM node:22.19.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="Pi-powered Telegram agent with Codex OAuth and OpenRouter fallback"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        e2fsprogs \
        libcap2 \
        libgcc-s1 \
        tini \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    DB_URL=sqlite:/app/data/bot.db \
    BASH_WORKSPACE_ROOT=/app/data/bash \
    AGENT_SHARED_ROOT=/data \
    MANAGED_FILE_ROOT=/data/.chat-files \
    BOXLITE_HOME=/var/lib/boxlite \
    BOXLITE_GUEST_USER=agent \
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
    && mkdir -p /app/data/pi /app/data/bash /app/data/files /data /var/lib/boxlite \
    && chown -R 1000:1000 /app /data /var/lib/boxlite

VOLUME ["/app/data", "/data", "/var/lib/boxlite"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ai-tg-bot-entrypoint"]
CMD ["node", "dist/src/main.js"]
