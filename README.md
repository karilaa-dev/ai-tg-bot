# AI Telegram Bot

Personal Telegram AI assistant built with TypeScript, grammY, Codex app-server inference, OpenRouter embeddings, Tavily web tools, just-bash workspaces, Drizzle ORM, and SQLite/Postgres storage.

## Current Capabilities

- Private-chat Telegram bot with invite-gated onboarding and an admin bypass.
- Codex app-server chat turns with streaming draft updates, compact final answers, rich-message sending, and Telegram parse-retry fallbacks.
- Conversation memory stored in SQLite or Postgres, with manual `/compact` support and automatic retrieval from previous messages, summaries, files, and forked topics.
- File ingestion for `.txt`, `.csv`, `.pdf`, `.docx`, `.jpg`, `.jpeg`, `.png`, and `.webp` up to Telegram bot download limits. Native PDF text is extracted first; Docling handles DOCX and low-text PDF fallback.
- Image uploads are stored as context and can be described later during compaction. Generated images come from the Codex app-server image flow, are decoded from base64, stored locally, and sent back as separate Telegram photo messages.
- Dynamic tools exposed to Codex: thread search, exact message loading, file search/section reads, image generation/editing, created-file delivery, just-bash execution, Tavily web search, and Tavily page extraction.
- Per-thread just-bash virtual workspaces for deterministic shell/data work and files the assistant can send back to Telegram.
- Docker-first deployment with persistent bot data and isolated container Codex login state.

## Telegram Commands

Visible user commands:

- `/start` - start onboarding or show the welcome message.
- `/help` - show a short command summary.
- `/lang` - switch between English and Russian UI text.
- `/timezone` - set a UTC offset by telling the bot the current local time.
- `/stream` - toggle streaming draft/status updates for the current user.
- `/stop` - cancel active file processing in the current thread.
- `/fork` - create a new topic that carries the current thread context.
- `/compact` - summarize older thread messages into rolling memory.

Admin-only commands:

- `/invite` - create a new invite link with inline controls for uses and expiry.
- `/invites` - list and revoke active invites.

The bot only handles private chats. Enable Topics for the bot in BotFather before using `/fork`.

## Runtime Model

Chat, summarization, image captioning, and image generation all run through `codex app-server`. The bot starts ephemeral Codex threads for each Telegram turn and sends `system_prompt.md` as Codex `baseInstructions`.

OpenRouter is used for embeddings and retrieval vectors only. Tavily powers the `web_search` and `web_extract` dynamic tools. Docling is optional at startup but required for DOCX conversion and low-text PDF fallback.

The default database is SQLite at `./data/bot.db` locally or `/app/data/bot.db` in Docker. Postgres is supported with a `postgres://` or `postgresql://` `DB_URL`.

## Setup With Docker

1. Copy `.env.example` to `.env` and set real Telegram, OpenRouter, and Tavily values.

2. Build the bot image:

   ```bash
   docker compose build
   ```

3. Log in to Codex once inside Docker. Auth is stored in the `codex-home` Docker volume, not in the image and not in host `~/.codex`:

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

The default Compose stack uses SQLite, stores uploaded/generated files under `/app/data`, stores just-bash workspaces under `/app/data/bash`, and preserves state in the `bot-data` volume. Codex state lives in `/home/node/.codex` and is preserved by the `codex-home` volume.

The bot does not mount host `~/.codex` by default. Secrets stay out of the image; `.env` is loaded only at runtime.

## Docker With Postgres

Use `docker-compose.postgres.yml` when the Docker bot should use Postgres instead of the default SQLite volume:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml build
docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm bot codex login --device-auth
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.yml -f docker-compose.postgres.yml logs -f bot
```

The Postgres override adds a `postgres:17-alpine` service, persists it in the `pg-data` volume, and changes the bot database URL to `postgres://aibot:${POSTGRES_PASSWORD:-aibot}@postgres:5432/aibot`. Set `POSTGRES_PASSWORD` in `.env` before starting the stack if you want a different URL-safe password.

## Local Development

1. Install Node 22.13 or newer. SQLite development uses Node's `node:sqlite` driver, and Postgres uses Drizzle's `node-postgres` driver over `pg`.

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set real values.

4. Start Docling when DOCX conversion or low-text PDF fallback is needed:

   ```bash
   docker compose up -d docling
   ```

