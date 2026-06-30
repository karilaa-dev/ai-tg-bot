# AI Telegram Bot

Personal AI assistant Telegram bot built with TypeScript, grammY, Codex app-server inference, OpenRouter embeddings, Drizzle ORM, SQLite/Postgres, and Telegram Bot API 10.1 rich-message wrappers.

## Setup

1. Copy `.env.example` to `.env` and set real Telegram, OpenRouter, and Tavily values.
2. Build the bot image:

   ```bash
   docker compose build
   ```

3. Log in to Codex once inside Docker. This stores auth in the `codex-home` Docker volume, not in the image and not in host `~/.codex`:

   ```bash
   docker compose run --rm bot codex login --device-auth
   ```

4. Start the bot and Docling:

   ```bash
   docker compose up -d
   ```

5. Inspect startup logs:

   ```bash
   docker compose logs -f bot
   ```

6. Enable Topics for the bot in BotFather before using `/fork`.

The default Docker runtime uses SQLite at `/app/data/bot.db`, uploaded and
generated files under `/app/data`, and per-thread just-bash workspaces under
`/app/data/bash`. The `bot-data` Docker volume preserves that state across
container rebuilds and restarts. Codex state lives in `/home/node/.codex` and is
preserved by the `codex-home` Docker volume.

The bot does not mount host `~/.codex` by default. All chat inference stays on
the private `codex app-server` stdio integration spawned by the bot process.
Secrets stay out of the image; `.env` is loaded only at runtime.

## Docker With Postgres

Use `docker-compose.postgres.yml` when you want the Docker bot to use Postgres
instead of the default SQLite volume:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml build
docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm bot codex login --device-auth
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.yml -f docker-compose.postgres.yml logs -f bot
```

The Postgres override adds a `postgres` service, persists it in the `pg-data`
volume, and changes the bot database URL to
`postgres://aibot:${POSTGRES_PASSWORD:-aibot}@postgres:5432/aibot`. Set
`POSTGRES_PASSWORD` in `.env` before starting the stack if you want a different
password; keep it URL-safe because Compose uses the same value in the bot's
connection URL.

## Local Development

1. Install Node 22.13 or newer. SQLite development uses Drizzle's `node:sqlite`
   driver, and Postgres uses Drizzle's `node-postgres` driver over `pg`.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set real values.
4. Start Docling when DOCX conversion or low-text PDF fallback is needed:

   ```bash
   docker compose up -d docling
   ```

5. For Postgres instead of local SQLite:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres
   ```

   Then set `DB_URL=postgres://aibot:aibot@localhost:5432/aibot`.

All chat inference runs through `codex app-server`. `CODEX_MODEL` controls
normal generation, `CODEX_COMPACTION_MODEL` controls conversation
summarization/rolling memory and compaction-time image descriptions.
`CODEX_IMAGE_MODEL` is the requested image model for the `generate_image`
dynamic tool and defaults to `gpt-image-2`; `CODEX_IMAGE_QUALITY` defaults to
`low`; `CODEX_IMAGE_TIMEOUT_MS` defaults to `300000` (5 minutes) and can be
set to `0` to disable the hard cap for slow reference-image edits.
Generated images are decoded from Codex's base64 image result, stored as image
files for future `#file` references, and sent as separate captionless Telegram
photo messages.
Images created with `create_file` are also sent as Telegram photos by default;
set `delivery` to `document` when exact-byte, uncompressed delivery is needed.
`CODEX_SPEED_MODE=fast` maps to Codex `serviceTier: "fast"`.
`CODEX_VERBOSITY` defaults to `high` and is sent as Codex `model_verbosity`.
`REASONING_SUMMARY` defaults to `none` and is the only reasoning-display
environment setting; set it to `auto`, `concise`, or `detailed` to stream Codex
reasoning summaries into the thinking block.
`CODEX_TURN_TIMEOUT_MS` defaults to `900000` (15 minutes); set it to `0` to
disable the hard cap for very long turns.
`STREAM_DELTA_CHARS` defaults to `48`, splitting large Codex answer/reasoning
deltas into smaller draft-rendering chunks. The rendered `system_prompt.md` is
sent as Codex `baseInstructions`, replacing the default Codex base prompt for
each ephemeral chat thread.

