# ai-tg-bot

`ai-tg-bot` v3 is a private Telegram assistant built on the native Codex harness. Codex runs on the bot server; each Telegram conversation gets a persistent E2B sandbox only when a tool needs remote execution or files.

## Runtime model

| Part | Behavior |
| --- | --- |
| Telegram | Receives messages and files, streams drafts, and sends generated files. |
| Codex app-server | Keeps native conversation threads, model/tool loops, compaction, search, and image generation on the bot server. |
| Database | Uses SQLite by default. Set `DB_URL` for PostgreSQL. |
| E2B | Runs the native Codex executor in one isolated toolbox sandbox per conversation, with persistent filesystem and memory. |
| Browser Use Cloud | Adds optional interactive browsing, screenshots, and downloads. |
| OpenRouter and Tavily | Supply fallback inference, fallback image generation/search/extraction, and audio transcription. |

Codex `0.159.2` is pinned on the host and in the sandbox image. It uses the native subscription login and exposes native execution, patching, image viewing, web search, and image generation when the selected account/model supports them. If subscription authentication or service limits make Codex unavailable, the bot uses a small OpenRouter tool loop. Fallback keeps Tavily search/extraction and OpenRouter image generation available independently of the Codex subscription. A failure after native work has started is not replayed through fallback because that could repeat side effects. OpenRouter remains required for audio transcription.

Telegram voice messages and audio messages are transcribed and used as prompts in the current thread. Captions are preserved alongside the transcript. `/stop` cancels downloading or transcription. Empty transcripts and failed requests show an error without starting an assistant turn. Audio is registered only after transcription succeeds, so failed or cancelled transcription leaves no unattached file records.

Long transcripts are saved in the database. Prompts and tool results include a bounded preview (up to 8,000 UTF-8 bytes, reduced for smaller model context settings) and a continuation ID. Call `transcribe_audio` with `transcript_id` and the returned `next_offset` as `offset` to read more without another transcription request. Saved transcripts follow thread and message visibility, including forks. Redelivered Telegram updates that already have an accepted turn skip downloading and transcription; failed updates remain retryable.

Transcription retries HTTP 429, 502, 503, and 504 responses up to twice on the selected model, honoring `Retry-After` when present and otherwise waiting one then two seconds. All attempts and waits share the configured transcription timeout, and `/stop` cancels retry waits. If rate limiting persists, the bot says so. Retries never switch models.

