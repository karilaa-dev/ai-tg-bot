# AI Telegram Bot

Personal AI assistant Telegram bot built with TypeScript, grammY, Codex app-server inference, OpenRouter embeddings, Drizzle ORM, SQLite/Postgres, and Telegram Bot API 10.1 rich-message wrappers.

## Setup

1. Install Node 22.13 or newer. SQLite development uses Drizzle's `node:sqlite` driver, and Postgres uses Drizzle's `node-postgres` driver over `pg`.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set real values.
4. Start Docling when DOCX conversion or low-text PDF fallback is needed:

   ```bash
   docker compose up -d docling
   ```

5. For Postgres instead of SQLite:

   ```bash
   docker compose --profile pg up -d postgres
   ```

   Then set `DB_URL=postgres://aibot:aibot@localhost:5432/aibot`.

6. Enable Topics for the bot in BotFather before using `/fork`.

All chat inference runs through `codex app-server`. `CODEX_MODEL` controls
normal generation, `CODEX_COMPACTION_MODEL` controls conversation
summarization/rolling memory and compaction-time image descriptions.
`CODEX_SPEED_MODE=fast` maps to Codex `serviceTier: "fast"`.
`CODEX_VERBOSITY` defaults to `high` and is sent as Codex `model_verbosity`.
`REASONING_SUMMARY` defaults to `none` and is the only reasoning-display
environment setting; set it to `auto`, `concise`, or `detailed` to stream Codex
reasoning summaries into the thinking block.
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

## Commands

```bash
npm run migrate
npm run dev
npm run build
npm test
npm run dev:streamdump
npm run live:codex-check
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
