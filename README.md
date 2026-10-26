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
| Web search | Codex hosted search through the existing Codex login. Optional Tavily fallback, image discovery, and stateless `web_extract`. |

Pi uses Codex OAuth when valid credentials are available. If Codex is not configured, or if a retryable Codex request fails before producing output, the bot uses OpenRouter. OpenRouter is still required for fallback inference, image generation, and audio transcription.

Telegram voice messages and audio messages are transcribed and used as prompts in the current thread. Captions are preserved alongside the transcript. `/stop` cancels downloading or transcription. Empty transcripts and failed requests show an error without starting an assistant turn. Audio is registered only after transcription succeeds, so failed or cancelled transcription leaves no unattached file records.

Long transcripts are saved in the database. Prompts and tool results include a bounded preview (up to 8,000 UTF-8 bytes, reduced for smaller model context settings) and a continuation ID. Call `transcribe_audio` with `transcript_id` and the returned `next_offset` as `offset` to read more without another transcription request. Saved transcripts follow thread and message visibility, including forks. Redelivered Telegram updates that already have an accepted turn skip downloading and transcription; failed updates remain retryable.

Transcription retries HTTP 429, 502, 503, and 504 responses up to twice on the selected model, honoring `Retry-After` when present and otherwise waiting one then two seconds. All attempts and waits share the configured transcription timeout, and `/stop` cancels retry waits. If rate limiting persists, the bot says so. Retries never switch models.