5. For local Postgres instead of SQLite:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres
   ```

   Then set:

   ```bash
   DB_URL=postgres://aibot:aibot@localhost:5432/aibot
   ```

6. Run the bot:

   ```bash
   npm run dev
   ```

Migrations run automatically on startup. You can also run them directly with `npm run migrate`.

## Configuration Notes

Required environment values:

- `BOT_TOKEN`
- `TELEGRAM_ADMIN_ID`
- `OPENROUTER_API_KEY`
- `TAVILY_API_KEY`

Important optional values:

- `DB_URL` defaults to `sqlite:./data/bot.db`.
- `CODEX_MODEL` controls normal chat turns.
- `CODEX_COMPACTION_MODEL` controls memory compaction and image descriptions.
- `CODEX_IMAGE_MODEL`, `CODEX_IMAGE_QUALITY`, and `CODEX_IMAGE_TIMEOUT_MS` control generated-image turns.
- `CODEX_SPEED_MODE=fast` maps to Codex Fast mode via `serviceTier: "priority"`.
- `CODEX_VERBOSITY` is sent as Codex `model_verbosity`.
- Normal chat defaults to `CODEX_MODEL=gpt-5.6-sol`, `REASONING_EFFORT=medium`, and `REASONING_SUMMARY=detailed`; all three can be overridden in `.env`. Helper-model turns omit the chat effort override.
- `CODEX_TURN_TIMEOUT_MS` defaults to 15 minutes; set it to `0` to disable the hard cap.
- `OPENROUTER_EMBEDDING_MODEL` defaults to `perplexity/pplx-embed-v1-0.6b`.
- `DOCLING_URL` and `DOCLING_TIMEOUT_MS` control Docling conversion.
- `FILE_INLINE_TOKENS` decides when extracted files are kept inline versus chunked and indexed.
- `BASH_WORKSPACE_ROOT`, `BASH_TIMEOUT_MS`, and `BASH_MAX_OUTPUT_CHARS` control just-bash tool execution.
- `DRAFT_UPDATE_MS` and `STREAM_DELTA_CHARS` control draft/status update pacing.
- `RECENT_WINDOW_MESSAGES` controls how many latest messages remain verbatim during compaction.
- `LOG_LEVEL` supports `debug`, `info`, `warn`, and `error`.

See `.env.example` for the full list and defaults.

## File And Tool Behavior

Telegram uploads are cached by Telegram file id, unique id, and content hash where possible. Large extracted files are chunked, embedded, and made searchable through `search_in_file` and `read_file_section`. Image bytes stay available for later context loading and image editing references.

The `bash` tool runs in an isolated per-thread just-bash virtual filesystem under `BASH_WORKSPACE_ROOT`. It allows public internet access through `curl`, blocks localhost/private network ranges, and returns bounded stdout/stderr. Files created there can be attached to a final Telegram answer with `create_file`; at most 10 files are sent per answer.

## Data Management

`docker compose down` removes containers but preserves `bot-data` and `codex-home`. `docker compose down -v` deletes those volumes and removes chat history, files, just-bash workspaces, and container Codex login state. With the Postgres override, `down -v` also deletes `pg-data`.

To back up the default Compose volumes, replace the volume names if your Compose project name differs:

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

## Project Commands

```bash
npm run dev
npm run build
npm run typecheck
npm test
npm run migrate
npm run dev:streamdump
npm run live:codex-check
```

Docker entrypoint and image checks:

```bash
docker compose config
docker compose -f docker-compose.yml -f docker-compose.postgres.yml config
docker compose build --pull bot
docker compose build --build-arg CODEX_RELEASE=0.144.0 bot
docker compose run --rm bot codex --version
docker compose run --rm bot codex login status
```

To exercise real Codex app-server inference, local tool use, and OpenRouter embeddings against one temporary scenario, run:

```bash
npm run live:codex-check
```

This uses a temporary SQLite database and fake Telegram API, but real Codex inference and real OpenRouter embeddings.

## Tests

```bash
npm test
```

The requested `grammy-emulate` package is not published on npm. Tests use `test/helpers/grammy-emulate.ts`, a small local helper backed by `@bonkers-agency/grammy-test`, which provides in-memory grammY bot emulation without Telegram network calls.

Current tests cover invite onboarding, invite/timezone conversations, invalid-code paths, private-only routing, language switching and localized command menus, stream toggling, context callbacks and compaction retry, `/fork` topic behavior, `/stop` file cancellation, parallel user/topic processing, rich-message calls, draft and command topic fallback, sentence streaming, markdown repair, file/image/media-group ingestion, chunk outlines, Docling payload/live smoke behavior, file/thread memory tools, generated-image handling, created-file delivery, and persistent just-bash execution.
