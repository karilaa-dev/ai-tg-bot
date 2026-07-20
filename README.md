# ai-tg-bot

A private Telegram agent built on persistent [Pi](https://github.com/earendil-works/pi) sessions. Pi owns inference, tool loops, conversation persistence, branching, cancellation, retries, and compaction. Codex OAuth is preferred; OpenRouter is the automatic fallback and the vector-embedding backend. Attachment storage is transport-neutral so another chat interface can supply remote locators without changing the Pi runtime.

Telegram controls who can reach the bot; there is no application-level allowlist. The bot accepts any sender delivered to its private chat and rejects group or supergroup use.

## Runtime model

- Each Telegram thread maps to one persistent Pi JSONL session under `PI_CODING_AGENT_DIR`. The database stores the session path/id and maps Telegram messages to Pi entry ids.
- Pi's built-in automatic compaction is used unchanged. `/compact` calls Pi directly and `/fork` creates a Pi branch at the mapped message entry.
- Built-in host filesystem tools are disabled. Pi receives only the bot's scoped tools: `bash`, `create_file`, `web_search`, `web_extract`, `search_thread`, `load_message`, `search_in_file`, `read_file_section`, and `generate_image`.
- Retrieval is explicit: prior messages use full-text search, while chunked large documents use full-text plus vector search. Nothing is automatically injected into prompts; Pi chooses when to call the retrieval tools.
- The persistent just-bash workspace is isolated per chat thread. Every thread/fork-authorized file appears at `/attachments/<file_id>` and through `CHAT_FILE_<file_id>`. Directory listing and metadata operations do not download content; opening one entry restores only that file. `input_file_ids` remains an optional eager preload/validation list of up to five IDs. The per-call attachment mount is copy-on-write, so sandbox edits cannot alter canonical snapshots.

### Provider routing

The internal `telegram-auto/main` and `telegram-auto/helper` models route through Pi's existing providers:

1. Use Pi's `openai-codex` OAuth credentials when configured.
2. Use OpenRouter immediately when Codex is not configured.
3. Before any output is emitted, fall back for quota/429, OAuth/auth refresh, network, timeout, and retryable 5xx failures.
4. Do not fall back after partial output, or for context overflow, content policy, invalid request, or tool errors.

Main, helper, and image calls share one Codex circuit breaker. While open, requests use OpenRouter; only one half-open Codex probe is allowed at a time.

### Images

`generate_image` is the only image-generation tool. It creates or edits exactly one PNG, JPEG, or WebP with up to five current-thread chat image references.

- The Codex path uses the hosted Responses `image_generation` tool with Pi's existing Codex credentials.
- The fallback path uses OpenRouter's dedicated image endpoint.
- Reference images are resolved from their recorded chat source into memory and sent as data URLs.
- By design, generated originals are atomically saved under `BASH_WORKSPACE_ROOT/.chat-files/<file_id>/content`; they are not transient-only. A successful `generate_image` result terminates Pi's tool loop, and the photo is sent from the current turn's delivery outbox before final text/draft cleanup. After Telegram accepts the photo, its `file_id` and `file_unique_id` are retained as recovery sources. If the local original is manually deleted, a later Telegram photo restoration may be a recompressed JPEG.
- Pi JSONL and tool results contain text metadata, never image base64.
- Incoming images are captioned once by an isolated Pi helper session. A Pi context hook injects bytes only for attachments newly received in the current turn or exact IDs explicitly selected with `load_message(file_ids: [...])`. Historical markers remain text-only, including after compaction.

The Codex request shape is adapted from the MIT-licensed [pi-better-openai](https://github.com/mattleong/pi-better-openai) implementation; that package is not installed.

### Attachment sources and cache

- The database stores logical file metadata plus one or more `file_sources` locators. Telegram locators contain `file_id`/`file_unique_id`; a future Matrix adapter can store an MXC URL and connection key in the same schema. Locators should reference a separately configured connection/auth profile and must not embed access tokens or other credentials.
- Original inbound attachments, generated images, and `create_file` outputs are atomically stored under `BASH_WORKSPACE_ROOT/.chat-files/<file_id>/content` with private permissions. The database stores the canonical path, while Pi JSONL and database rows remain free of raw bytes/base64. Ordinary just-bash scripts and temporary files remain persistent workspace files but are not tracked as chat files.
- `[[chat-file:<id>]]` markers are the durable Pi references. After compaction, `search_thread` plus metadata-only `load_message` discovers old files; selecting only the needed IDs rehydrates only those files for that turn.
- Remote loads use opaque SHA-256 staging names in `FILE_CACHE_DIR`. Entries have a fixed one-hour lifetime by default and deduplicate concurrent requests. Successful restoration is copied into the persistent managed store and updates `files.path`; a persistence failure still serves the staged bytes for the current request.
- Inline documents retain extracted text, while large documents remain searchable through `search_in_file` and `read_file_section` without downloading originals. Exact bash access or an explicit `load_message.file_ids` selection restores the requested raw file. If restored bytes no longer match the durable hash, derived content is rebuilt through the existing refresh path.
- Telegram is the registered adapter today. Adding Matrix requires a `ChatFileSourceAdapter` for the Matrix connection and registration in the interface bootstrap; Pi, tools, cache, and retrieval do not need transport-specific changes.

## Requirements

- Node.js 22.19 or newer
- A Telegram bot token
- An OpenRouter API key (fallback, images, and embeddings)
- A Tavily API key
- Optional Codex OAuth login through Pi
- Docling for DOCX and low-text PDF extraction

## Setup

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
```

To configure Codex OAuth in the same Pi directory used by the bot:

```bash
PI_CODING_AGENT_DIR=./data/pi npx pi
```

Enter `/login` in Pi and choose the OpenAI Codex provider. If no Codex credentials are present, the bot remains fully operational through OpenRouter.

Required `.env` values are `BOT_TOKEN`, `OPENROUTER_API_KEY`, and `TAVILY_API_KEY`. The Pi/model defaults are:

```dotenv
PI_CODING_AGENT_DIR=./data/pi
CODEX_MODEL=gpt-5.6-sol
CODEX_HELPER_MODEL=gpt-5.6-luna
OPENROUTER_MAIN_MODEL=openai/gpt-5.6-sol
OPENROUTER_HELPER_MODEL=openai/gpt-5.6-luna
OPENROUTER_IMAGE_MODEL=openai/gpt-5.4-image-2
OPENROUTER_EMBEDDING_MODEL=perplexity/pplx-embed-v1-0.6b
MODEL_CONTEXT_TOKENS=128000
PI_THINKING_LEVEL=medium
PI_TURN_TIMEOUT_MS=900000
IMAGE_TIMEOUT_MS=300000
FILE_CACHE_DIR=/tmp/ai-tg-bot-files
FILE_CACHE_TTL_MS=3600000
```

See [.env.example](./.env.example) for file, Docling, bash, draft, onboarding, and logging settings.

## Migration warning

The first startup that applies `pi_cutover_v2` intentionally deletes all legacy conversations, messages, attachments, chunks, summaries, search entries, embeddings, and managed `data/files` contents. It preserves users, settings stored on users, and `data/bash` workspaces. The idempotent `remove_invites_v1` migration deletes the obsolete built-in access table and user attribution column. The later idempotent `chat_file_sources_v1` migration converts existing Telegram locator columns/rows into `file_sources`. The idempotent `remove_message_embeddings_v1` migration deletes obsolete message vectors while preserving messages, full-text indexes, file chunks, and chunk vectors. Existing rows with `path = null` stay remote-only until one specific file is requested; legacy local files are copied into `.chat-files` lazily.

SQLite is the default. PostgreSQL is selected when `DB_URL` begins with `postgres://` or `postgresql://`.

## Docker

```bash
docker compose up --build
```

The `bot-data` volume contains SQLite, per-thread just-bash workspaces, and managed chat-file originals under `/app/data/bash/.chat-files`. No automatic persistent-file or workspace cleanup is applied. The compatibility-named `codex-home` volume is mounted at `/app/data/pi` and contains Pi sessions and OAuth state. On the first upgraded startup, a Codex CLI `auth.json` in that volume is backed up as `auth.codex-cli.json` and converted to Pi's credential schema. The same migration detects the former Unraid `/app/data/codex/auth.json` location. It is idempotent and never logs token values.

To configure or replace Codex OAuth, stop the bot and run Pi interactively:

```bash
docker compose stop bot
docker compose run --rm bot ./node_modules/.bin/pi --no-tools
```

Enter `/login`, then restart the service. PostgreSQL is available with:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up --build
```

## Telegram commands

- `/lang` — change language
- `/timezone` — set timezone
- `/stream` — toggle draft streaming
- `/stop` — cancel the active Pi turn or file ingest
- `/fork` — branch the current Pi session into a Telegram topic
- `/compact` — invoke Pi compaction
- `/help` — show command help

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Live provider checks use the configured Pi auth and `.env` values:

```bash
npm run live:pi-check
npm run live:pi-fallback
```

The second command forces the shared Codex circuit open so the smoke turn must use OpenRouter.
