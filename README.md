# ai-tg-bot

A private Telegram agent built on persistent [Pi](https://github.com/earendil-works/pi) sessions. Pi owns inference, tool loops, conversation persistence, branching, cancellation, retries, and compaction. Codex OAuth is preferred; OpenRouter is the automatic fallback and the vector-embedding backend. Attachment storage is transport-neutral so another chat interface can supply remote locators without changing the Pi runtime.

Telegram controls who can reach the bot; there is no application-level allowlist. The bot accepts any sender delivered to its private chat and rejects group or supergroup use.

## Runtime model

- Each Telegram thread maps to one persistent Pi JSONL session under `PI_CODING_AGENT_DIR`. The database stores the session path/id and maps Telegram messages to Pi entry ids.
- Newly observed implicit Telegram topics receive one concise helper-model title from their opening user/assistant exchange. Explicit topic names, forks, General, and every thread that predates the title-state migration are preserved; helper or Telegram rename failures never fail the chat turn.
- Pi's built-in automatic compaction is used unchanged. `/compact` calls Pi directly and `/fork` creates a Pi branch at the mapped message entry.
- Built-in host filesystem tools are disabled. Pi receives only the bot's scoped tools: `bash`, `create_file`, `web_search`, `web_extract`, `search_thread`, `load_message`, `search_in_file`, `read_file_section`, and `generate_image`.
- Retrieval is explicit: prior messages use full-text search, while chunked large documents use full-text plus vector search. Nothing is automatically injected into prompts; Pi chooses when to call the retrieval tools.
- BoxLite provides one persistent 2-CPU/512-MiB/10-GB VM per Telegram user. Pi sessions remain per thread. Each thread starts in its own workspace, `/data/shared` is shared across that user's threads, and VM commands are serialized per user. `bash` starts the VM lazily and the bot stops it after ten idle minutes; the disk, installed user packages, and files survive stop/start. Chat files are copied into a per-call directory only when their exact IDs are passed in `input_file_ids`; those disposable copies cannot alter canonical snapshots.

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
- By design, generated originals are atomically saved under `MANAGED_FILE_ROOT/<file_id>/content`; they are not transient-only and that canonical directory is never mounted into user VMs. A successful `generate_image` result terminates Pi's tool loop, and the photo is sent from the current turn's delivery outbox before final text/draft cleanup. After Telegram accepts the photo, its `file_id` and `file_unique_id` are retained as recovery sources. If the local original is manually deleted, a later Telegram photo restoration may be a recompressed JPEG.
- Pi JSONL and tool results contain text metadata, never image base64.
- Incoming images are captioned once by an isolated Pi helper session. A Pi context hook injects bytes only for attachments newly received in the current turn or exact IDs explicitly selected with `load_message(file_ids: [...])`. Historical markers remain text-only, including after compaction.

The Codex request shape is adapted from the MIT-licensed [pi-better-openai](https://github.com/mattleong/pi-better-openai) implementation; that package is not installed.

### Attachment sources and cache

- The database stores logical file metadata plus one or more `file_sources` locators. Telegram locators contain `file_id`/`file_unique_id`; a future Matrix adapter can store an MXC URL and connection key in the same schema. Locators should reference a separately configured connection/auth profile and must not embed access tokens or other credentials.
- Original inbound attachments, generated images, and `create_file` outputs are atomically stored under `MANAGED_FILE_ROOT/<file_id>/content` with private permissions. The database stores the canonical path, while Pi JSONL and database rows remain free of raw bytes/base64. Ordinary BoxLite workspace files remain persistent but are not tracked as chat files until `create_file` is called.
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
- Optional external Docling server for DOCX, scanned PDFs, and PDFs whose native text extraction fails. TXT, CSV, searchable PDFs, chat, web, images, and BoxLite tools work without Docling.
- Persistent local paths for embedded BoxLite state and user workspaces; no BoxLite REST server or API key is used
- **Local Mac:** Apple Silicon, macOS 12 or later, and an ARM64 Node process. BoxLite uses Hypervisor.framework; Docker, `/dev/kvm`, Linux cgroups, and root are not needed.
- **Unraid container:** hardware virtualization with `/dev/kvm`, cgroup v2 mounted with `nsdelegate`, and Docker support for private writable cgroups (Docker Engine 28 or newer).

## Local macOS setup

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Run `node -p "process.platform + '/' + process.arch"` first and confirm it prints `darwin/arm64`. An Intel Mac or an x64 Node process running under Rosetta is not supported by the BoxLite macOS native package. The local defaults keep everything in the checkout:

```dotenv
BOXLITE_HOME=./data/boxlite
AGENT_SHARED_ROOT=./data/agent
MANAGED_FILE_ROOT=./data/agent/.chat-files
```

BoxLite uses macOS Hypervisor.framework and is initialized lazily by the first VM-backed tool. The first use may take longer while it downloads `BOXLITE_AGENT_IMAGE`. Run `npm run live:boxlite-check` for an isolated credential-free check of the configured image and guest user; it uses temporary runtime/workspace roots and does not touch the bot's configured data.

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
THREAD_TITLE_TIMEOUT_MS=30000
IMAGE_TIMEOUT_MS=300000
FILE_CACHE_DIR=/tmp/ai-tg-bot-files
FILE_CACHE_TTL_MS=3600000

BOXLITE_HOME=./data/boxlite
BOXLITE_AGENT_IMAGE=ghcr.io/karilaa-dev/ai-agent-box:sha-<commit>
BOXLITE_GUEST_USER=agent
AGENT_SHARED_ROOT=./data/agent
MANAGED_FILE_ROOT=./data/agent/.chat-files
```

BoxLite is embedded in the Node process and initialized only when the first VM-backed operation runs. Ordinary conversation, retrieval, web, image, and file-ingestion turns do not import the native module, inspect boxes, pull images, or start VMs. `BOXLITE_HOME` must be dedicated to one running bot process; never open the same home concurrently from another bot replica, a live check, or an external BoxLite daemon. If platform virtualization, container cgroups/namespaces, or home setup is unavailable, the bot still starts and online-only features continue; `bash` reports the deployment error, and initialization can be retried after the deployment is corrected. Any BoxLite REST key used by an earlier deployment should be rotated even though it is no longer configured here.

`BOXLITE_GUEST_USER` accepts a Linux username, numeric UID, or numeric `UID:GID`, including `root`, `0`, and `0:0`. The bot uses it for both VM provisioning and every command execution. It defaults to `agent`, matching the published `ai-agent-box` image. A named user must exist in the image; a numeric identity is passed directly, but the image must still provide any home directories and tool paths that commands expect. Use `root` or `0` for stock images such as `python:slim`. A nondefault value changes the provisioning fingerprint and replaces that user's existing VM disk on the next VM-backed command, while the bind-mounted `/data` workspace remains intact. In the supplied container, Node runs as configurable non-root `APP_UID:APP_GID` (default `1000:1000`), intentionally matching the published guest image so both sides can write the workspace.

`DOCLING_URL` is unset by default. Without it, native extraction handles searchable PDFs and retains useful short extracted text, while DOCX, scanned PDFs, and PDFs with no usable native text return a precise Docling-required message. Set `DOCLING_URL=https://docling.example` only when an external Docling server is available; the bot container does not bundle or supervise Docling.

`THREAD_TITLE_TIMEOUT_MS` applies only to the isolated, tool-free helper call used to name a new implicit topic. Each eligible topic normally adds one helper-model inference; failed generations can retry on up to three turns, while Telegram-only synchronization retries do not call the model again. See [.env.example](./.env.example) for file, Docling, bash, draft, onboarding, and logging settings.

## Migration warning

The first startup that applies `pi_cutover_v2` intentionally deletes all legacy conversations, messages, attachments, chunks, summaries, search entries, embeddings, and managed `data/files` contents. It preserves users, settings stored on users, and `data/bash` workspaces. The idempotent `remove_invites_v1` migration deletes the obsolete built-in access table and user attribution column. The later idempotent `chat_file_sources_v1` migration converts existing Telegram locator columns/rows into `file_sources`. The idempotent `remove_message_embeddings_v1` migration deletes obsolete message vectors while preserving messages, full-text indexes, file chunks, and chunk vectors. Thread-title state columns are non-destructive and classify all existing rows as explicit, so no existing topic is automatically renamed. Existing rows with `path = null` stay remote-only until one specific file is requested.

Before the BoxLite cutover, mount the shared filesystem and migrate legacy workspaces/managed originals:

```bash
# Local source checkout
npm run migrate:boxlite-data:dev
npm run migrate:boxlite-data:dev -- --apply

# Production Compose image
BOT_SHARED_HOST_PATH=/Volumes/boxlite docker compose run --rm bot npm run migrate:boxlite-data
BOT_SHARED_HOST_PATH=/Volumes/boxlite docker compose run --rm bot npm run migrate:boxlite-data -- --apply
```

In each pair, the first command is a dry run. Replace `/Volumes/boxlite` with the existing local mount path used by the bot. The migration maps each `thread-<id>` directory through its database owner, refuses symlinks, reports nonidentical conflicts instead of overwriting them, updates managed-file paths only after successful writes, and leaves the old tree untouched for rollback. A missed thread workspace is also promoted lazily on its first BoxLite `bash` call.

When replacing a REST deployment, stop both the bot and the old BoxLite daemon before cutover. Back up the database/Pi state, `/data`, and old BoxLite state; start the embedded runtime with a new dedicated `/var/lib/boxlite`; and let user VMs be recreated lazily. Never point the embedded runtime and old daemon at the same live runtime home. Keep the old state backup until representative workspaces, exports, stop/restart behavior, and graceful shutdown are verified.

SQLite is the default. PostgreSQL is selected when `DB_URL` begins with `postgres://` or `postgresql://`.

## Unraid: one container

Install [`templates/ai-tg-bot.xml`](./templates/ai-tg-bot.xml) as an Unraid Docker template and start the resulting `ai-tg-bot` container. This is the complete default deployment: Pi, SQLite, and the embedded BoxLite runtime all run in that one container. BoxLite's guest OCI image is downloaded lazily and runs as internal microVMs, not as additional Docker containers. No Compose stack, BoxLite daemon, REST key, PostgreSQL container, or Docling container is required.

Before starting it:

1. Enable hardware virtualization and confirm `/dev/kvm` exists on Unraid.
2. Keep the template's non-privileged KVM, private cgroup namespace, writable-cgroup, seccomp, and system-path parameters unchanged.
3. Configure the three required API keys and persistent paths for `/app/data`, `/data`, and `/var/lib/boxlite`.
4. Leave `Docling URL` empty unless a separately operated external Docling server is available.
5. Keep `APP_UID=1000`, `APP_GID=1000`, and `BOXLITE_GUEST_USER=agent` for the published guest image unless the selected image and filesystem ownership are deliberately changed together.

The entrypoint starts as root only to prepare persistent-directory ownership and delegated cgroups. It then executes Node as the configured non-root UID/GID with all capabilities cleared. If BoxLite preflight fails, the same container still serves online-only bot features and reports the deployment problem only when a VM-backed tool is requested.

## Optional Docker Compose development

```bash
docker compose up --build
```

The `bot-data` volume contains SQLite, Pi migration state, and the legacy `/app/data/bash` tree retained for rollback. `BOT_SHARED_HOST_PATH` is bind-mounted at `/data` and contains user workspaces plus canonical managed chat files. It is required, must already exist, and must be a normal local filesystem path (for example an Unraid share or `/Volumes/boxlite`), not an `smb://` URL. The separate `boxlite-home` volume is mounted at `/var/lib/boxlite` and stores the embedded runtime's images and VM state. Do not share that volume with another runtime.

The container starts its entrypoint as root only to prepare ownership, validate `/dev/kvm`, delegate `cpu`, `memory`, and `pids` in its private cgroup v2 namespace, and test namespace prerequisites. It then `exec`s Node through `setpriv` as non-root `APP_UID:APP_GID`, clears capabilities, and leaves no root supervisor. Compose does not use privileged mode, a Docker socket, host PID/network namespaces, or guest port publication. It does require `/dev/kvm`, `cgroup: private`, `seccomp=unconfined`, `systempaths=unconfined`, and `writable-cgroups=true`. A failed BoxLite preflight is logged and exported lazily to VM tools without stopping online-only bot functionality.

The VM image is published as `ghcr.io/karilaa-dev/ai-agent-box` by `.github/workflows/publish-ai-agent-box.yml` only when its isolated `docker/ai-agent-box` context or workflow changes. VM identity includes the configured image-reference string, so production must update `BOXLITE_AGENT_IMAGE` to a new immutable `sha-...` tag for each rollout. Repointing `latest` alone does not replace existing persistent VMs. See [`docker/ai-agent-box/README.md`](./docker/ai-agent-box/README.md) for GHCR visibility/authentication and image details.

The compatibility-named `codex-home` volume is mounted at `/app/data/pi` and contains Pi sessions and OAuth state. On the first upgraded startup, a Codex CLI `auth.json` in that volume is backed up as `auth.codex-cli.json` and converted to Pi's credential schema. The same migration detects the former Unraid `/app/data/codex/auth.json` location. It is idempotent and never logs token values.

BoxLite 0.9.7's default `gvproxy` networking and hostname allowlist do not by themselves prove that loopback, RFC1918/private ranges, link-local ranges, cloud metadata, IPv6-local destinations, literal private IPs, or DNS rebinding are blocked. If public-only VM egress is required, enforce it in the Unraid/host firewall and verify IPv4, IPv6, DNS, metadata, and host-service behavior separately; do not treat the VM setting as that boundary. No guest ports are published. Keep database files, Pi credentials, bot `.env`, and the BoxLite runtime home outside every per-user VM mount.

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

The Pi provider checks use configured auth. The BoxLite checks do not require Telegram, OpenRouter, Tavily, or Docling credentials:

```bash
npm run live:pi-check
npm run live:pi-fallback
npm run live:boxlite-python-check
npm run live:boxlite-workspace-check
npm run live:boxlite-check
```

The second command forces the shared Codex circuit open so the smoke turn must use OpenRouter. Each BoxLite live check creates one temporary base containing isolated runtime and shared roots, uses native embedded `JsBoxlite`, awaits `shutdown()`, and removes the base afterward. It never opens the production `BOXLITE_HOME` or touches the configured `AGENT_SHARED_ROOT`. The Python image check creates a temporary `python:slim` VM as `root`, runs Python without a shared mount, verifies marker output, and removes the VM.

The workspace check creates a uniquely named temporary `python:slim` VM as `root`. It verifies that a directly mounted thread workspace is visible and writable, starts a command with that workspace as the OCI working directory, and confirms the guest write on the temporary host root. This specifically verifies that the embedded runtime receives native volume options—the REST transport that previously dropped those options is no longer involved.

The full check uses the configured `BOXLITE_AGENT_IMAGE` and `BOXLITE_GUEST_USER`, initializes BoxLite lazily through `UserBoxRuntimeManager`, verifies that the configured guest can write `/data/shared`, confirms the marker from the host, waits for idle stop, verifies persistence after restart, and checks public HTTPS. The first run may take several minutes while the guest image is downloaded. It does not claim private-network isolation by default. To run deployment-specific deny-list connectivity probes, set `BOXLITE_EGRESS_DENY_TEST_URLS` to a comma-separated list of URLs that the host firewall should reject; a failed connection is useful diagnostic evidence but is not, by itself, a complete DNS-rebinding or address-range audit.