The `transcribe_audio` tool accepts a chat `file_id` or an absolute workspace `path`, with an optional `language` hint and `format` override. Both the tool and incoming audio prompts check the file's byte signature before uploading; a format hint must match the detected format. Audio uploaded as a document is kept as an attachment for this tool. Supported formats are WAV, MP3, FLAC, M4A, OGG/Opus, WebM, and AAC, up to 20 MB. Original audio stays available through its Telegram file reference. Both paths use [OpenRouter's transcription API](https://openrouter.ai/docs/guides/overview/multimodal/stt) with `qwen/qwen3-asr-1.7b` by default. Set `OPENROUTER_TRANSCRIPTION_MODEL` to choose another transcription model and `TRANSCRIPTION_TIMEOUT_MS` to change the 120-second request timeout.

Accepted messages receive a 👀 reaction until their response finishes, fails, or is cancelled. Topic titles show ⏳ while that topic has queued or running work. Skill reads show the skill name in the tool status, for example `Loading skill pptxgenjs`. Indicator calls run in the background. Pending synchronization is stored in the database and retried after failures or restarts; unavailable or deleted Telegram messages are skipped. Indicator updates use the [Telegram Bot API](https://core.telegram.org/bots/api#setmessagereaction) and are best effort when Telegram rejects them.

## Agent harness

The core prompt, including optional browser guidance, stays below 5,000 characters. Detailed Office, PDF, and CAD workflows live in approved skills. Codex owns model identity and its native base instructions.

Codex uses native `exec_command`, `apply_patch`, and `view_image`. Fallback `bash.inspect_images` can combine command output with up to four workspace images. `finish_response({ text?, files? })` prepares final files and ends the turn after acknowledging its result to the harness. It must be the only tool in its response. Partial failures retain successful attachments for repair. The OpenSCAD workflow reads the skill, builds and inspects the preview, builds and inspects final outputs, then finishes with the STL and final photo.

Final text precedes attachments. Two preparation workers prefetch files while text or the previous batch uploads; sends preserve queue order. Only adjacent compatible files form albums. Export reservations, cached file bodies, prefetch, and uploads share a 40 MiB budget per turn. Workspace exports retain immutable E2B recovery sources; browser download bytes can spill to private temporary files that are removed after the turn. Native generated originals remain under `CODEX_HOME/generated_images` and enter this queue only when selected for delivery. Sandbox tools receive those known images automatically at the exact paths shown to Codex. Generating or directly delivering an image does not itself create an E2B sandbox.

Turn logs include model-cycle latency, token/cache usage, peak request context, file preparation latency, and first-text/first-file/last-file delivery times. Snapshot pruning runs at most once per minute during ordinary operations; source-preserving exports still force a check.

The [2.0.5 simplification report](docs/simplification-2.0.5.md) describes internal ownership, code reduction, and before/after validation results.

The [2.0.6 Office and image report](docs/office-tools-2.0.6.md) records replacement backends, delivery validation, live model workflows, sandbox upgrades, and measured resource usage.

The [2.0.7 review fixes](docs/office-review-2.0.7.md) cover formula and relationship compatibility, external resources, delivery labels, cleanup retries, and locked sandbox upgrades.

## Requirements

- Bun 1.4.2
- A Telegram BotFather token
- E2B, OpenRouter, and Tavily API keys
- Codex subscription login for primary inference, with OpenRouter available when that login is unavailable
- Optional Browser Use Cloud API key
- An E2B API key that can build the versioned toolbox template

## Local setup

Install [Bun 1.4.2](https://bun.com/docs/installation). The application and its scripts run on Bun. SQLite uses Bun's built-in `node:sqlite` API, including Unicode name search; existing database files need no conversion.

Bun loads `.env` automatically; environment variables supplied by your deployment take precedence. Configuration still passes through the same validation at startup.

```bash
cp .env.example .env
# Set BOT_TOKEN, E2B_API_KEY, OPENROUTER_API_KEY, and TAVILY_API_KEY.
bun install --frozen-lockfile
bun run dev
```

The bundled official CLI can sign in directly to the persistent native home:

```bash
CODEX_HOME=./data/codex bun node_modules/@openai/codex/bin/codex.js login --device-auth
```

`CODEX_HOME` defaults to `./data/codex`. Keep the whole directory writable and persistent, including its native authentication, conversation rollouts, generated images, and executor startup metadata. Codex owns OAuth refresh and replaces its token file atomically.

`CODEX_AUTH_FILE` can select another native CLI credential source. The bot imports that source into `CODEX_HOME`; use the same path as its native `auth.json` when you want one shared store. Without an explicit source, an existing native home is used first, then old Pi OAuth credentials are imported, then the standard `~/.codex/auth.json` is imported. Existing Pi credentials and sessions are read without rewriting their files. Do not bind-mount only `auth.json`; a writable containing directory is needed for refresh.

Set `CODEX_FAST_MODE=true` to request Codex's priority service tier for conversation turns. OpenRouter fallback does not inherit it. `CODEX_EXECUTABLE` optionally selects another host binary; the bundled pinned binary is the default.

## Upgrade from Pi

Preserve the existing database, `PI_CODING_AGENT_DIR`, `E2B_DEPLOYMENT_ID`, and `thread_sandboxes` mappings. Set `CODEX_HOME` to a new persistent writable directory and release `ai-tg-bot-tools:v3.0.0` before deployment. No database reset or sandbox deletion is required.

The first native resume imports the selected old Pi branch, preserving its compaction summary and active context, then records that native thread ID in the database. Later turns resume the native rollout; missing rollouts can be rebuilt from durable conversation history. Fork boundaries, accepted message visibility, attachment IDs, saved transcripts, historical usage, and workspace mappings remain in the existing database. Old Pi transcripts stay unchanged. The Pi libraries remain for reading legacy transcripts and compatibility checks; Pi is not the production inference loop.

Old paused E2B sandboxes resume in place with their existing tools. The bot never installs, updates, or repairs their toolbox. If missing or outdated tools block a task, it asks the user to recreate the chat; an old sandbox without a compatible native executor receives the same response. Deleted sandboxes are replaced, and every recoverable Telegram attachment visible to the conversation is restored automatically before the first operation.

## Database

The default database is `sqlite:./data/bot.db`. PostgreSQL URLs use the usual `postgresql://` form.

## Dokploy

Dokploy can deploy this repository with Railpack auto-detection. The `packageManager` field pins Bun 1.4.2, and `bun.lock` fixes dependency versions. Railpack runs `bun run build` and starts the bot with `bun run start`.

Mount persistent storage at `/app/data`. SQLite remains the default; leave `DB_URL` unset or set it to `sqlite:/app/data/bot.db`, set `CODEX_HOME=/app/data/codex`, and retain the previous `PI_CODING_AGENT_DIR=/app/data/pi` for legacy migration. To use PostgreSQL, set `DB_URL` to an explicit `postgres://` or `postgresql://` URL.

Set the required Telegram, E2B, OpenRouter, and Tavily keys in Dokploy. Browser Use remains optional. For Codex primary inference, keep the credential directory on persistent storage and make it writable so token refresh can replace `auth.json`.

## E2B sandbox behavior

- Connecting a Codex thread, chatting, searching the web, or generating a new image leaves E2B stopped. A native execution/filesystem operation or another sandbox-backed bot tool starts or resumes it automatically.
- `/home/user/workspace` is writable and persists across pause and resume.
- `/home/user/telegram-files` automatically receives all recoverable attachments visible to the conversation before sandbox access. `INDEX.json` records exact paths and restoration status. The directory remains read-only to agent commands; copy files into the workspace before editing them. No model-facing restoration or sandbox-start tool is required.
- Native `image_gen.imagegen` handles requested synthesis and generative edits. Fallback exposes `generate_image`. Finding or arranging existing images uses retrieval and installed editing tools. A document or presentation request alone does not authorize generated artwork. Generation continues the turn and does not send Telegram files; choose exact saved paths for normal delivery.
- `validate_office_file` returns named package, format, rendering, and formula checks plus visual review coverage. `render_office_preview` converts actual saved DOCX/PPTX/XLSX files through LibreOffice and Poppler, returning up to four model-only page images without Browser Use. Record per-page `visual_reviews` with the returned `source_sha256`; rendering alone does not approve delivery.
- Office delivery requires every applicable check and every page review to pass for the exact exported bytes. Edits invalidate approval. Unvalidated browser downloads are staged in the workspace for review. Failed or incomplete checks withhold the file; successful delivery preserves the requested caption and keeps validation metadata internal. These checks do not certify Microsoft Office rendering, animations, or external workbook connections.
- Native `view_image` provides image inspection. Fallback `inspect_workspace_images` and `bash.inspect_images` provide workspace previews without sending them to Telegram.
- Codex uses native live web search and source opening. Fallback uses Tavily `web_search` and `web_extract`, including `include_images: true`. Image retrieval follows the tools actually advertised by each provider.
- The database stores sandbox IDs. Recovery can also use deployment and thread metadata after a restart.
- A normal shell-backed turn arms a three-minute idle pause. A successful `publish_website` call uses 15 minutes for that turn.
- E2B Base allows one hour of continuous runtime. The manager pauses and reconnects before the limit at an operation boundary, preserving filesystem and memory. Active native turns renew their timeout without being paused by the maintenance timer.
- Public traffic does not resume a paused sandbox. A later bot operation reconnects it.

The native executor communicates through a local authenticated lazy WebSocket adapter and one persistent secure WebSocket to E2B. Its capability token belongs only to that sandbox; bot, Codex subscription, E2B, and OpenRouter credentials are not sent to the executor. Initialization overlaps the existing bounded attachment restoration pipeline. Ordinary requests forward their payloads directly; health checks and timeout renewal stay outside individual native commands. Startup metadata is cached on the bot host, while Telegram attachment bytes have no persistent host cache. Temporary outgoing spools last only for the current turn.

The implementation follows E2B's current documentation for [sandboxes](https://e2b.dev/docs/sandbox), [persistence](https://e2b.dev/docs/sandbox/persistence), and [auto-resume](https://e2b.dev/docs/sandbox/auto-resume).

### Toolbox template

The bot derives its default private template from the application version. Version `3.0.0` uses `ai-tg-bot-tools:v3.0.0`. The template in [`e2b-template`](e2b-template/README.md) uses E2B Base with 2 vCPU and 2 GiB RAM. It includes native Codex exec-server 0.159.2 and its authenticated WebSocket startup wrapper, docx-cli 0.26.0, PptxGenJS 4.0.1, python-pptx 1.0.2, openpyxl 3.1.5, headless LibreOffice Writer/Impress/Calc with compatible fonts, the OpenSCAD `2026.09.29` Node/WebAssembly engine with POV-Ray `3.7.0.10`, `openscad-build`, ImageMagick, archive tools, Python, Node.js, Git and SSH clients, SQLite, compilers, and standard shell diagnostics. OpenSCAD builds produce a compact binary STL and one exact rendered PNG by default. The image does not install an X server, OpenGL renderer, Chromium, or browser automation packages.

Release the versioned image before deploying a bot version that can create new sandboxes:

```bash
bun run e2b:release
```

The command reads `package.json`, builds or reuses the corresponding `v<version>` tag, validates it, runs the full live runtime smoke, and prints the exact deployment reference. If a configured image is missing, sandbox creation fails once with this release command in the error. The bot does not build images during a user turn. Existing thread mappings still reconnect their original sandboxes.

### E2B settings

```dotenv
E2B_API_KEY=<secret>
# Optional override. The default for version 3.0.0 is ai-tg-bot-tools:v3.0.0.
# E2B_TEMPLATE=ai-tg-bot-tools:v3.0.0
E2B_DEPLOYMENT_ID=ai-tg-bot
E2B_REQUEST_TIMEOUT_MS=30000
E2B_FILE_SOURCE_MAX_BYTES=2147483648
TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000
TELEGRAM_FILE_RESTORE_CONCURRENCY=4
BASH_TIMEOUT_MS=120000
```

Use a different `E2B_DEPLOYMENT_ID` for each independently active bot deployment and database that share an E2B account. The value is part of sandbox ownership and recovery.

Keep `E2B_DEPLOYMENT_ID` unchanged during rolling upgrades. Existing thread sandboxes keep their original image and workspace. Only newly created sandboxes use the new application version tag. Existing sandboxes keep their installed tools. A tool mismatch never triggers an automatic update or sandbox replacement. If old tools prevent completion, the bot asks the user to recreate the chat. Do not delete `thread_sandboxes` mappings during a version change.

`E2B_REQUEST_TIMEOUT_MS` covers short control requests. `TELEGRAM_FILE_RESTORE_TIMEOUT_MS` covers Telegram restoration and large E2B file transfers. `E2B_FILE_SOURCE_MAX_BYTES` caps immutable snapshots for files that do not yet have a Telegram recovery source. `BASH_TIMEOUT_MS` allows exact OpenSCAD renders and other sandbox commands to run for up to two minutes. The bot removes or evicts old snapshots without touching the workspace copy.

The bot creates secure sandboxes with outbound internet and public port traffic enabled. Their lifecycle action is `pause`, memory is kept, and automatic resume is disabled. Ordinary services should bind to `127.0.0.1`. The authenticated native executor listens on `0.0.0.0:8765`. A requested public site may bind to `0.0.0.0` and must pass through `publish_website`.

## Files and retrieval

- Telegram is the durable source for inbound files and outbound files that Telegram accepted.
- `[[chat-file:<id>]]` markers remain durable attachment references across migration, compaction, and forks.
- `load_message` can add selected attachment bytes to model context.
- Before sandbox work, the bot automatically restores all recoverable visible Telegram files into `/home/user/telegram-files`. Pause/resume reuses existing files; recreation restores them again.
- Agent-created files get an E2B source locator. Delivery reuses buffered export bytes when available and reloads the durable source after eviction.
- PDF and DOCX originals use sandbox source inspection; old extracted chunks remain available as a fallback. TXT/CSV content stays inline or searchable. Images retain model-generated captions and can be loaded into native vision context.
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

Normal turns keep the core prompt and reviewed skill index stable. A bounded untrusted `<session_context>` supplies time, timezone, user metadata, thread title, and visible inherited files. Native prompts use `exec_command`, `apply_patch`, `view_image`, native web search, and native image generation. OpenRouter prompts use its actual fallback tools. Neither path asks the model to start a sandbox or restore files.

Codex owns tool discovery and compaction. Bot tools remain available for conversation/file lookup, skills, Browser Use, Office checks, website publishing, and final delivery. The old custom codemode loop is not part of production. The OpenRouter fallback intentionally uses a smaller tool loop, with Tavily and the existing sandbox tools.

`CODEX_THINKING_LEVEL`, `CODEX_TURN_TIMEOUT_MS`, and `CODEX_REQUEST_TIMEOUT_MS` control reasoning, the optional overall turn deadline, and the positive per-request deadline. Old `PI_THINKING_LEVEL`, `PI_TURN_TIMEOUT_MS`, and `PI_REQUEST_TIMEOUT_MS` values remain compatibility defaults. The request deadline is 15 minutes by default; the turn deadline defaults to unlimited. Existing `PI_MAX_*` bot budget settings apply to both providers; zero keeps model cycles and tool calls unlimited. `/stop` cancels active inference and tool work.

Ownerless turns from older deployments use `LEGACY_TURN_RECOVERY_GRACE_MS` to allow abandoned queued work to recover. Current ownership leases continue to protect running turns during restarts and rolling upgrades.

Completion logs and saved usage keep the final provider/model and reported token/cache counts. Codex account unavailability falls back before model work can produce side effects. An operation already sent to a disconnected executor returns an explicit error and is never automatically replayed.

## Telegram commands

- `/lang`: change language
- `/timezone`: set the timezone
- `/stream`: toggle draft streaming
- `/stop`: cancel the active turn
- `/fork`: branch the conversation into a Telegram topic, preserving inherited visibility
- `/compact`: ask native Codex to compact the current conversation
- `/help`: show command help

## Verification

Run the local checks before deploying:

```bash
bun run typecheck
bun run test
bun run build
```

Use `bun run test` to run the Vitest suite under Bun. `bun test` invokes Bun's separate test runner. The E2B toolbox contract tests also need Node.js 24 to exercise the scripts that run inside the sandbox.

Provider checks require live credentials:

```bash
bun run live:codex-check
bun run live:codex-fallback
```

`CODEX_SMOKE_REQUIRE_PROVIDER=openai-codex` requires the native provider instead of silently accepting fallback. The native smoke includes old Pi history migration and restart/resume. These commands make live inference calls and send no Telegram messages.

The controlled executor smoke uses real E2B with a local Responses fixture, so it incurs sandbox usage without paid model inference:

```bash
bun run live:codex-executor-check
```

It verifies lazy creation, native shell/patch/image tools, native image paths, absence of host credentials, automatic attachment restoration, pause/resume, and recreation after deletion. Its attachment source is a deterministic Telegram fixture; the existing restoration pipeline is real. Disposable sandboxes and the temporary native home are removed afterward.

Additional live checks remain available:

```bash
bun run live:e2b-check
bun run live:browser-use-check
```

Set `LIVE_TELEGRAM_FILE_ID` or `LIVE_TELEGRAM_FILE_IDS` for the E2B check to exercise actual Telegram restoration, read-only permissions, the toolbox contract, and ZIP creation. Set `E2B_RESUME_FROM` to an older image tag for an isolated check that resume preserves its tools, workspace, and saved sources. Scripts named `live:pi-*` and `benchmark-harness.ts` retain legacy Pi behavior for compatibility comparisons; they do not exercise the v3 production inference loop.

## Conversation website

Set `WEB_ENABLED=true` to run a read-only conversation browser alongside the bot:

```dotenv
WEB_ENABLED=true
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_AUTOLOAD_MAX_BYTES=5242880
```

Run `bun install --frozen-lockfile`, `bun run build`, then `bun run start`. Both modes use Bun 1.4.2, pinned in `package.json`. The website defaults to disabled and opens no listener in that mode.

`bun run dev` watches the backend and enables Bun's HTML development server when `WEB_ENABLED=true`. React and Tailwind edits update the browser through HMR, preserving React state without a separate frontend build. Use this mode for local development: Bun serves source maps and development diagnostics. API responses and attachments retain the production privacy and consent checks.

`bun run build:web` bundles `src/web/client/index.html` with Bun and the Tailwind plugin. Production serves the generated JavaScript and CSS through `Bun.file`, with content hashes in filenames and immutable caching. HTML, conversation data, attachments, and errors use `Cache-Control: no-store`. The frontend targets current browsers with native JavaScript modules; Bun transpiles TypeScript and JSX but does not downlevel JavaScript syntax for older browsers.

`bun-plugin-tailwind` 0.1.2 embeds a Tailwind 4.1.14 compiler, separately from the installed `tailwindcss` styles. The existing UI and HMR have been checked with this combination; newer Tailwind compiler features require an updated plugin.

Point a reverse proxy hostname at port `3000`, or your configured `WEB_PORT`, with the website at `/`. Apply access restrictions in the proxy. The app has no password or authentication, and everyone who can reach its port can read all saved conversations. Terminate HTTPS at the proxy and avoid publishing the upstream port directly. Persist the existing bot data volume as before; there is no separate website database. The explicit **Start sandbox and load** action uses POST on the attachment URL; allow that method through the proxy. Ordinary browsing and downloads use GET.

Users appear by most recent activity. The browser uses saved usernames and names, with Telegram IDs as a fallback. Search accepts names, usernames, and IDs. The bot itself is excluded, including old records accidentally saved for it. Threads include archived conversations and inherited messages up to each fork point. The latest 50 messages open first; use **Load older** for earlier history. Visible lists and messages refresh every 10 seconds while the tab is active.

Open **All usage & cost** or **Usage for this person** for token statistics, daily token and estimated-cost graphs, model breakdowns, and thread totals. These reports offer 7, 30, 90 days, or all time. Daily buckets use UTC and refresh every 30 seconds while the page is visible. The thread list and conversation header show when a response is queued, generating, sending, or stopping. Active conversations refresh every three seconds; inactive conversations refresh every ten seconds. Interrupted work and unavailable status are labeled. Each conversation shows its all-time token total and estimated USD cost above the messages in a large summary. Totals load automatically and refresh every 30 seconds while the page is visible. Expand **Details** for token categories, cache hit rate, models, and recorded turns, using the same compact breakdown as message usage; selecting a thread in a usage report opens the conversation with these details expanded. Expand the token count beneath a bot reply for its input, output, cache reads, cache writes, reported reasoning, model calls, and estimated USD cost. A reply's usage includes the tool loop that produced it. Thread totals include only calls made in that thread, so inherited messages are not charged twice.

Usage reports read historical records in pages of 500 from one consistent database snapshot and retain combined totals. Pricing loads before the snapshot opens. All-time totals and tables include the full history; daily graphs show up to the latest 365 days of the period. Pricing downloads are limited to 16 MiB; failed or oversized downloads retain the last successful catalog.

Cost estimates follow [ccusage's token calculation method](https://ccusage.com/guide/cost-modes), multiplying each token category by its current [LiteLLM rate](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). The server downloads the public catalog on demand, caches it for 24 hours, keeps the last successful catalog during outages, and retries failures after five minutes. No conversation data is sent to the pricing source. New turns retain per-call models, context sizes, one-hour cache writes, and reported reasoning; reasoning is already part of output. Context pricing tiers apply per call. Recorded compaction, branch-summary, and tool tokens are included; entries without model attribution use their saved costs when available. Older saved turn totals use their recorded model and standard rates. Saved nonzero model costs provide a fallback when a rate is unavailable. Missing usage or pricing is labeled, and partial totals are marked. These are API-equivalent estimates, not subscription bills; image generation, transcription, sandbox, search, and other tool fees are excluded. Historical estimates can change with current rates. Usage is saved after inference even when cancellation or delivery failure follows; abrupt process loss can still leave a turn untracked.

Use the sun/moon button to switch between light and dark themes. The initial theme follows your system setting; an explicit choice is saved in your browser. Image attachments reserve preview space while loading. Expand **Image details** to see the saved description, filename, size, format, and loaded dimensions.

Attachments up to 5 MiB load into the page automatically with at most three concurrent downloads. Raster images and plain text have previews. Audio loads into a player without autoplay, with saved speech under **Transcription**. Photo descriptions and audio transcripts are separated from the message caption. Other files have a **Save** link. Larger or unknown-size files require **Load file** first. `WEB_AUTOLOAD_MAX_BYTES=0` disables automatic loading. The existing 20 MiB file resolver limit still applies. Files whose Telegram or E2B sources are unavailable show a retry action. The browser tries Telegram and other non-sandbox copies before E2B. If an E2B file needs a connection, the page asks before starting or resuming its sandbox. A sandbox resumed for retrieval pauses immediately after success, failure, or cancellation; sandboxes already serving bot work stay available to it. Browsing never starts an AI turn. HTML and SVG attachments are downloads, and external Markdown images are not fetched.

The frontend uses React, Tailwind, [Rare UI Hook Sidebar](https://www.rareui.com/components/hooksidebar), and [Rare UI Code Block](https://www.rareui.com/components/codeblock). Rare UI components are copied into the repository; the sidebar uses ordinary links in place of Next.js routing.

For a local preview with synthetic conversations and files, run `bun test/web/http-smoke.ts --preview --web-dev`, then open `http://127.0.0.1:3005`. To preview production assets, run `bun run build:web` and omit `--web-dev`. This uses an in-memory database and does not contact Telegram or E2B. `bun run test` includes real Bun route and HTTP lifecycle tests. Set `TEST_POSTGRES_URL` to include the PostgreSQL repository tests; they use isolated schemas.
