# ai-tg-bot

`ai-tg-bot` is a private Telegram assistant built on persistent Pi sessions. Each Telegram thread gets its own persistent E2B sandbox when it first needs shell access.

## Runtime model

| Part | Behavior |
| --- | --- |
| Telegram | Receives messages and files, streams drafts, and sends generated files. |
| Pi | Keeps one conversation session per Telegram thread. |
| Database | Uses SQLite by default. Set `DB_URL` for PostgreSQL. |
| E2B | Gives each thread one isolated toolbox sandbox with a persistent filesystem and memory. |
| Browser Use Cloud | Adds optional interactive browsing, screenshots, downloads, and Office previews. |
| Tavily | Handles `web_search` and the stateless `web_extract` tool. |

Pi uses Codex OAuth when valid credentials are available. If Codex is not configured, or if a retryable Codex request fails before producing output, the bot uses OpenRouter. OpenRouter is still required for fallback inference and image generation.

## Requirements

- Node.js 24.18 or newer
- A Telegram BotFather token
- E2B, OpenRouter, and Tavily API keys
- Optional Codex CLI OAuth credentials for primary inference
- Optional Browser Use Cloud API key
- An E2B API key that can build the versioned toolbox template

## Local setup

```bash
cp .env.example .env
# Set BOT_TOKEN, E2B_API_KEY, OPENROUTER_API_KEY, and TAVILY_API_KEY.
npm install
npm run dev
```

To use Codex as the primary provider, sign in once with the official CLI:

```bash
codex login
```

The bot reads `~/.codex/auth.json` by default. Set `CODEX_AUTH_FILE` to use another location. The containing directory must be writable because OAuth refresh replaces `auth.json` atomically. A single-file bind mount will break refreshes.

An OAuth credential already stored in `PI_CODING_AGENT_DIR/auth.json` takes precedence over `CODEX_AUTH_FILE`. This keeps existing deployments compatible.

## Database

The default database is `sqlite:./data/bot.db`. PostgreSQL URLs use the usual `postgresql://` form.

## Dokploy

Dokploy can deploy this repository with Railpack auto-detection. Railpack runs `npm run build` and starts the bot with `npm start`.

Mount persistent storage at `/app/data`. SQLite remains the default; leave `DB_URL` unset or set it to `sqlite:/app/data/bot.db`, and set `PI_CODING_AGENT_DIR=/app/data/pi`. To use PostgreSQL, set `DB_URL` to an explicit `postgres://` or `postgresql://` URL.

Set the required Telegram, E2B, OpenRouter, and Tavily keys in Dokploy. Browser Use remains optional. For Codex primary inference, keep the credential directory on persistent storage and make it writable so token refresh can replace `auth.json`.

## E2B sandbox behavior

- The bot creates a sandbox only when a thread calls a shell-backed tool.
- `/home/user/workspace` is writable and persists across pause and resume.
- `/home/user/telegram-files` contains only files explicitly restored with `materialize_chat_files`. The bot keeps previous restorations additive and makes the directory read-only to agent commands. Copy a file into the workspace before editing it.
- `inspect_workspace_images` returns normalized workspace images to model vision for final raster and collage checks without sending the previews to Telegram.
- The database stores sandbox IDs. Recovery can also use deployment and thread metadata after a restart.
- A normal shell-backed turn arms a three-minute idle pause. A successful `publish_website` call uses 15 minutes for that turn.
- E2B Base allows one hour of continuous runtime. The manager pauses and reconnects near 55 minutes during long work, which resets that runtime window without discarding filesystem or memory state.
- Public traffic does not resume a paused sandbox. A later bot operation reconnects it.

There is no host bind mount, E2B volume, cross-thread shared directory, or canonical host file store. Telegram bytes pass through the bot during intake, sandbox restoration, and delivery.

The implementation follows E2B's current documentation for [sandboxes](https://e2b.dev/docs/sandbox), [persistence](https://e2b.dev/docs/sandbox/persistence), and [auto-resume](https://e2b.dev/docs/sandbox/auto-resume).

### Toolbox template

The bot derives its default private template from the application version. Version `2.0.0` uses `ai-tg-bot-tools:v2.0.0`. The template in [`e2b-template`](e2b-template/README.md) uses E2B Base with 2 vCPU and 2 GiB RAM. It includes OfficeCLI, OpenSCAD with `openscad-build`, ImageMagick, archive tools, Python, Node.js, Git and SSH clients, SQLite, compilers, and standard shell diagnostics. Chromium and browser automation packages are absent because Browser Use Cloud handles browser work.

No manual image release is required. When creation of a new sandbox reports that a managed template tag is missing, the bot builds and validates that tag, then retries creation once. Existing thread mappings reconnect their original sandboxes and never trigger a rebuild.

Prebuild and run the full live smoke when you want to warm the image before deploying:

```bash
npm run e2b:release
```

The command reads `package.json`, builds or reuses the corresponding `v<version>` tag, validates it, runs the full live runtime smoke, and prints the exact deployment reference. Generic build and promotion commands remain available for manual recovery.

### E2B settings

```dotenv
E2B_API_KEY=<secret>
# Optional override. The default for version 2.0.0 is ai-tg-bot-tools:v2.0.0.
# E2B_TEMPLATE=ai-tg-bot-tools:v2.0.0
E2B_DEPLOYMENT_ID=ai-tg-bot
E2B_REQUEST_TIMEOUT_MS=30000
E2B_FILE_SOURCE_MAX_BYTES=2147483648
TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000
TELEGRAM_FILE_RESTORE_CONCURRENCY=4
BASH_TIMEOUT_MS=120000
```

