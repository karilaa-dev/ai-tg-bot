# ai-tg-bot

A private Telegram agent built on persistent Pi sessions and persistent custom E2B Base sandboxes.

## Sandbox model

- A sandbox is created lazily the first time a thread calls a shell-backed tool.
- Each Telegram thread owns exactly one E2B sandbox. Sandbox IDs are stored in the database and recovered by deployment/thread metadata after a restart.
- `/home/user/workspace` is the thread's writable, persistent working directory.
- Every Telegram-backed file visible through the thread/fork chain can be downloaded by the bot and copied through the E2B SDK into `/home/user/telegram-files`. That directory and its files are root-owned and read-only to agent commands. Files must be copied into the workspace before editing.
- There is no host bind mount, E2B volume, cross-thread shared directory, or canonical host file store. Generated files remain in the sandbox. Telegram file bodies pass through the bot process during ingestion, sandbox restoration, and outbound delivery.
- Sandboxes auto-pause after 3 minutes once a shell-backed turn is finished. An explicit successful `publish_website` call changes that turn's delay to 15 minutes, and the final Telegram answer states the public URL and pause timing.
- E2B Base sandboxes have a one-hour continuous runtime window. The runtime manager proactively pauses and reconnects before that limit during long work, preserving filesystem and memory state while resetting the window.
- Auto-resume from public traffic is disabled. A later explicit bot operation reconnects and resumes the sandbox.

