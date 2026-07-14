FROM node:22.19.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json system_prompt.md ./
COPY src ./src
COPY locales ./locales

RUN npm run build
RUN npm prune --omit=dev

FROM node:22.19.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="Pi-powered Telegram agent with Codex OAuth and OpenRouter fallback"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    DB_URL=sqlite:/app/data/bot.db \
    BASH_WORKSPACE_ROOT=/app/data/bash \
    DOCLING_URL=http://docling:5001 \
    PI_CODING_AGENT_DIR=/app/data/pi

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/locales ./locales
COPY --from=build --chown=node:node /app/system_prompt.md ./system_prompt.md

RUN mkdir -p /app/data/pi /app/data/bash /app/data/files \
    && chown -R node:node /app

USER node

CMD ["node", "dist/src/main.js"]
