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

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN CODEX_NON_INTERACTIVE=1 \
    CODEX_RELEASE=$CODEX_RELEASE \
    CODEX_INSTALL_DIR=/usr/local/bin \
    CODEX_HOME=/opt/codex-cli \
    sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'

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

VOLUME ["/app/data", "/home/node/.codex"]

CMD ["node", "dist/src/main.js"]
