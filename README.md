# ai-tg-bot

A private Telegram agent built on persistent Pi sessions and persistent custom E2B Base sandboxes.

## Sandbox model

- A sandbox is created lazily the first time a thread calls a shell-backed tool.
- Each Telegram thread owns exactly one E2B sandbox. Sandbox IDs are stored in the database and recovered by deployment/thread metadata after a restart.
- `/home/user/workspace` is the thread's writable, persistent working directory.
- Every Telegram-backed file visible through the thread/fork chain can be downloaded by the bot and copied through the E2B SDK into `/home/user/telegram-files`. That directory and its files are root-owned and read-only to agent commands. Files must be copied into the workspace before editing.
- On upgrade, the obsolete host `files.path` column is dropped. Legacy rows, extracted text, search chunks, and diagnostics remain available, while host-only rows with no text, chunks, or durable Telegram/E2B source are retained for diagnostics but excluded from model and sandbox file scope.
- There is no host bind mount, E2B volume, cross-thread shared directory, or canonical host file store. Generated files remain in the sandbox. Telegram file bodies pass through the bot process during ingestion, sandbox restoration, and outbound delivery.
- Sandboxes auto-pause after 3 minutes once a shell-backed turn is finished. An explicit successful `publish_website` call changes that turn's delay to 15 minutes, and the final Telegram answer states the public URL and pause timing.
- E2B Base sandboxes have a one-hour continuous runtime window. The runtime manager proactively pauses and reconnects before that limit during long work, preserving filesystem and memory state while resetting the window.
- Auto-resume from public traffic is disabled. A later explicit bot operation reconnects and resumes the sandbox.