`OPENROUTER_EMBEDDING_MODEL` controls file/thread indexing and defaults to
`perplexity/pplx-embed-v1-0.6b`, a low-latency dense retrieval model. Embedding,
file indexing, auto-RAG, and retrieval vectors remain OpenRouter-backed.

`TAVILY_API_KEY` powers the `web_search` and `web_extract` tools for current web
discovery and known-page content extraction.

`just-bash` powers the `bash` tool for deterministic shell/data work in a
per-thread persistent virtual workspace. Workspaces live under
`BASH_WORKSPACE_ROOT` (default `./data/bash`) as isolated `thread-<id>`
directories. The tool enables just-bash Python and JavaScript runtimes, keeps
public internet access available through `curl`, blocks localhost/private
network ranges, and returns bounded stdout/stderr controlled by
`BASH_MAX_OUTPUT_CHARS`. `BASH_TIMEOUT_MS` bounds each bash execution. Use
`js-exec -c '...'` for JavaScript because `node` is only a help stub in
just-bash, avoid unsupported shell setup such as `set -o pipefail`, and prefer
`curl -fsSL` plus `jq` for known raw URLs/APIs. Current
compatibility tests also document sandbox limits around virtual symlinks,
`rmdir`, and `[` tests inside `while`/`until` loops.

PDFs use native text extraction through `unpdf` first, which is much faster for
large book-style documents. If a PDF has little extractable text, or for DOCX
files, ingestion falls back to Docling at `DOCLING_URL`.

## Docker Data

`docker compose down` removes containers but preserves the `bot-data` and
`codex-home` volumes. `docker compose down -v` deletes those volumes and will
remove chat history, files, bash workspaces, and container Codex login state.
When using `docker-compose.postgres.yml`, the same `down -v` command also
deletes `pg-data`.

To back up the default Compose volumes, replace the volume names if your Compose
project name differs:

```bash
docker run --rm -v ai-tg-bot_bot-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/bot-data-backup.tgz -C /data .
docker run --rm -v ai-tg-bot_codex-home:/data:ro -v "$PWD":/backup alpine tar czf /backup/codex-home-backup.tgz -C /data .
```

To restore:

```bash
docker compose down
docker run --rm -v ai-tg-bot_bot-data:/data -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/bot-data-backup.tgz -C /data'
docker run --rm -v ai-tg-bot_codex-home:/data -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/codex-home-backup.tgz -C /data'
```

## Commands

```bash
npm run migrate
npm run dev
npm run build
npm test
npm run dev:streamdump
npm run live:codex-check
```

Docker entrypoint and image checks:

```bash
docker compose config
docker compose -f docker-compose.yml -f docker-compose.postgres.yml config
docker compose build --pull bot
docker compose build --build-arg CODEX_RELEASE=0.142.4 bot
docker compose run --rm bot codex --version
docker compose run --rm bot codex login status
```

To exercise real Codex app-server inference, local tool use, and OpenRouter
embeddings against one temporary scenario, run:

```bash
npm run live:codex-check
```

This uses a temporary SQLite database and fake Telegram API, but real Codex
inference and real OpenRouter embeddings.

## Testing Telegram Behavior

The requested `grammy-emulate` package is not published on npm. Tests use `test/helpers/grammy-emulate.ts`, a small local helper backed by `@bonkers-agency/grammy-test`, which provides in-memory grammY bot emulation without Telegram network calls.

Current test coverage exercises invite onboarding and invite/timezone conversations, invalid-code paths, private-only routing, language switching and localized command menus, stream toggling, context callbacks and compaction auto-retry, `/fork` topic behavior, `/stop` file cancellation, parallel user/topic processing, rich-message send calls, draft and command topic fallback, sentence streaming, markdown repair, file/image/media-group ingestion, chunk outlines, Docling payload/live smoke tests, file/thread memory tools, and persistent just-bash tool execution.
