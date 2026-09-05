# ai-tg-bot

`ai-tg-bot` is a private Telegram assistant built on persistent Pi sessions. Each Telegram thread gets its own persistent E2B sandbox when it first needs shell access.

## Runtime model

| Part | Behavior |
| --- | --- |
| Telegram | Receives messages and files, streams drafts, and sends generated files. |
| Pi | Keeps one conversation session per Telegram thread. |
| Database | Uses SQLite by default. Set `DB_URL` for PostgreSQL. |
| E2B | Gives each thread one isolated toolbox sandbox with a persistent filesystem and memory. |
| Browser Use Cloud | Adds optional interactive browsing, screenshots, and downloads. |
| Tavily | Handles `web_search` and the stateless `web_extract` tool. |

Pi uses Codex OAuth when valid credentials are available. If Codex is not configured, or if a retryable Codex request fails before producing output, the bot uses OpenRouter. OpenRouter is still required for fallback inference and image generation.

Accepted messages receive a 👀 reaction until their response finishes, fails, or is cancelled. Topic titles show ⏳ while that topic has queued or running work. Skill reads show the skill name in the tool status, for example `Loading skill pptxgenjs`. Indicator calls run in the background. Pending synchronization is stored in the database and retried after failures or restarts; unavailable or deleted Telegram messages are skipped. Indicator updates use the [Telegram Bot API](https://core.telegram.org/bots/api#setmessagereaction) and are best effort when Telegram rejects them.

## Agent harness

The core prompt, including optional browser guidance and runtime model identity, stays below 4,500 characters. Detailed Office, PDF, and CAD workflows live in approved skills. Each provider request receives the selected model's display name, such as `Model: GPT-6 Astra`; this line is absent from persistent conversation history.

`bash.inspect_images` combines command output with up to four workspace images. `finish_response({ text?, files? })` prepares final files and ends inference without another model request. It must be the only tool in its response. Partial failures retain successful attachments for repair. The normal OpenSCAD sequence is four model cycles: read the skill, build and inspect the preview, build and inspect final outputs, then finish with the STL and final photo.

Final text precedes attachments. Two preparation workers prefetch files while text or the previous batch uploads; sends preserve queue order. Only adjacent compatible files form albums. Export reservations, cached file bodies, prefetch, and uploads share a 40 MiB budget per turn. Workspace exports retain immutable E2B recovery sources; browser download bytes can spill to private temporary files that are removed after the turn. Generated image originals remain in the thread workspace and enter this queue only when selected for delivery.

Turn logs include model-cycle latency, token/cache usage, peak request context, file preparation latency, and first-text/first-file/last-file delivery times. Snapshot pruning runs at most once per minute during ordinary operations; source-preserving exports still force a check.

The [2.0.5 simplification report](docs/simplification-2.0.5.md) describes internal ownership, code reduction, and before/after validation results.

The [2.0.6 Office and image report](docs/office-tools-2.0.6.md) records replacement backends, delivery validation, live model workflows, sandbox upgrades, and measured resource usage.

The [2.0.7 review fixes](docs/office-review-2.0.7.md) cover formula and relationship compatibility, external resources, delivery labels, cleanup retries, and locked sandbox upgrades.

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
- `generate_image` creates or edits one workspace asset per call and returns a model-only image preview, path, dimensions, and provider metadata. It neither queues delivery nor ends inference. Use chat-file IDs or workspace paths as references, five total. The bot can generate supporting art, embed it in an Office file, and send only the finished document. Direct image requests use the same tool followed by normal file delivery.
- `validate_office_file` returns named package, format, rendering, and formula checks plus visual review coverage. `render_office_preview` converts actual saved DOCX/PPTX/XLSX files through LibreOffice and Poppler, returning up to four model-only page images without Browser Use. Record per-page `visual_reviews` with the returned `source_sha256`; rendering alone does not approve delivery.
- Office delivery requires every applicable check and every page review to pass for the exact exported bytes. Edits invalidate approval. Unvalidated browser downloads are staged in the workspace for review. Failed or incomplete checks withhold the file; successful delivery preserves the requested caption and keeps validation metadata internal. These checks do not certify Microsoft Office rendering, animations, or external workbook connections.
- `inspect_workspace_images` returns normalized workspace images to model vision for final raster and collage checks without sending the previews to Telegram.
- `web_search` accepts `include_images: true` for image URLs and descriptions. The presentation skill uses this to find relevant photographs and illustrations, inspect downloaded originals, and retain source credits. It also supports generated artwork where the subject benefits from it.
- The database stores sandbox IDs. Recovery can also use deployment and thread metadata after a restart.
- A normal shell-backed turn arms a three-minute idle pause. A successful `publish_website` call uses 15 minutes for that turn.
- E2B Base allows one hour of continuous runtime. The manager pauses and reconnects near 55 minutes during long work, which resets that runtime window without discarding filesystem or memory state.
- Public traffic does not resume a paused sandbox. A later bot operation reconnects it.

There is no host bind mount, E2B volume, cross-thread shared directory, or canonical host file store. Temporary outgoing spools last only for the current turn. Telegram bytes pass through the bot during intake, sandbox restoration, and delivery.

The implementation follows E2B's current documentation for [sandboxes](https://e2b.dev/docs/sandbox), [persistence](https://e2b.dev/docs/sandbox/persistence), and [auto-resume](https://e2b.dev/docs/sandbox/auto-resume).

### Toolbox template

The bot derives its default private template from the application version. Version `2.0.8` uses `ai-tg-bot-tools:v2.0.8`. The template in [`e2b-template`](e2b-template/README.md) uses E2B Base with 2 vCPU and 2 GiB RAM. It includes docx-cli 0.25.0, PptxGenJS 4.0.1, python-pptx 1.0.2, openpyxl 3.1.5, headless LibreOffice Writer/Impress/Calc with compatible fonts, the OpenSCAD `2026.08.27` Node/WebAssembly engine with POV-Ray `3.7.0.10`, `openscad-build`, ImageMagick, archive tools, Python, Node.js, Git and SSH clients, SQLite, compilers, and standard shell diagnostics. OpenSCAD builds produce a compact binary STL and one exact rendered PNG by default. The image does not install an X server, OpenGL renderer, Chromium, or browser automation packages.

Release the versioned image before deploying a bot version that can create new sandboxes:

```bash
npm run e2b:release
```

The command reads `package.json`, builds or reuses the corresponding `v<version>` tag, validates it, runs the full live runtime smoke, and prints the exact deployment reference. If a configured image is missing, sandbox creation fails once with this release command in the error. The bot does not build images during a user turn. Existing thread mappings still reconnect their original sandboxes.

### E2B settings

```dotenv
E2B_API_KEY=<secret>
# Optional override. The default for version 2.0.8 is ai-tg-bot-tools:v2.0.8.
# E2B_TEMPLATE=ai-tg-bot-tools:v2.0.8
E2B_DEPLOYMENT_ID=ai-tg-bot
E2B_REQUEST_TIMEOUT_MS=30000
E2B_FILE_SOURCE_MAX_BYTES=2147483648
TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000
TELEGRAM_FILE_RESTORE_CONCURRENCY=4
BASH_TIMEOUT_MS=120000
```

Use a different `E2B_DEPLOYMENT_ID` for each independently active bot deployment and database that share an E2B account. The value is part of sandbox ownership and recovery.

Keep `E2B_DEPLOYMENT_ID` unchanged during rolling upgrades. Existing thread sandboxes keep their original image and workspace. Only newly created sandboxes use the new application version tag. Existing sandboxes receive the same pinned Office bundle through a locked, idempotent installer. It preserves their workspace and file sources and removes the previous Office tools only after replacement capability checks pass. Do not delete `thread_sandboxes` mappings during a version change.

`E2B_REQUEST_TIMEOUT_MS` covers short control requests. `TELEGRAM_FILE_RESTORE_TIMEOUT_MS` covers Telegram restoration and large E2B file transfers. `E2B_FILE_SOURCE_MAX_BYTES` caps immutable snapshots for files that do not yet have a Telegram recovery source. `BASH_TIMEOUT_MS` allows exact OpenSCAD renders and other sandbox commands to run for up to two minutes. The bot removes or evicts old snapshots without touching the workspace copy.

The bot creates secure sandboxes with outbound internet and public port traffic enabled. Their lifecycle action is `pause`, memory is kept, and automatic resume is disabled. Ordinary services should bind to `127.0.0.1`. A requested public site may bind to `0.0.0.0` and must pass through `publish_website`.

## Files and retrieval

- Telegram is the durable source for inbound files and outbound files that Telegram accepted.
- `[[chat-file:<id>]]` markers are persistent Pi references.
- `load_message` can add selected attachment bytes to model context.
- Before sandbox work, the bot restores visible Telegram files into `/home/user/telegram-files`.
- Agent-created files get an E2B source locator. Delivery reuses buffered export bytes when available and reloads the durable source after eviction.
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

`npx tsx scripts/live-pi-presentation-check.ts` exercises a plain Russian request for a Tokyo presentation, without adding instructions about imagery or tools. It saves the PPTX, PDF, rendered slides, and trace to a temporary directory (or `PRESENTATION_OUTPUT_DIR`), checks substantial imagery on at least two slides, and verifies delivery approval without a technical caption. This live check uses the configured model, search, and E2B accounts and sends no Telegram messages. Review its rendered slides separately; image counts do not measure design quality.

E2B and Browser Use each have an opt-in live check:

```bash
npm run live:e2b-check
npm run live:browser-use-check
```

Set `LIVE_TELEGRAM_FILE_ID` or `LIVE_TELEGRAM_FILE_IDS` for the E2B check to cover Telegram restoration, read-only permissions, the toolbox contract, and ZIP creation.

## Harness benchmark

Run the CAD benchmark with real inference and E2B while all Telegram delivery is mocked:

```bash
node --import tsx scripts/benchmark-harness.ts --provider codex --runs 3 --out data/benchmark-codex.jsonl
node --import tsx scripts/benchmark-harness.ts --provider openrouter --runs 3 --out data/benchmark-openrouter.jsonl
```

`--repo /path/to/checkout` measures another version with the same driver. That checkout needs its dependencies and released E2B image. The script uses a temporary SQLite database and Pi directory, and a separate E2B deployment namespace. Each pair uses a new sandbox for the cold run and the same sandbox with a cleared workspace and fresh model session for the warm run. Provider-side prompt caching is measured but cannot be reset. It removes its own sandboxes and temporary sessions afterward. These are live API calls and use the configured accounts.