E2B documents the relevant behavior in [Sandbox lifecycle](https://e2b.dev/docs/sandbox), [persistence](https://e2b.dev/docs/sandbox/persistence), [file upload](https://e2b.dev/docs/filesystem/upload), and [filesystem isolation](https://e2b.dev/docs/filesystem).

## Custom template and tools

`E2B_TEMPLATE=ai-tg-bot-tools:production` selects the reusable private template defined in [`e2b-template`](e2b-template/README.md). It is based on E2B Base and built explicitly with 2 vCPU and 2 GiB RAM; bot startup and sandbox creation never install or rebuild it. The toolbox includes OfficeCLI, ImageMagick 7, ZIP and other archive utilities, Python, Node.js, Git/SSH, SQLite, compilers, and common shell/search/network diagnostics. Chromium and browser automation bundles are intentionally absent because browser work is provided by Camofox.

Build and validate a version, then atomically promote it to `production`:

```bash
npm run e2b:template:build
npm run e2b:template:check
```

Before the first cutover from Desktop, stop the bot, preview the guarded deletion scope, and execute it. Only `desktop` sandboxes with `app=ai-tg-bot` metadata match:

```bash
npm run e2b:sandboxes:prune-desktop
npm run e2b:sandboxes:prune-desktop -- --execute
```

This permanently removes unshared Desktop workspace/process state. Telegram-backed files remain durable and are restored when a thread next creates its toolbox sandbox. Moving the `production` tag later affects only new sandboxes; existing thread sandboxes retain their original build and filesystem.

Shared Telegram files are downloaded with the Bot API and written into the
thread sandbox through E2B's SDK. Files created in the sandbox are read through
the SDK and sent to Telegram by the bot.

OfficeCLI is pinned in the toolbox and available through `bash`. When Camofox is configured, the bot renders OfficeCLI's static HTML in an isolated disposable browser session and returns a model-only PNG for visual QA. The preview is not sent to Telegram, and the bot does not install missing tools.

## Files and retrieval

- Telegram remains the durable source for inbound and successfully delivered outbound file bytes. Intake downloads accepted files, records every Telegram file identifier, captions images, and extracts/indexes supported documents.
- `[[chat-file:<id>]]` markers are durable Pi references.
- `load_message` can load selected attachment bytes into transient model context. The same files are restored into the read-only Telegram directory before sandbox operations.
- Files created by the agent receive an E2B source locator and are read through the SDK before the bot sends them. Photos that exceed Telegram's photo limit or are rejected as photos are sent as documents without suppressing other attachments.

## Requirements

- Node.js 24.18 or newer
- Telegram bot token
- E2B API key
- OpenRouter API key
- Tavily API key
- Optional authenticated Camofox server for interactive browsing and Office visual QA
- Optional Codex OAuth login through Pi
- Optional external Docling service

## Source setup

```bash
cp .env.example .env
# Fill in BOT_TOKEN, E2B_API_KEY, OPENROUTER_API_KEY, and TAVILY_API_KEY.
npm install
npm run dev
```

To configure Codex OAuth in the same Pi directory:

```bash
PI_CODING_AGENT_DIR=./data/pi npx pi
```

The default database is SQLite. Set `DB_URL` to use PostgreSQL. On upgrade, the current release removes the obsolete host-file `path` column. Records with a Telegram or E2B source are retained; records whose only byte source was a legacy host snapshot are removed transactionally. Physical files in the old host-storage directory are not deleted automatically.

For an OpenSandbox-era deployment, stop the old bot before upgrading and move its former managed-file root out of the deployment mounts as a rollback quarantine. The E2B release never reads that directory, so every physical file below it is unreferenced after the database migration. Keep the quarantined directory for a bounded 30-day rollback window, confirm Telegram-backed files and new E2B file delivery work, then delete the whole quarantined directory manually. Back it up first if legacy generated files must be retained; they cannot be imported automatically because they have no Telegram or E2B source.

## Docker Compose

```bash
cp .env.example .env
# Fill in credentials and POSTGRES_PASSWORD.
docker compose up --build -d
```

The bot container has normal outbound access for E2B/provider APIs and a second internal-only network for PostgreSQL. It does not need a Docker socket, host workspace mount, privileged mode, or a local sandbox service.

## E2B configuration

```dotenv
E2B_API_KEY=<secret>
E2B_TEMPLATE=ai-tg-bot-tools:production
E2B_DEPLOYMENT_ID=ai-tg-bot
E2B_REQUEST_TIMEOUT_MS=30000
TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000
TELEGRAM_FILE_RESTORE_CONCURRENCY=4
```

Use a distinct `E2B_DEPLOYMENT_ID` for each deployment sharing an E2B account. Do not change it casually: it is part of sandbox ownership and recovery.

The bot creates secured sandboxes with public port traffic and internet access enabled, timeout action `pause`, memory preservation enabled, and automatic resume disabled.

## Camofox configuration

```dotenv
WEB_EXTRACT_PROVIDER=camofox
CAMOFOX_URL=http://camofox.example:9377
CAMOFOX_ACCESS_KEY=<secret>
CAMOFOX_TIMEOUT_MS=30000
CAMOFOX_DEPLOYMENT_ID=ai-tg-bot
```

`WEB_EXTRACT_PROVIDER` accepts `tavily` (the application default) or `camofox`. It switches only `web_extract`, which loads already-known URLs; `web_search` always remains on Tavily. Camofox selection is strict and does not silently fall back to Tavily.

Configuring the URL and access key also enables interactive `camofox_*` tools and model-only Office previews. Browser cookies and tabs are isolated per Telegram thread through opaque hashed owner IDs. Interactive tabs remain available while the Camofox server retains the session; disposable extraction and Office-preview sessions are destroyed after each call.

`camofox_snapshot` keeps its screenshot internal for model inspection. An explicit `camofox_screenshot` call uses Camofox's actual 1920-pixel desktop surface and selects a content-aware height between 720 and 1440 pixels, keeping the primary visible section intact without the crop/padding caused by forcing a mismatched width. It stores the PNG in the bot and normally sends it as a Telegram photo. Full-page capture is reserved for explicit full/whole-page requests; document delivery is reserved for explicit “as a file/document” requests. Neither screenshot mode uses E2B. `camofox_send_file` can similarly attach a completed Camofox download, a page-link ref, or a known public HTTP(S) file URL. Browser files are size-bounded, checked against executable-file restrictions, and refused when their URL or any redirect resolves to a local/private address.

The URL must be an exact HTTP(S) origin reachable from the bot process or container. Keep the access key only in `.env`; it is sent as a bearer header, redacted from client errors, and never injected into E2B commands. Arbitrary page evaluation and cookie import are not exposed as agent tools.

## Public websites

The agent starts an HTTP server with `bash`, binds it to `0.0.0.0`, and then calls:

```json
{"port": 3000, "path": "/"}
```

through `publish_website`. The bot verifies the E2B HTTPS URL before returning it. A public URL is unavailable while its sandbox is paused; a later shell-backed bot request resumes the sandbox and its preserved process state.

## Telegram commands

- `/lang` — change language
- `/timezone` — set timezone
- `/stream` — toggle draft streaming
- `/stop` — cancel the active Pi turn
- `/fork` — branch the current Pi session into a Telegram topic
- `/compact` — invoke Pi compaction
- `/help` — show command help

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Provider checks:

```bash
npm run live:pi-check
npm run live:pi-fallback
```

With E2B configured:

```bash
npm run live:e2b-check
```

With Camofox configured:

```bash
npm run live:camofox-check
```

The live check opens `https://example.com` in a randomized disposable session, verifies a snapshot and PNG screenshot, and destroys the session before exiting.

Set `LIVE_TELEGRAM_FILE_ID` to exercise bot-mediated restoration, read-only
permissions, the custom toolbox contract, and ZIP creation during the live check.
