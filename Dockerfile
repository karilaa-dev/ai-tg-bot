FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json system_prompt.md ./
COPY src ./src
COPY locales ./locales

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG CODEX_RELEASE=0.144.0

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="AI Telegram bot powered by Codex with OpenRouter, Tavily, and Docling integrations"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_RELEASE}" \
    && npm cache clean --force

WORKDIR /app

ENV NODE_ENV=production \
    DB_URL=sqlite:/app/data/bot.db \
    BASH_WORKSPACE_ROOT=/app/data/bash \
    DOCLING_URL=http://docling:5001 \
    CODEX_HOME=/home/node/.codex \
    PATH=/usr/local/bin:$PATH

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/locales ./locales
COPY --from=build --chown=node:node /app/system_prompt.md ./system_prompt.md

RUN mkdir -p /app/data /home/node/.codex \
    && chown -R node:node /app /home/node/.codex

USER node

CMD ["node", "dist/src/main.js"]