E2B documents the relevant behavior in [Sandbox lifecycle](https://e2b.dev/docs/sandbox), [persistence](https://e2b.dev/docs/sandbox/persistence), [file upload](https://e2b.dev/docs/filesystem/upload), and [filesystem isolation](https://e2b.dev/docs/filesystem).

## Custom template and tools

`E2B_TEMPLATE=ai-tg-bot-tools:production` selects the reusable private template defined in [`e2b-template`](e2b-template/README.md). It is based on E2B Base and built explicitly with 2 vCPU and 2 GiB RAM; bot startup and sandbox creation never install or rebuild it. The toolbox includes OfficeCLI, ImageMagick 7, ZIP and other archive utilities, Python, Node.js, Git/SSH, SQLite, compilers, and common shell/search/network diagnostics. Chromium and browser automation bundles are intentionally absent because browser work is provided by Browser Use Cloud.

`sandbox_file_restore_status` is an intentionally retained operational audit keyed by sandbox generation and file. Deleting or replacing a sandbox removes its active `thread_sandboxes` mapping but keeps these historical restore results for diagnostics, as it does for messages, files, and Telegram references. Operators who need finite retention should archive and prune this audit table under their own data-retention policy rather than coupling history deletion to sandbox cleanup.

Sandbox-created attachment buffers are released after indexing and reloaded from their durable E2B source only for the Telegram batch currently being sent. Browser and generated-image payloads remain in memory only until their send attempt completes. The bot installs grammY's `autoRetry()` transformer, which handles Telegram flood waits, HTTP failures, and 5xx responses before delivery code sees a terminal error.

Partial Telegram-file restoration is cached per sandbox revision. Failed entries retry after an exponential backoff from five minutes to one hour, while a changed file descriptor or recreated sandbox triggers immediate reconciliation. Ambiguous Telegram send outcomes are stored separately from confirmed deliveries and are not advertised as delivered files.

Each sandbox-created file version initially has an immutable, content-addressed source under `/home/user/.ai-tg-bot/file-sources`. Unshared versions remain there while database file records depend on them, up to the configured aggregate byte limit; least-recently-verified snapshots are evicted first when that limit is exceeded. Orphan snapshots are removed automatically. After every record sharing the same snapshot has a durable Telegram source, a later sandbox operation removes the redundant snapshot and its E2B source locators; the normal workspace copy is unaffected. Deleting the sandbox reclaims any remaining snapshots. If an outbound source cannot be reloaded, the bot records and logs that partial recovery failure, continues with other readable attachments, and does not add an unsolicited warning to the Telegram response.

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

OfficeCLI is pinned in the toolbox and available through `bash`. The reviewed DOCX and PPTX instruction skills are also vendored under [`skills`](skills/README.md), checksum-verified at startup, and advertised through Pi on every normal turn. Pi's host-side `read` tool is restricted to those two skill directories; it cannot read bot source, credentials, Telegram files, or the E2B workspace. Skill setup/update commands are intentionally overridden by the bot's preinstalled-tool policy.

When Browser Use Cloud is configured, OfficeCLI generates static HTML inside E2B, then the bot sanitizes it and renders it in a cookie-isolated Browser Use context. The resulting PNG is model-only visual QA; it is not sent to Telegram, and the bot does not install missing tools.

## Prompt and inference caching

Normal turns keep the core system prompt, Office skill index, tool schemas, and prior Pi conversation stable as a reusable inference prefix. Fresh time, timezone, user, thread-title, and inherited-file metadata is rendered once at turn start into a bounded `<session_context>` block. Pi prepends that untrusted metadata ephemerally to the latest user message for each provider call; it is not written into persistent conversation history or compaction summaries. Attachment materialization remains closer to the current request, and a turn reuses one fixed metadata snapshot throughout its tool loop.

OpenRouter receives Pi's opaque session UUID as its sticky-routing affinity value. No Telegram identifier or descriptive metadata is used for affinity, and cache retention remains at the provider default. Long-lived prompt retention, explicit model cache-control blocks, and response caching are intentionally disabled.

Existing completion, cancellation, and failure logs include the final inference provider/model plus per-turn input, output, cache-read, cache-write, total-token, and cache-read-ratio fields when usage is available. A zero cache-read ratio can be normal for a first request, a short prefix, an expired cache, or an unsupported route.

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
- Optional Browser Use Cloud API key for interactive browsing and Office visual QA
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

The default database is SQLite. Set `DB_URL` to use PostgreSQL. On upgrade, the current release removes the obsolete host-file `path` column. Records with a Telegram or E2B source, extracted text, or search chunks remain in active thread scope. Host-only records without a recoverable source are retained as diagnostic rows but excluded from agent-visible thread scope. Physical files in the old host-storage directory are not deleted automatically.

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
E2B_FILE_SOURCE_MAX_BYTES=2147483648
TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000
TELEGRAM_FILE_RESTORE_CONCURRENCY=4
```

Use a distinct `E2B_DEPLOYMENT_ID` for each deployment sharing an E2B account. Do not change it casually: it is part of sandbox ownership and recovery.
`E2B_REQUEST_TIMEOUT_MS` applies to short control-plane operations. `E2B_FILE_SOURCE_MAX_BYTES` bounds immutable snapshots that still lack Telegram recovery; least-recently-verified snapshots are evicted first after the limit is crossed. `TELEGRAM_FILE_RESTORE_TIMEOUT_MS` is also the data-plane request budget for large E2B file uploads and downloads, so the default five-minute restore window is not shortened by the control timeout.

The bot creates secured sandboxes with public port traffic and internet access enabled, timeout action `pause`, memory preservation enabled, and automatic resume disabled. E2B's public-traffic setting is selected at sandbox creation and remains enabled so a persistent thread sandbox can later publish a requested site without destructive recreation. Agent guidance requires ordinary local services to bind to `127.0.0.1`; only an explicitly requested website may bind to `0.0.0.0` and proceed through `publish_website`.

## Browser Use Cloud configuration

```dotenv
BROWSER_USE_API_KEY=<secret>
BROWSER_USE_DEPLOYMENT_ID=ai-tg-bot
BROWSER_USE_DEFAULT_TIMEOUT_MINUTES=5
BROWSER_USE_IDLE_TIMEOUT_MS=300000
BROWSER_USE_API_TIMEOUT_MS=30000
BROWSER_USE_NAVIGATION_TIMEOUT_MS=45000
```

`web_search` and the one-shot, stateless `web_extract` tool always use Tavily. Screenshots, clicks, forms, login, downloads, scrolling, visual verification, and continued page work use the sequential `browser_*` tools.

The bot stores one opaque Browser Use profile mapping per Telegram user. Cookies and persistent browser storage follow that user across their Telegram threads, while tabs and element refs stay private to the thread that created them. Browser creation requires `proxyCountryCode: null`, never supplies a custom proxy, and disables recordings. If Browser Use nevertheless reports non-zero proxy usage or cost, the runtime fails closed and blocks further sessions until restart. Telegram identifiers, usernames, and names are never used as provider profile identifiers.

Normal screenshots use an adaptive regular-desktop viewport and are sent as Telegram photos. Full-page capture is reserved for explicit full/whole-page requests; document delivery is reserved for explicit “as a file/document” requests. Screenshots and browser files are attached directly without E2B. Browser files are size-bounded, checked against executable-file restrictions, and refused when their URL or any redirect resolves to a local/private address.

Cloud sessions use `BROWSER_USE_DEFAULT_TIMEOUT_MINUTES` (5 in the example above). `browser_open` can request 5–240 minutes for a new session. `browser_extend_session` explicitly stops and recreates the browser with the same profile, restoring owned URLs, scroll positions, and tab IDs while warning that transient page state is lost. Idle cleanup uses `BROWSER_USE_IDLE_TIMEOUT_MS` or stops shortly before provider expiry. The agent can call `browser_close_tab` for one thread-owned tab or `browser_close_session` after all browser work is complete; explicit session closure stops billing promptly and saves profile state without deleting the profile.

Keep the access key only in `.env`. It is redacted from client errors and never injected into E2B commands. Browser Use agent tasks, arbitrary page evaluation, cookie import, proxies, and recordings are not exposed.

## Public websites

The agent creates a dedicated site subdirectory, starts an HTTP server from that exact directory with `bash`, binds it to `0.0.0.0`, and detaches all inherited input/output so command capture can finish, for example:

```bash
mkdir -p /home/user/workspace/site
cd /home/user/workspace/site
nohup python3 -m http.server 3000 --bind 0.0.0.0 </dev/null >server.log 2>&1 &
```

It then calls:

```json
{"port": 3000, "site_dir": "/site", "path": "/"}
```

through `publish_website`. The bot rejects workspace-root or Telegram-file publication, verifies that the listening process is running from the declared site directory, and verifies the E2B HTTPS URL before returning it. The URL is public and unauthenticated. A request to create, start, host, or publish a website authorizes only its intended site contents; private attachments, unrelated workspace data, and credentials must not be added unless the user explicitly requested that material on the public site. A public URL is unavailable while its sandbox is paused; a later shell-backed bot request resumes the sandbox and its preserved process state.

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

With Browser Use Cloud configured:

```bash
npm run live:browser-use-check
```

The live check creates a randomized disposable profile, verifies a snapshot and PNG screenshot, explicitly closes the session, reopens with the same profile to verify cookie persistence, explicitly closes again, and deletes only that disposable profile before exiting.

Set `LIVE_TELEGRAM_FILE_ID` to exercise bot-mediated restoration, read-only
permissions, the custom toolbox contract, and ZIP creation during the live check.
