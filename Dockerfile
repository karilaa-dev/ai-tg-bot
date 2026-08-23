FROM node:24.18.0-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        g++ \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json system_prompt.md ./
COPY src ./src
COPY scripts ./scripts
COPY locales ./locales
COPY skills ./skills

RUN npm run build
RUN npm prune --omit=dev

FROM node:24.18.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="Pi-powered Telegram agent with E2B sandboxes"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gzip \
        tar \
        tini \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    DB_URL=sqlite:/app/data/bot.db \
    E2B_TEMPLATE=ai-tg-bot-tools:production \
    E2B_DEPLOYMENT_ID=ai-tg-bot \
    TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000 \
    TELEGRAM_FILE_RESTORE_CONCURRENCY=4 \
    APP_UID=1000 \
    APP_GID=1000 \
    PI_CODING_AGENT_DIR=/app/data/pi

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/locales ./locales
COPY --from=build --chown=node:node /app/skills ./skills
COPY --from=build --chown=node:node /app/system_prompt.md ./system_prompt.md
COPY docker/entrypoint.sh /usr/local/bin/ai-tg-bot-entrypoint

RUN chmod 0755 /usr/local/bin/ai-tg-bot-entrypoint \
    && install -d -o 1000 -g 1000 /app/data /app/data/pi

VOLUME ["/app/data"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ai-tg-bot-entrypoint"]
CMD ["node", "dist/src/main.js"]