Use a different `E2B_DEPLOYMENT_ID` for each independently active bot deployment and database that share an E2B account. The value is part of sandbox ownership and recovery.

Keep `E2B_DEPLOYMENT_ID` unchanged during rolling upgrades. Existing thread sandboxes keep their original image and workspace. Only newly created sandboxes use the new application version tag. Do not delete `thread_sandboxes` mappings during a version change.

`E2B_REQUEST_TIMEOUT_MS` covers short control requests. `TELEGRAM_FILE_RESTORE_TIMEOUT_MS` covers Telegram restoration and large E2B file transfers. `E2B_FILE_SOURCE_MAX_BYTES` caps immutable snapshots for files that do not yet have a Telegram recovery source. `BASH_TIMEOUT_MS` allows exact OpenSCAD renders and other sandbox commands to run for up to two minutes. The bot removes or evicts old snapshots without touching the workspace copy.

The bot creates secure sandboxes with outbound internet and public port traffic enabled. Their lifecycle action is `pause`, memory is kept, and automatic resume is disabled. Ordinary services should bind to `127.0.0.1`. A requested public site may bind to `0.0.0.0` and must pass through `publish_website`.

## Files and retrieval

- Telegram is the durable source for inbound files and outbound files that Telegram accepted.
- `[[chat-file:<id>]]` markers are persistent Pi references.
- `load_message` can add selected attachment bytes to model context.
- Before sandbox work, the bot restores visible Telegram files into `/home/user/telegram-files`.
- Agent-created files get an E2B source locator. The bot reads them through the E2B SDK before delivery.
- DOCX, PDF, CSV, and text content is extracted and either placed inline or split into searchable chunks. Images receive model-generated captions.
- The per-file limit is 20 MiB. One answer can attach at most 25 created files.

The bot retries partial Telegram restoration with exponential delays from five minutes to one hour. Recreating a sandbox or changing a file descriptor triggers an immediate retry. Ambiguous send results are stored separately from confirmed deliveries.

Immutable outbound snapshots live under `/home/user/.ai-tg-bot/file-sources` until a durable Telegram source exists or the retention limit requires eviction. Orphan snapshots are removed automatically.

## Browser Use Cloud

```dotenv
BROWSER_USE_API_KEY=<secret>
BROWSER_USE_DEPLOYMENT_ID=ai-tg-bot
BROWSER_USE_DEFAULT_TIMEOUT_MINUTES=5
BROWSER_USE_IDLE_TIMEOUT_MS=300000
BROWSER_USE_API_TIMEOUT_MS=30000
BROWSER_USE_NAVIGATION_TIMEOUT_MS=45000
```

The bot stores one opaque Browser Use profile per Telegram user. Cookies and browser storage follow the user across threads. Tabs and element references remain private to the thread that created them.

Browser creation passes no custom proxy, sets `proxyCountryCode` to `null`, and disables recordings. The runtime stops accepting sessions if Browser Use reports proxy use or proxy cost. It never uses Telegram IDs, usernames, or names as provider profile IDs.

`browser_open` accepts 5 to 240 minutes for a new session. `browser_extend_session` replaces the active session with a longer one, using the same profile and restoring owned URLs, scroll positions, and tab IDs. Form values and other transient JavaScript state do not survive that replacement. `browser_close_session` stops billing and saves profile state.

Screenshots normally use a desktop viewport and go to Telegram as photos. Full-page capture and document delivery happen only when the user asks for them. Browser downloads bypass E2B, reject executable files, enforce size limits, and refuse URLs that resolve to private or local addresses.

Keep the Browser Use key in `.env`. Client errors redact it.

## Public websites

Build each site in its own workspace subdirectory. Start the server from that directory, bind to `0.0.0.0`, and detach all input and output so command capture can finish:

```bash
mkdir -p /home/user/workspace/site
cd /home/user/workspace/site
nohup python3 -m http.server 3000 --bind 0.0.0.0 </dev/null >server.log 2>&1 &
```

Then call `publish_website` with:

```json
{"port": 3000, "site_dir": "/site", "path": "/"}
```

The bot rejects the workspace root and Telegram-file directory. It also verifies the listener's working directory and the public HTTPS URL. Published URLs are public and unauthenticated. They stop responding while the sandbox is paused.

## Prompt and provider behavior

Normal turns keep the core system prompt, Office skill index, tool schemas, and prior Pi history stable. The bot creates one bounded `<session_context>` snapshot per turn for current time, timezone, user metadata, thread title, and inherited files. This untrusted block is not written to Pi history or compaction summaries.

OpenRouter receives the opaque Pi session UUID for route affinity. No Telegram identifier or descriptive metadata is used. The bot does not opt into long-lived prompt retention, explicit cache-control blocks, or response caching.

Completion logs include the final provider and model. When the provider returns usage, logs also contain input, output, cache-read, cache-write, total-token, and cache-read-ratio fields.

## Telegram commands

- `/lang`: change language
- `/timezone`: set the timezone
- `/stream`: toggle draft streaming
- `/stop`: cancel the active Pi turn
- `/fork`: branch the current Pi session into a Telegram topic
- `/compact`: compact Pi history
- `/help`: show command help

## Verification

Run the local checks before deploying:

```bash
npm run typecheck
npm test
npm run build
```

Provider checks require live credentials:

```bash
npm run live:pi-check
npm run live:pi-fallback
```

E2B and Browser Use each have an opt-in live check:

```bash
npm run live:e2b-check
npm run live:browser-use-check
```

Set `LIVE_TELEGRAM_FILE_ID` or `LIVE_TELEGRAM_FILE_IDS` for the E2B check to cover Telegram restoration, read-only permissions, the toolbox contract, and ZIP creation.
