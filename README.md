# AI Telegram Bot

Personal AI assistant Telegram bot built with TypeScript, grammY, AI SDK v6, OpenRouter, Drizzle ORM, SQLite/Postgres, and Telegram Bot API 10.1 rich-message wrappers.

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

`OPENROUTER_MODEL` controls normal chat and image captioning. `OPENROUTER_COMPACTION_MODEL`
controls only conversation summarization/rolling memory and defaults to
`openai/gpt-5.4-mini`.
`OPENROUTER_EMBEDDING_MODEL` controls file/thread indexing and defaults to
`perplexity/pplx-embed-v1-0.6b`, a low-latency dense retrieval model.

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
```

With the Postgres compose service running, the repository round-trip test can be exercised against both dialects:

```bash
TEST_PG_URL=postgres://aibot:aibot@localhost:5432/aibot npm test -- --run test/db/repos.test.ts
```

With Docling running, the live conversion smoke can be exercised explicitly:

```bash
TEST_DOCLING_URL=http://localhost:5001 npm test -- --run test/files/docling.test.ts
```

## Testing Telegram Behavior

The requested `grammy-emulate` package is not published on npm. Tests use `test/helpers/grammy-emulate.ts`, a small local helper backed by `@bonkers-agency/grammy-test`, which provides in-memory grammY bot emulation without Telegram network calls.

Current test coverage exercises invite onboarding and invite/timezone conversations, invalid-code paths, private-only routing, language switching and localized command menus, stream toggling, context callbacks and compaction auto-retry, `/fork` topic behavior, `/stop` file cancellation, parallel user/topic processing, rich-message send calls, draft and command topic fallback, sentence streaming, markdown repair, file/image/media-group ingestion, chunk outlines, Docling payload/live smoke tests, and file/thread memory tools.