The `transcribe_audio` tool accepts a chat `file_id` or an absolute workspace `path`, with an optional `language` hint and `format` override. By default it returns one line per segment with its time range and speaker, such as `[1:05-1:12] Speaker 2: …`; the model can set `speaker_labels` or `timestamps` to `false` for plainer text. Incoming voice and audio prompts stay plain text. Both the tool and incoming audio prompts check the file's byte signature before uploading; a format hint must match the detected format. Audio uploaded as a document is kept as an attachment for this tool. Supported formats are WAV, MP3, FLAC, M4A, OGG/Opus, WebM, and AAC, up to 20 MB. Original audio stays available through its Telegram file reference. Both paths use [OpenRouter's transcription API](https://openrouter.ai/docs/guides/overview/multimodal/stt) with `microsoft/mai-transcribe-2` by default. Speaker labels use Azure diarization, so another model may return timestamps without speakers. Set `OPENROUTER_TRANSCRIPTION_MODEL` to choose another transcription model and `TRANSCRIPTION_TIMEOUT_MS` to change the 120-second request timeout.

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
- E2B and OpenRouter API keys. Web search needs Codex login or an optional Tavily key.
- Optional Codex CLI OAuth credentials for primary inference
- Optional Browser Use Cloud API key
- An E2B API key that can build the versioned toolbox template

## Local setup

Install [Bun 1.4.2](https://bun.com/docs/installation). The application and its scripts run on Bun. SQLite uses Bun's built-in `node:sqlite` API, including Unicode name search; existing database files need no conversion.

Bun loads `.env` automatically; environment variables supplied by your deployment take precedence. Configuration still passes through the same validation at startup.

```bash
cp .env.example .env
# Set BOT_TOKEN, E2B_API_KEY, and OPENROUTER_API_KEY.
bun install --frozen-lockfile
bun run dev
```

To use Codex as the primary provider, enable the [admin website](#conversation-website), sign in with a Telegram account listed in `WEB_ADMIN_USER_IDS`, and open **Codex connection**. Choose **Connect Codex**, open the OpenAI link, and enter the one-time code. Enable device code login in your ChatGPT security settings first. This uses [OpenAI's headless device-code flow](https://developers.openai.com/codex/auth#login-on-headless-devices) and needs no terminal login. You can use the same page to sign in again when credentials expire or to switch accounts.

Existing credentials from `codex login` still work.

The bot can read existing CLI credentials from `~/.codex/auth.json`. Set `CODEX_AUTH_FILE` to use another location. The containing directory must be writable because OAuth refresh replaces `auth.json` atomically. A single-file bind mount will break refreshes.

Website login saves credentials in `PI_CODING_AGENT_DIR/auth.json` and updates the running bot without restarting it. Pi credentials take precedence over `CODEX_AUTH_FILE`, including after a restart. Signing in through the website leaves the separate Codex CLI login file untouched.

Set `CODEX_FAST_MODE=true` to request the priority service tier for Codex main, helper, and image-generation requests. It defaults to `false`. OpenRouter requests never inherit this setting, including fallback after a Codex failure. Usage records retain the setting for each call, the requested tier, and the delivered tier when the provider reports it. Changing the environment later does not change those records.

## Database

The default database is `sqlite:./data/bot.db`. PostgreSQL URLs use the usual `postgresql://` form.

Threads and files have UUID identifiers, including API paths and attachment markers. Telegram user/chat/topic IDs remain Telegram IDs; message, turn and chunk IDs stay numeric for ordering. Startup migrates existing thread/file IDs and their relationships, search indexes and saved references in a transaction. The migration is recorded and does not repeat. Existing Pi session files are preserved while migrated copies use the new references.

External bookmarks using old numeric thread or file IDs need to be refreshed. Saved sandbox mappings are migrated; orphan remote E2B metadata whose database mapping was already lost cannot be reconciled during the offline migration.

The shared backend in `src/application` owns conversation authorization, turn acceptance, forking, compaction and settings. The durable turn coordinator receives a frontend adapter; Telegram mirroring and reactions live in the Telegram adapter. Both frontends use the same stored messages, model sessions and attachment resolver.

## Dokploy

Dokploy can deploy this repository with Railpack auto-detection. The `packageManager` field pins Bun 1.4.2, and `bun.lock` fixes dependency versions. Railpack runs `bun run build` and starts the bot with `bun run start`.

Mount persistent storage at `/app/data`. SQLite remains the default; leave `DB_URL` unset or set it to `sqlite:/app/data/bot.db`, and set `PI_CODING_AGENT_DIR=/app/data/pi` and `FILE_STORAGE_PATH=/app/data/files`. To use PostgreSQL, set `DB_URL` to an explicit `postgres://` or `postgresql://` URL.

Set the required Telegram, E2B, and OpenRouter keys in Dokploy. Tavily and Browser Use remain optional. For Codex primary inference and search, keep the credential directory on persistent storage and make it writable so token refresh can replace `auth.json`.

## Scheduled chats

Ask the bot to check something later or periodically, or choose **Schedule…** in a web chat's menu. The **Scheduled** page lets you edit, pause, resume, or delete schedules. Each conversation can have one schedule, either once at a future time or repeating every 60 minutes or longer. Repeating intervals measure elapsed time; an every-24-hours schedule can move by an hour on the local clock when daylight saving changes.

Schedules are stored in the database and run while the bot process is online, even if the website is closed. Results appear in the same conversation and its Telegram topic. After downtime, the bot runs one overdue check and advances to a future occurrence. Checks never overlap another turn in their chat and start at most once per hour per chat, including after edits or deletion and recreation. Archived chats do not run; revoked accounts have their schedules paused. Pausing or deleting stops future runs; use **Stop** in the conversation to cancel an already queued or running check.

Chat search shows message snippets and a conversation preview without marking the chat read. Unread indicators apply only to conversations originally created on the website.

## E2B sandbox behavior

- The bot creates a sandbox only when a thread calls a shell-backed tool.
- `/home/user/workspace` is writable and persists across pause and resume.
- `/home/user/telegram-files` contains only files explicitly restored with `materialize_chat_files`. The bot keeps previous restorations additive and makes the directory read-only to agent commands. Copy a file into the workspace before editing it.
- `generate_image` synthesizes or generatively edits one workspace asset when the user clearly requests it. Finding or arranging existing images uses retrieval and installed editing tools. A request for a document or presentation alone does not request generated artwork. The tool returns a model-only image preview, path, dimensions, and provider metadata. It neither queues delivery nor ends inference. Use chat-file IDs or workspace paths as references, five total. Explicitly requested artwork can be embedded in an Office file or sent through normal file delivery.
- `validate_office_file` returns named package, format, rendering, and formula checks plus visual review coverage. `render_office_preview` converts actual saved DOCX/PPTX/XLSX files through LibreOffice and Poppler, returning up to four model-only page images without Browser Use. Record per-page `visual_reviews` with the returned `source_sha256`; rendering alone does not approve delivery.
- Office delivery requires every applicable check and every page review to pass for the exact exported bytes. Edits invalidate approval. Unvalidated browser downloads are staged in the workspace for review. Failed or incomplete checks withhold the file; successful delivery preserves the requested caption and keeps validation metadata internal. These checks do not certify Microsoft Office rendering, animations, or external workbook connections.
- `inspect_workspace_images` returns normalized workspace images to model vision for final raster and collage checks without sending the previews to Telegram.
- `web_search` defaults to Codex hosted search when Codex is configured, including during OpenRouter inference. It returns a sourced answer, a complete `citations` list, and up to `max_results` discovery results. `CODEX_WEB_SEARCH_MODE=live` is the default and enables live web access; set `cached` for cache-only search. This app setting is independent of the Codex CLI search mode. `WEB_SEARCH_PROVIDER=auto` falls back to Tavily immediately while the Codex circuit breaker blocks requests, and permits a recovery attempt after its retry delay; `codex` or `tavily` forces a provider. Tavily requires `TAVILY_API_KEY` and also supplies image candidates for `include_images: true` in auto mode. Codex search reports that image discovery is unavailable instead of inventing image URLs. `web_extract` still requires Tavily; without it, use browser tools or Bash with curl for known URLs.
- The database stores sandbox IDs. Recovery can also use deployment and thread metadata after a restart.
- A normal shell-backed turn arms a three-minute idle pause. A successful `publish_website` call uses 15 minutes for that turn.
- E2B Base allows one hour of continuous runtime. The manager pauses and reconnects near 55 minutes during long work, which resets that runtime window without discarding filesystem or memory state.
- Public traffic does not resume a paused sandbox. A later bot operation reconnects it.

Sandbox workspaces are isolated and have no host bind mount or shared E2B volume. User-visible attachment bytes are retained separately in the bot's local file store. Temporary outgoing spools last only for the current turn.

The implementation follows E2B's current documentation for [sandboxes](https://e2b.dev/docs/sandbox), [persistence](https://e2b.dev/docs/sandbox/persistence), and [auto-resume](https://e2b.dev/docs/sandbox/auto-resume).

### Toolbox template

The bot derives its default private template from the application version. Version `2.1.3` uses `ai-tg-bot-tools:v2.1.3`. The template in [`e2b-template`](e2b-template/README.md) uses E2B Base with 2 vCPU and 2 GiB RAM. It includes docx-cli 0.26.0, PptxGenJS 4.0.1, python-pptx 1.0.2, openpyxl 3.1.5, headless LibreOffice Writer/Impress/Calc with compatible fonts, the OpenSCAD `2026.09.29` Node/WebAssembly engine with POV-Ray `3.7.0.10`, `openscad-build`, ImageMagick, archive tools, Python, Node.js, Git and SSH clients, SQLite, compilers, and standard shell diagnostics. OpenSCAD builds produce a compact binary STL and one exact rendered PNG by default. The image does not install an X server, OpenGL renderer, Chromium, or browser automation packages.

Default `python` and `python3` scripts can use Pillow, Requests, NumPy, pandas, Matplotlib, Beautiful Soup, and PyYAML without setup. Their versions and dependencies are pinned in the image and exercised by the live toolbox contract.

Release the versioned image before deploying a bot version that can create new sandboxes:

```bash
bun run e2b:release
```

The command reads `package.json`, builds or reuses the corresponding `v<version>` tag, validates it, runs the full live runtime smoke, and prints the exact deployment reference. Startup checks the managed image tag and stops with this release command if the tag is missing, before accepting messages. If the availability check cannot reach E2B, startup logs a warning and sandbox creation retries normally. Explicit third-party templates and template IDs are checked when creating a sandbox. The bot does not build images during a user turn. Existing thread mappings still reconnect their original sandboxes.

### E2B settings

```dotenv
E2B_API_KEY=<secret>
# Optional override. The default for version 2.1.3 is ai-tg-bot-tools:v2.1.3.
# E2B_TEMPLATE=ai-tg-bot-tools:v2.1.3
E2B_DEPLOYMENT_ID=ai-tg-bot
E2B_REQUEST_TIMEOUT_MS=30000
E2B_FILE_SOURCE_MAX_BYTES=2147483648
TELEGRAM_FILE_RESTORE_TIMEOUT_MS=300000
TELEGRAM_FILE_RESTORE_CONCURRENCY=4
BASH_TIMEOUT_MS=120000
```

Use a different `E2B_DEPLOYMENT_ID` for each independently active bot deployment and database that share an E2B account. The value is part of sandbox ownership and recovery.

Keep `E2B_DEPLOYMENT_ID` unchanged during rolling upgrades. Existing thread sandboxes keep their original image and workspace. Only newly created sandboxes use the new application version tag. Existing sandboxes receive the same pinned Office bundle through a locked, idempotent installer. It preserves their workspace and file sources and removes the previous Office tools only after replacement capability checks pass. Do not delete `thread_sandboxes` mappings during a version change.

Process shutdown drains local sandbox work and stops local renewal timers. It leaves each sandbox's provider timeout in place, so shutting down an older process does not pause a sandbox already used by its successor.

`E2B_REQUEST_TIMEOUT_MS` covers short control requests. `TELEGRAM_FILE_RESTORE_TIMEOUT_MS` covers Telegram restoration and large E2B file transfers. `E2B_FILE_SOURCE_MAX_BYTES` caps immutable snapshots for files that do not yet have a Telegram recovery source. `BASH_TIMEOUT_MS` allows exact OpenSCAD renders and other sandbox commands to run for up to two minutes. The bot removes or evicts old snapshots without touching the workspace copy.

The bot creates secure sandboxes with outbound internet and public port traffic enabled. Their lifecycle action is `pause`, memory is kept, and automatic resume is disabled. Ordinary services should bind to `127.0.0.1`. A requested public site may bind to `0.0.0.0` and must pass through `publish_website`.

## Files and retrieval

- Original Telegram uploads, website uploads and generated files are saved in `FILE_STORAGE_PATH` (default `./data/files`). Each filename is the file UUID; display names stay in the database. Writes are atomic and downloads verify byte size and SHA-256. Back up this folder alongside the database, including when using PostgreSQL.
- `[[chat-file:<id>]]` markers are persistent Pi references.
- `load_message` can add selected attachment bytes to model context.
- `materialize_chat_files` restores explicitly selected, visible files from either frontend into `/home/user/telegram-files` for sandbox work.
- Agent-created files retain local bytes before they enter the outgoing queue. Final delivery verifies and repairs that copy before publishing the attachment. Reused gallery images and recommendation thumbnails are also retained before the visual response is published. Downloading these files does not require a running sandbox.
- CSV and text content is placed inline or split into searchable chunks. DOCX and PDF uploads retain their original source and are inspected in the sandbox with the document tools. Images receive model-generated descriptions that exclude private attachment captions.
- Website uploads and created files support 50 MiB per file, matching the Telegram cloud Bot API multipart sending limit. Telegram-only downloads and audio transcription retain their separate 20 MiB limits. One answer can attach at most 25 created files.

Existing Telegram-only attachments and legacy database upload blobs are cached locally when read. New uploads are downloaded eagerly; no file extension is blocked. Keep the local storage folder accessible to every app instance using the same database.

Run `bun scripts/cache-visible-files.ts` against an initialized database to cache existing visible attachments in advance. It verifies each file, downloads recoverable originals from Telegram or legacy web blobs with two workers, and reports UUIDs it could not recover. By default it never starts a sandbox. Add `--recover-sandbox-sources` for a one-time recovery of older originals from saved sandbox snapshots; sandboxes resumed for a read are paused afterward. The command exits with status 1 if any original remains unavailable. Rerunning it safely reuses verified local copies.

The bot retries partial Telegram restoration with exponential delays from five minutes to one hour. Recreating a sandbox or changing a file descriptor triggers an immediate retry. Ambiguous send results are stored separately from confirmed deliveries.

Immutable outbound snapshots live under `/home/user/.ai-tg-bot/file-sources` until a downloadable Telegram source exists or the retention limit requires eviction. Generated files retain a durable local copy before delivery. Orphan snapshots are removed automatically.

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

Browser creation passes no custom proxy, sets `proxyCountryCode` to `null`, and disables recordings. Unexpected provider-reported proxy use or cost is logged without disabling subsequent sessions. The runtime never uses Telegram IDs, usernames, or names as provider profile IDs.

`browser_open` accepts 5 to 240 minutes for a new session. `browser_extend_session` replaces the active session with a longer one, using the same profile and restoring owned URLs, scroll positions, and tab IDs. Form values and other transient JavaScript state do not survive that replacement. `browser_close_session` stops billing and saves profile state.

Screenshots normally use a desktop viewport and go to Telegram as photos. Full-page capture and document delivery happen only when the user asks for them. Browser downloads bypass E2B, accept all file formats, enforce size limits, and refuse URLs that resolve to private or local addresses.

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

Normal turns keep the core system prompt and Office skill index stable. The bot persists a bounded `<session_context>` snapshot for current time, timezone, user metadata, thread title, and inherited files, then appends only changed fields and explicit file removals. Earlier messages remain unchanged, preserving the common request prefix for prompt caching. Each update also saves the full bounded state in local session details without sending that duplicate state to the model. After compaction, the app restores a full baseline from the state saved at that boundary; later turns append updates to it. Restart and fork replay use the same persisted state. Metadata remains untrusted data, and attachment tools still check current availability. Other context changes, such as tool-result pruning, tool definitions, or model changes, can still reduce cache reuse.

Manual `/compact` and automatic compaction use Codex's `remote_compaction_v2` protocol: send the full active history, current instructions, tools, reasoning effort and fast-mode setting, append a compaction trigger, and require a completed response with exactly one encrypted checkpoint. The new native window retains bounded user requests followed by that checkpoint and a fresh metadata baseline. Later requests replay this window plus new messages, without duplicating Pi's retained tail. Checkpoints survive restarts, forks and repeated compaction, and are replayed only for the same Codex model. Existing version-1 checkpoints remain readable.

Manual compaction records a chat action with queued/running status, elapsed time, and a saved completion or failure result. The website returns `202` with its message ID immediately and polls progress; Telegram `/compact` updates its status message. Both wait for the current reply before compacting. Guards inspect the current model context, including the retained summary and edited messages: at least 8,000 estimated tokens and 2,048 tokens beyond the configured retained tail are required. After any compaction, manual requests also require a 60-second cooldown and at least 2,048 tokens of new context. These checks survive restarts and forks. Message history remains visible, and an interrupted action stops showing as active when its heartbeat expires.

Pi also produces a readable summary for OpenRouter and model changes. Failed server compaction uses this portable summary; cancellation does not save a partial checkpoint. The automatic provider is registered as a Pi virtual model so context-limit errors trigger Pi's normal compact-and-retry flow. Set `CODEX_SERVER_COMPACTION=false` to use only Pi summaries. The implementation uses Pi's Codex transport directly and does not install the [example extension](https://github.com/algal/pi-openai-server-compaction).

Run `bun run live:codex-tools-check` with Codex credentials to verify hosted search, encrypted-checkpoint recall after reopening a temporary session, metadata updates, and a second compaction followed by forked recall. This check sends no Telegram messages and starts no sandbox.

Sessions initially expose `read`, `bash`, `finish_response`, `codemode`, `tool_search`, and `memo`. Specialist tools are registered but loaded only when searched for; Pi records changes to the active tool set in its transcript. Codemode can batch chat searches, file reads, and web research with structured results. Memory commands, workspace mutations, browser actions, image generation, publishing, and delivery cannot run inside scripts. Nested research calls share the turn's tool-call and failure limits. Only a direct `finish_response` completes delivery.

### Permanent memory

The bot includes a native TypeScript port of [OptMem](https://github.com/VictorTaelin/OptMem/tree/1fb164cf39028047781f72ac3bb1e5a691c1dcb0). Each Telegram user has one permanent memory shared across their threads, forks, model changes, and conversation compactions. Other users have separate stores. The main agent records facts with `memo note`, supplies summaries through `memo nap`, and reads its memory with `wake`, `recall`, and `zoom`. Helpers do not receive the memory tool. Existing thread-history search remains available.

Notes and summaries are stored in the application database selected by `DB_URL`, with support for SQLite and PostgreSQL. One global set of `OPTMEM_*` environment settings applies to everyone, using the original OptMem defaults when unset. Users can enable or disable their own memory with `/memory on` or `/memory off`, and browse saved notes with `/memory view`. The admin website also offers **Memories for this person** after selecting a user. Both views show dated notes, oldest first, with pagination and remain available when memory is disabled. Disabling keeps saved notes. Memory runs on the bot host, independently of E2B, with no Python process or background summarizer.

The port retains OptMem's append-only notes, binary summary tree, UTF-8 byte limits, merge order, snapshot paging, and agent-written compression protocol. `forget` drops summaries for rebuilding and never erases raw notes. See [the memory reference](docs/optmem.md) for commands, compatibility details, and verification.

Agent turns have no tool-call, model-cycle, repeated-failure, or total-duration limit by default. Set `PI_MAX_TOOL_CALLS`, `PI_MAX_MODEL_CYCLES`, `PI_MAX_CONSECUTIVE_TOOL_FAILURES`, `PI_MAX_IDENTICAL_TOOL_FAILURES`, or `PI_TURN_TIMEOUT_MS` to a positive integer to enable that limit; `0` disables it. Counts include nested codemode calls. `/stop` cancels an active turn even when these limits are disabled. Each provider request, including its streamed response, has a separate 15-minute deadline controlled by the positive integer `PI_REQUEST_TIMEOUT_MS` in milliseconds. Individual tool and network request timeouts remain separately configurable.

Run `bun run live:pi-tools-check` to verify parallel research, specialist discovery, and final completion with the configured provider. Set `PI_SMOKE_FORCE_OPENROUTER=1` to check fallback. The command uses a disposable session and database, sends nothing to Telegram, and reports the initial tool declaration size against declaring every bot tool.

Ownerless `running` or `awaiting_delivery` turns left by deployments before ownership leases are interrupted after 16 minutes without an update, so queued work can resume. Set `LEGACY_TURN_RECOVERY_GRACE_MS` to a positive integer in milliseconds to change this grace period. A positive `PI_TURN_TIMEOUT_MS` extends the grace period when its turn window plus one minute is longer. During rolling upgrades, allow enough time for work still running in an older deployment. Current turns with valid ownership leases can continue indefinitely.

At completed model-turn boundaries, the bot retains the latest six tool results and shortens older successful results containing images or more than 6,000 text characters. Summaries retain text excerpts and source/artifact references. Failed results, Office validation, and final delivery results are kept. These append-only context edits preserve raw history, usage, and branch history; only subsequent model requests use the shorter content.

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

Set `WEB_ENABLED=true` to serve user chat at `/` and the separate admin viewer at `/admin`. Everyone, admins included, signs in with Telegram, so the website requires Telegram login. Obtain dedicated **Client ID** and **Client Secret** values from BotFather's Telegram Login settings, register the exact callback `https://chat.example.com/api/auth/telegram/callback`, then configure:

```dotenv
WEB_ENABLED=true
WEB_TELEGRAM_CLIENT_ID=your-numeric-client-id
WEB_TELEGRAM_CLIENT_SECRET=your-dedicated-oauth-client-secret
WEB_PUBLIC_URL=https://chat.example.com
# Telegram accounts that also get the admin dashboard:
WEB_ADMIN_USER_IDS=123456789
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_AUTOLOAD_MAX_BYTES=5242880
```

`WEB_ADMIN_USER_IDS` is a comma-separated list of numeric Telegram IDs; leave it empty to keep the admin dashboard closed. The retired `WEB_ADMIN_TOKEN` and `BOT_ALLOWED_USER_IDS` settings are ignored.

Admins manage membership at **Admin → Allowed users**. Add a numeric Telegram user ID there before inviting that person to send `/start` to the bot. Ordinary messages never register a new account. The website requires the same approval and registered account. Removing an ID blocks subsequent bot activity and website requests, including downloads; existing website sessions lose chat access. The allowlist is readable and editable only through authenticated admin endpoints. On the first upgrade, existing registered users are added once; later restarts do not restore revoked access. Configured admins can open the dashboard before bot registration, so they can add the first user. Admin status alone does not grant chat access.

The chat shows all of the signed-in user's conversations already stored by the bot, including Telegram topics and inherited fork history. It uses the same durable turn queue, model sessions, files, memories, language, timezone, and streaming preference as Telegram. Users can send attachments, stop a reply, fork or compact a conversation, view and delete memories, search conversations, and change settings. Time zones are named IANA zones such as `America/Los_Angeles`, so daylight saving time follows the zone. A user without a time zone is asked above the composer to use the browser's zone or pick another in Settings, which searches zones by city or region and shows each zone's current time and offset; "Not now" is remembered on that device. An offset saved earlier in Telegram keeps working, and Settings offers to replace it with a named zone. The profile menu shows the user's Telegram profile photo, fetched through the Bot API (accounts without a visible photo show their initial), and an **Admin** link for accounts in `WEB_ADMIN_USER_IDS`. The chat interface supports English and Russian using the same language preference as Telegram; usage and cost reports remain in the admin dashboard at `/admin`. Creating a chat or fork on the website links a Telegram topic when private-chat topics are enabled and Telegram is available. If linking fails, the website conversation still works. Creating a fork from Telegram requires topics to provide a separate place to continue it.

Website messages are echoed by the bot in the linked Telegram topic as plain text after a globe icon. Bot responses reply to that echoed message, including file replies. Every message the bot sends to Telegram is silent, so neither echoes nor replies make a notification sound. Website turns use one static Telegram “Thinking…” message, edited into the final answer, while the website shows each reply's reasoning and tool calls as one chronological, collapsible chain with friendly English or Russian names. While a reply generates, the collapsed chain shows the current step and elapsed time; finished replies show how long they took (for example, “Worked for 32s”). The website uses the same chain during generation and after completion. Both frontends show the same saved replies. A deleted Telegram topic uses the existing titled-message fallback, and a rejected echo is marked in the web transcript without preventing the assistant from answering there.

Attachments accept every file format, including archives, videos, legacy Office documents, executables, and files without extensions. Unknown or binary formats are stored unchanged and made available to the sandbox; supported text and media keep their richer handling. Uploads allow at most 10 files of 50 MiB each (500 MiB total). Multipart uploads stream into private temporary files and are ingested one at a time; temporary files are removed on completion, rejection or cancellation. A reverse proxy may impose a lower total request limit. Native Telegram video and animation messages are accepted too. A durable local copy remains available when Telegram mirroring fails, and uploads only become visible to the bot after their message is accepted.

Telegram-created chats have a Telegram icon before their title. Blue dots indicate unread assistant replies. Read status is shared across website sessions and advances when the latest response is visible in a focused tab or the user interacts with the thread in Telegram. The [Telegram Bot API](https://core.telegram.org/bots/api) does not expose passive read receipts for ordinary bot chats or let bots clear the user's native unread badge.

[OpenUI](https://www.openui.com/) responses are available only in threads created on the website. That origin remains fixed when the conversation continues in Telegram. The assistant uses a trusted Kumo component library through `finish_response.openui`: connected causal flows with emphasized failure points, key-value panels, thumbnail recommendation rows with verified source links, photo galleries, charts and comparison tables. Guidance favors visuals that explain relationships or help a choice, and avoids merely repeating prose as a numbered list. Verified map links are supported; embedded maps are not. Its instructions use the OpenUI SDK prompt generator with the same validated component schemas. Pictures reference authenticated chat files; generated UI cannot fetch arbitrary image URLs. Source links accept HTTPS pages only and open without referrer information. Images actually rendered in a gallery or recommendation row replace their separate attachment rows; the visual keeps its own named download control. Unrepresented files and failed visual renders keep their ordinary attachments. Images load when first visible, share a three-request queue, and retry temporary busy responses automatically. Loaded images are cached in memory for the verified browser session (32 MiB of idle blobs, with displayed blobs retained until released); logout revokes the cache. Buttons submit ordinary chat messages. Website tool details separately show expandable arguments, results, status, and code; Telegram keeps its existing concise tool summaries. Generated UI labels follow the answer language, independently of website settings; new responses save that language and older responses infer it from their prose. Web-created conversations prioritize the website composition: text supplies the narrative while visuals carry structured detail without a duplicate prose list. Telegram keeps the text and important files with a localized placeholder linking to the website visualization. The UI is rendered after completion, and invalid payloads are suppressed while the accompanying text remains readable. Existing Telegram-created threads keep text and attachment replies.

`BOT_TOKEN` remains the bot's API credential; it is not an OAuth client secret and no secret is derived from it. All three OAuth settings are required together. `WEB_PUBLIC_URL` must be the canonical HTTPS origin, without a path or query (explicit loopback HTTP is supported for local setup). The user must already have started this bot in Telegram. Membership comes from the database allowlist managed on the admin page. Login uses authorization code with S256 PKCE, a browser-bound single-use state, nonce, and verified Telegram signatures, issuer, audience, expiry, and numeric `id` claim. Username and OIDC `sub` never authorize access.

User login creates a 12-hour HttpOnly, SameSite=Lax cookie, Secure over HTTPS. Each user may retain eight sessions; another sign-in revokes their oldest session. Logout revokes the current session immediately; restarting the process invalidates all user sessions and pending logins. The same session opens `/admin` only for accounts in `WEB_ADMIN_USER_IDS`; other accounts receive 403 from every admin API. The API always derives identity from the session and checks thread ownership before history, mutations, or downloads.

Behind a reverse proxy, set `WEB_TRUSTED_PROXY_IPS` to the comma-separated exact IP addresses of your trusted proxy hops (for example, `127.0.0.1,::1` for a local proxy). The proxy must overwrite `X-Forwarded-For` with the real client address or append the actual connecting peer. OAuth rate limits then use the first untrusted hop, walking from the socket toward the client. Forwarded headers from other peers are ignored. Without this setting, clients behind a proxy share its OAuth rate limits. CIDRs and hostnames are not accepted.

Admin membership APIs are `GET /api/admin/session`, `GET/POST /api/admin/allowed-users` and `DELETE /api/admin/allowed-users/:telegramId`. Adding an ID accepts `{telegramId}`; writes require the existing admin same-origin and CSRF headers.

The user API exposes `GET /api/chat/session`, `DELETE /api/chat/session`, `GET /api/auth/telegram/start`, and its callback. Authenticated routes are `GET /api/chat/avatar` (the profile photo, or 204 without one), `GET/POST /api/chat/threads`, `GET/POST /api/chat/threads/:threadId/messages`, `POST /api/chat/threads/:threadId/{stop,fork,compact,read}`, `GET/PATCH /api/chat/settings`, `GET /api/chat/memories?offset=0`, `DELETE /api/chat/memories/:memoryId`, and `GET /api/chat/usage?days=30` (days: 0, 7, 30, or 90). Lists use `offset`; thread search accepts `q` (up to 200 characters), matching titles and visible message text across fork boundaries. History accepts either `before` or `after`. Memory IDs are zero-based; deletion removes the saved text, clears cached summaries, and works while memory is disabled. Deleted IDs are never reassigned. Read acknowledgement accepts `{messageId}` for a visible message and advances a shared cursor monotonically. Thread creation accepts `{title?}` (up to 128 characters), fork accepts `{messageId?}`, and message submission accepts `{text,requestId}` JSON or multipart fields `text`, `requestId`, and repeated `files`. A request ID is 16–128 ASCII letters, digits, underscores, or hyphens; reuse it when retrying the same send. Uploads allow up to 10 files of 50 MiB each (500 MiB total), and text is limited to 32,000 characters. Settings accept `language` (`en`/`ru`), `timeZone` (an IANA name, or `null` to clear it), `streaming`, and `memoryEnabled`. The session response includes `admin`.

Every authenticated chat request, including downloads and logout, requires `X-Chat-User` matching the signed-in Telegram ID returned by the public session endpoint. This is an account assertion, never authentication: a tab left open for another account receives 401 before reading or changing the current account's data. Every user API write also requires `X-Chat-Request: 1`. Browser Origin and Sec-Fetch-Site must identify the same origin; CORS is not enabled. Download `GET /api/chat/threads/:threadId/files/:fileId?mode=download` uses the existing bounded resolver. Resuming a sandbox additionally requires a POST with `mode=download&sandbox=start` and `X-Conversation-Sandbox-Consent: start`. OAuth starts and API requests are rate-limited; oversized or slow bodies are rejected.

Run `bun install --frozen-lockfile`, `bun run build`, then `bun run start`. Both modes use Bun 1.4.2, pinned in `package.json`. The website defaults to disabled and opens no listener in that mode.

`bun run dev` watches the backend and enables Bun's HTML development server when `WEB_ENABLED=true`. React and Tailwind edits update the browser through HMR, preserving React state without a separate frontend build. Use this mode for local development: Bun serves source maps and development diagnostics. API responses and attachments retain the production privacy and consent checks.

`bun run build:web` bundles `src/web/client/index.html` with Bun and the Tailwind plugin. Production serves the generated JavaScript and CSS through `Bun.file`, with content hashes in filenames and immutable caching. HTML, conversation data, attachments, and errors use `Cache-Control: no-store`. The frontend targets current browsers with native JavaScript modules; Bun transpiles TypeScript and JSX but does not downlevel JavaScript syntax for older browsers.

`bun-plugin-tailwind` 0.1.2 embeds a Tailwind 4.1.14 compiler, separately from the installed `tailwindcss` styles. The existing UI and HMR have been checked with this combination; newer Tailwind compiler features require an updated plugin.

Point a reverse proxy hostname at port `3000`, or your configured `WEB_PORT`, with the website at `/`. Terminate HTTPS at the proxy, preserve the original `Host`, and set `X-Forwarded-Proto: https`. `/admin` signs in with Telegram and returns to the dashboard afterward. Conversation APIs, usage reports, file downloads, and Codex controls all require a Telegram session for an account in `WEB_ADMIN_USER_IDS`. Signing out of the chat ends admin access too; restarting the app invalidates all sessions. To revoke an admin, remove their ID and restart the app.

Persist the existing bot data volume as before; there is no separate website database. Allow GET, HEAD, POST, PATCH, and DELETE through the proxy. PATCH updates user settings. Admin mutations keep their separate `X-Admin-Request: 1` contract.

Open **Codex connection** to check saved credentials and start or cancel a headless login. The page shows a one-time code and an OpenAI verification link, then confirms when the bot has connected. Existing credentials remain in use until a new login succeeds. Persist the credential directory and keep it writable so login and refresh survive restarts. For Dokploy, set `PI_CODING_AGENT_DIR=/app/data/pi` so website logins are saved on the data volume. No Codex CLI installation is needed for website login.

Users appear by most recent activity. The browser uses saved usernames and names, with Telegram IDs as a fallback. Search accepts names, usernames, and IDs. The bot itself is excluded, including old records accidentally saved for it. Threads include archived conversations and inherited messages up to each fork point. The latest 50 messages open first; use **Load older** for earlier history. Visible lists and messages refresh every 10 seconds while the tab is active.

Open **Usage** or **Usage for this person** for token statistics, daily token and estimated-cost graphs, model breakdowns, and thread totals. These reports offer 7, 30, 90 days, or all time. Daily buckets use UTC and refresh every 30 seconds while the page is visible. The thread list and conversation header show when a response is queued, generating, sending, or stopping. Active conversations refresh every three seconds; inactive conversations refresh every ten seconds. Interrupted work and unavailable status are labeled. Each conversation shows its all-time token total and estimated USD cost above the messages in a large summary. Totals load automatically and refresh every 30 seconds while the page is visible. Expand **Details** for token categories, cache hit rate, models, and recorded turns, using the same compact breakdown as message usage; selecting a thread in a usage report opens the conversation with these details expanded. Expand the token count beneath a bot reply for its input, output, cache reads, cache writes, reported reasoning, model calls, and estimated USD cost. A reply's usage includes the tool loop that produced it. Thread totals include only calls made in that thread, so inherited messages are not charged twice.

Usage reports read historical records in pages of 500 from one consistent database snapshot and retain combined totals. Pricing loads before the snapshot opens. All-time totals and tables include the full history; daily graphs show up to the latest 365 days of the period. Pricing downloads are limited to 16 MiB; failed or oversized downloads retain the last successful catalog.

New turns capture usage at the provider response, including reported usage from failed attempts, in-turn summaries, hosted search, and image requests. This preserves calls that never become session entries and avoids counting tool or compaction entries twice. Expanded reply details show exact per-call counts and fast-mode history. Cache reads and cache writes are separate categories: a cached prefix can be reused many times, so reads can far exceed writes. The dashboard distinguishes a reported zero from a missing cache field. Missing writes cannot be inferred from uncached input or cache reads. Older records keep their saved counts; missing cache-reporting and fast-mode metadata remain unknown. Background work outside a reply's model turn is not attributed to that reply.

Cost estimates follow [ccusage's token calculation method](https://ccusage.com/guide/cost-modes), multiplying each token category by its current [LiteLLM rate](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). The server downloads the public catalog on demand, caches it for 24 hours, keeps the last successful catalog during outages, and retries failures after five minutes. No conversation data is sent to the pricing source. New turns retain per-call models, context sizes, one-hour cache writes, and reported reasoning; reasoning is already part of output. Context and service-tier pricing apply per call. A reported service tier takes precedence over the requested tier; if the provider omits it, the requested tier supplies the estimate. Missing priority rates are marked unpriced unless a saved cost is available. Recorded compaction, branch-summary, and tool tokens are included; entries without model attribution use their saved costs when available. Older saved turn totals use their recorded model and standard rates. Saved nonzero model costs provide a fallback when a rate is unavailable. Missing usage or pricing is labeled, and partial totals are marked. These are API-equivalent estimates, not subscription bills; image-generation fees, transcription, sandbox, search, and other tool fees are excluded; reported model tokens used by these tools are included when available. Historical estimates can change with current rates. Usage is saved after inference even when cancellation or delivery failure follows; abrupt process loss can still leave a turn untracked.

Use the sun/moon button to switch between light and dark themes. The initial theme follows your system setting; an explicit choice is saved in your browser. Image attachments reserve preview space while loading. Expand **Image details** to see the saved description, filename, size, format, and loaded dimensions.

Attachments up to 5 MiB load into the page automatically with at most three concurrent downloads. Raster images and plain text have previews. Audio loads into a player without autoplay, with saved speech under **Transcription**. Photo descriptions and audio transcripts are separated from the message caption. Other files have a **Save** link. Larger or unknown-size files require **Load file** first. `WEB_AUTOLOAD_MAX_BYTES=0` disables automatic loading. The 50 MiB file resolver limit applies; Telegram cloud sources retain their separate 20 MiB download cap. Files whose Telegram or E2B sources are unavailable show a retry action. The browser tries Telegram and other non-sandbox copies before E2B. If an E2B file needs a connection, the page asks before starting or resuming its sandbox. A sandbox resumed for retrieval pauses immediately after success, failure, or cancellation; sandboxes already serving bot work stay available to it. Browsing never starts an AI turn. HTML and SVG attachments are downloads, and external Markdown images are not fetched.

The frontend uses React, Tailwind, [Kumo](https://kumo-ui.com/) design tokens and button styles, and [Base UI](https://base-ui.com/) for accessible controls. The conversation archive, usage reports, memories, and account pages share light and dark themes and responsive layouts. Code blocks use Prism syntax highlighting with the same theme and controls.

For a local preview with synthetic conversations and files, run `bun test/web/http-smoke.ts --preview --web-dev`, then open `http://127.0.0.1:3005/admin` and sign in with `preview-admin-token`. The preview simulates Codex login with `DEMO-CODE` and completes after 30 seconds; do not enter that code on OpenAI. To preview production assets, run `bun run build:web` and omit `--web-dev`. This uses an in-memory database and does not contact Telegram or E2B. `bun run test` includes real Bun route and HTTP lifecycle tests. Set `TEST_POSTGRES_URL` to include the PostgreSQL repository tests; they use isolated schemas.

To preview the user chat with synthetic data, run `bun run build:web`, then `bun test/web/chat-preview.ts`, and open `http://127.0.0.1:3006`. This fixture provides a signed-in demo account, OpenUI replies, uploads, and settings without real Telegram login or model calls.

For browser interaction checks, install Chromium once with `bun node_modules/playwright-core/cli.js install --with-deps chromium`, then run `bun run build:web && bun run test:web:browser`. The admin checks cover rejected-token retry, mobile input sizing, chart label readability, and keyboard day selection. The chat checks use the real application bundle with controlled API responses to cover live drafts, sign-out races, account switching, and delayed send/create/fork callbacks. CI runs both after the production build. Run `bun test/web/chat-browser-smoke.ts` to check Bun's development bundle too.
