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

Pi uses Codex OAuth when valid credentials are available. If Codex is not configured, or if a retryable Codex request fails before producing output, the bot uses OpenRouter. OpenRouter is still required for fallback inference, image generation, and audio transcription.

Telegram voice messages and audio messages are transcribed and used as prompts in the current thread. Captions are preserved alongside the transcript. `/stop` cancels downloading or transcription. Empty transcripts and failed requests show an error without starting an assistant turn. Audio is registered only after transcription succeeds, so failed or cancelled transcription leaves no unattached file records.

Long transcripts are saved in the database. Prompts and tool results include a bounded preview (up to 8,000 UTF-8 bytes, reduced for smaller model context settings) and a continuation ID. Call `transcribe_audio` with `transcript_id` and the returned `next_offset` as `offset` to read more without another transcription request. Saved transcripts follow thread and message visibility, including forks. Redelivered Telegram updates that already have an accepted turn skip downloading and transcription; failed updates remain retryable.

Transcription retries HTTP 429, 502, 503, and 504 responses up to twice on the selected model, honoring `Retry-After` when present and otherwise waiting one then two seconds. All attempts and waits share the configured transcription timeout, and `/stop` cancels retry waits. If rate limiting persists, the bot says so. Retries never switch models.

The `transcribe_audio` tool accepts a chat `file_id` or an absolute workspace `path`, with an optional `language` hint and `format` override. Both the tool and incoming audio prompts check the file's byte signature before uploading; a format hint must match the detected format. Audio uploaded as a document is kept as an attachment for this tool. Supported formats are WAV, MP3, FLAC, M4A, OGG/Opus, WebM, and AAC, up to 20 MB. Original audio stays available through its Telegram file reference. Both paths use [OpenRouter's transcription API](https://openrouter.ai/docs/guides/overview/multimodal/stt) with `qwen/qwen3-asr-1.7b` by default. Set `OPENROUTER_TRANSCRIPTION_MODEL` to choose another transcription model and `TRANSCRIPTION_TIMEOUT_MS` to change the 120-second request timeout.

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

- Bun 1.4.2
- A Telegram BotFather token
- E2B, OpenRouter, and Tavily API keys
- Optional Codex CLI OAuth credentials for primary inference
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

To use Codex as the primary provider, sign in once with the official CLI:

```bash
codex login
```

The bot reads `~/.codex/auth.json` by default. Set `CODEX_AUTH_FILE` to use another location. The containing directory must be writable because OAuth refresh replaces `auth.json` atomically. A single-file bind mount will break refreshes.

An OAuth credential already stored in `PI_CODING_AGENT_DIR/auth.json` takes precedence over `CODEX_AUTH_FILE`. This keeps existing deployments compatible.

## Database

The default database is `sqlite:./data/bot.db`. PostgreSQL URLs use the usual `postgresql://` form.

## Dokploy

Dokploy can deploy this repository with Railpack auto-detection. The `packageManager` field pins Bun 1.4.2, and `bun.lock` fixes dependency versions. Railpack runs `bun run build` and starts the bot with `bun run start`.

Mount persistent storage at `/app/data`. SQLite remains the default; leave `DB_URL` unset or set it to `sqlite:/app/data/bot.db`, and set `PI_CODING_AGENT_DIR=/app/data/pi`. To use PostgreSQL, set `DB_URL` to an explicit `postgres://` or `postgresql://` URL.

Set the required Telegram, E2B, OpenRouter, and Tavily keys in Dokploy. Browser Use remains optional. For Codex primary inference, keep the credential directory on persistent storage and make it writable so token refresh can replace `auth.json`.

## E2B sandbox behavior

- The bot creates a sandbox only when a thread calls a shell-backed tool.
- `/home/user/workspace` is writable and persists across pause and resume.
- `/home/user/telegram-files` contains only files explicitly restored with `materialize_chat_files`. The bot keeps previous restorations additive and makes the directory read-only to agent commands. Copy a file into the workspace before editing it.
- `generate_image` synthesizes or generatively edits one workspace asset when the user clearly requests it. Finding or arranging existing images uses retrieval and installed editing tools. A request for a document or presentation alone does not request generated artwork. The tool returns a model-only image preview, path, dimensions, and provider metadata. It neither queues delivery nor ends inference. Use chat-file IDs or workspace paths as references, five total. Explicitly requested artwork can be embedded in an Office file or sent through normal file delivery.
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

The bot derives its default private template from the application version. Version `2.0.14` uses `ai-tg-bot-tools:v2.0.14`. The template in [`e2b-template`](e2b-template/README.md) uses E2B Base with 2 vCPU and 2 GiB RAM. It includes docx-cli 0.25.0, PptxGenJS 4.0.1, python-pptx 1.0.2, openpyxl 3.1.5, headless LibreOffice Writer/Impress/Calc with compatible fonts, the OpenSCAD `2026.08.27` Node/WebAssembly engine with POV-Ray `3.7.0.10`, `openscad-build`, ImageMagick, archive tools, Python, Node.js, Git and SSH clients, SQLite, compilers, and standard shell diagnostics. OpenSCAD builds produce a compact binary STL and one exact rendered PNG by default. The image does not install an X server, OpenGL renderer, Chromium, or browser automation packages.

Release the versioned image before deploying a bot version that can create new sandboxes:

```bash
bun run e2b:release
```

The command reads `package.json`, builds or reuses the corresponding `v<version>` tag, validates it, runs the full live runtime smoke, and prints the exact deployment reference. If a configured image is missing, sandbox creation fails once with this release command in the error. The bot does not build images during a user turn. Existing thread mappings still reconnect their original sandboxes.

### E2B settings

```dotenv
E2B_API_KEY=<secret>
# Optional override. The default for version 2.0.14 is ai-tg-bot-tools:v2.0.14.
# E2B_TEMPLATE=ai-tg-bot-tools:v2.0.14
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
bun run typecheck
bun run test
bun run build
```

Use `bun run test` to run the Vitest suite under Bun. `bun test` invokes Bun's separate test runner. The E2B toolbox contract tests also need Node.js 24 to exercise the scripts that run inside the sandbox.

Provider checks require live credentials:

```bash
bun run live:pi-check
bun run live:pi-fallback
```

`bun run live:pi-image-intent-check` checks the model's first action for retrieval and synthesis requests using the current prompts and tool schemas. It allows skill reads, then stops before executing the selected action. It makes live model calls without generating images, creating sandboxes, or sending Telegram messages. It does not check later tool choices or finished deliverables.

`bun scripts/live-pi-presentation-check.ts` exercises a plain Russian request for a Tokyo presentation, without adding instructions about imagery or tools. It saves the PPTX, PDF, rendered slides, and trace to a temporary directory (or `PRESENTATION_OUTPUT_DIR`), checks substantial imagery on at least two slides, and verifies delivery approval without a technical caption. This live check uses the configured model, search, and E2B accounts and sends no Telegram messages. Review its rendered slides separately; image counts do not measure design quality.

E2B and Browser Use each have an opt-in live check:

```bash
bun run live:e2b-check
bun run live:browser-use-check
```

Set `LIVE_TELEGRAM_FILE_ID` or `LIVE_TELEGRAM_FILE_IDS` for the E2B check to cover Telegram restoration, read-only permissions, the toolbox contract, and ZIP creation.

## Harness benchmark

Run the CAD benchmark with real inference and E2B while all Telegram delivery is mocked:

```bash
bun scripts/benchmark-harness.ts --provider codex --runs 3 --out data/benchmark-codex.jsonl
bun scripts/benchmark-harness.ts --provider openrouter --runs 3 --out data/benchmark-openrouter.jsonl
```

`--repo /path/to/checkout` measures another version with the same driver. That checkout needs its dependencies and released E2B image. The script uses a temporary SQLite database and Pi directory, and a separate E2B deployment namespace. Each pair uses a new sandbox for the cold run and the same sandbox with a cleared workspace and fresh model session for the warm run. Provider-side prompt caching is measured but cannot be reset. It removes its own sandboxes and temporary sessions afterward. These are live API calls and use the configured accounts.

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

Open **All usage & cost** or **Usage for this person** for token statistics, daily token and estimated-cost graphs, model breakdowns, and thread totals. These reports offer 7, 30, 90 days, or all time. Daily buckets use UTC and refresh every 30 seconds while the page is visible. Each conversation shows its all-time token total and estimated USD cost above the messages in a large summary. Totals load automatically and refresh every 30 seconds while the page is visible. Expand **Details** for token categories, cache hit rate, models, and recorded turns, using the same compact breakdown as message usage; selecting a thread in a usage report opens the conversation with these details expanded. Expand the token count beneath a bot reply for its input, output, cache reads, cache writes, reported reasoning, model calls, and estimated USD cost. A reply's usage includes the tool loop that produced it. Thread totals include only calls made in that thread, so inherited messages are not charged twice.

Cost estimates follow [ccusage's token calculation method](https://ccusage.com/guide/cost-modes), multiplying each token category by its current [LiteLLM rate](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). The server downloads the public catalog on demand, caches it for 24 hours, keeps the last successful catalog during outages, and retries failures after five minutes. No conversation data is sent to the pricing source. New turns retain per-call models, context sizes, one-hour cache writes, and reported reasoning; reasoning is already part of output. Context pricing tiers apply per call. Recorded compaction, branch-summary, and tool tokens are included; entries without model attribution use their saved costs when available. Older saved turn totals use their recorded model and standard rates. Saved nonzero model costs provide a fallback when a rate is unavailable. Missing usage or pricing is labeled, and partial totals are marked. These are API-equivalent estimates, not subscription bills; image generation, transcription, sandbox, search, and other tool fees are excluded. Historical estimates can change with current rates. Usage is saved after inference even when cancellation or delivery failure follows; abrupt process loss can still leave a turn untracked.

Use the sun/moon button to switch between light and dark themes. The initial theme follows your system setting; an explicit choice is saved in your browser. Image attachments reserve preview space while loading. Expand **Image details** to see the saved description, filename, size, format, and loaded dimensions.

Attachments up to 5 MiB load into the page automatically with at most three concurrent downloads. Raster images and plain text have previews. Audio loads into a player without autoplay, with saved speech under **Transcription**. Photo descriptions and audio transcripts are separated from the message caption. Other files have a **Save** link. Larger or unknown-size files require **Load file** first. `WEB_AUTOLOAD_MAX_BYTES=0` disables automatic loading. The existing 20 MiB file resolver limit still applies. Files whose Telegram or E2B sources are unavailable show a retry action. The browser tries Telegram and other non-sandbox copies before E2B. If an E2B file needs a connection, the page asks before starting or resuming its sandbox. A sandbox resumed for retrieval pauses immediately after success, failure, or cancellation; sandboxes already serving bot work stay available to it. Browsing never starts an AI turn. HTML and SVG attachments are downloads, and external Markdown images are not fetched.

The frontend uses React, Tailwind, [Rare UI Hook Sidebar](https://www.rareui.com/components/hooksidebar), and [Rare UI Code Block](https://www.rareui.com/components/codeblock). Rare UI components are copied into the repository; the sidebar uses ordinary links in place of Next.js routing.

For a local preview with synthetic conversations and files, run `bun test/web/http-smoke.ts --preview --web-dev`, then open `http://127.0.0.1:3005`. To preview production assets, run `bun run build:web` and omit `--web-dev`. This uses an in-memory database and does not contact Telegram or E2B. `bun run test` includes real Bun route and HTTP lifecycle tests. Set `TEST_POSTGRES_URL` to include the PostgreSQL repository tests; they use isolated schemas.
