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

For an OpenSandbox-era deployment, stop the old bot before upgrading and detach its former managed-file root from the new deployment. The E2B release never reads that directory, so every physical file below it is unreferenced after the database migration. It can remain on the old host as rollback material. Legacy generated files that were never delivered through Telegram cannot be imported automatically.

## Docker Compose

```bash
cp .env.example .env
# Fill in credentials and POSTGRES_PASSWORD.
docker compose up --build -d
```

The bot container has normal outbound access for E2B/provider APIs and a second internal-only network for PostgreSQL. It does not need a Docker socket, host workspace mount, privileged mode, or a local sandbox service.

## Dokploy / Railpack cutover

[`railpack.json`](railpack.json) pins Node 24.18, runs a deterministic `npm ci`, installs
`tini` and `setpriv`, and launches the normal non-root entrypoint. Dokploy must run one
application replica and attach a persistent named volume at `/app/data/pi`. Create a
separate Dokploy PostgreSQL service and configure the application with its explicit
`DB_URL`; do not set application-level `POSTGRES_PASSWORD`. Dokploy documents application
[volume mounts](https://docs.dokploy.com/docs/core/applications/advanced) and
[database restores](https://docs.dokploy.com/docs/core/databases/restore).

The only state transferred from the old Compose host is:

- a logical dump of the `aibot` PostgreSQL database;
- the complete `pi-home` volume, restored at the same `/app/data/pi` container path.

Do not transfer `bot-data`, `BOT_SHARED_HOST_PATH`, `.chat-files`, OpenSandbox workspaces,
outbox contents, or sandbox containers. Keep the same `BOT_TOKEN`: Telegram file IDs are
scoped to the bot that received them and cannot be transferred to another bot.

### 1. Snapshot the stopped source

Build the upgrade branch while the old deployment remains live. At the maintenance window,
stop only the bot and leave its PostgreSQL service running. Never run the old and new bot
simultaneously with the same token.

```bash
docker build -t ai-tg-bot-upgrade-audit .
docker compose stop bot

# Resolve these with `docker volume ls`; Compose normally prefixes the project name.
OLD_PI_VOLUME=<compose-project>_pi-home
OLD_DATABASE_NETWORK=<compose-project>_database

# Parse dotenv syntax without evaluating it as shell code. Put secrets in owner-only temporary
# files so neither the Docker command line nor the container environment contains their values.
AUDIT_SECRET_DIR=$(mktemp -d)
chmod 700 "${AUDIT_SECRET_DIR}"
trap 'rm -f -- "${AUDIT_SECRET_DIR}/db-url" "${AUDIT_SECRET_DIR}/bot-token"; rmdir -- "${AUDIT_SECRET_DIR}"' EXIT
node --env-file=.env --input-type=module -e '
  import fs from "node:fs";
  const [directory] = process.argv.slice(1);
  const password = process.env.POSTGRES_PASSWORD;
  const token = process.env.BOT_TOKEN;
  if (!password || !token) throw new Error("POSTGRES_PASSWORD and BOT_TOKEN are required");
  fs.writeFileSync(`${directory}/db-url`, `postgres://aibot:${encodeURIComponent(password)}@postgres:5432/aibot`, { mode: 0o600 });
  fs.writeFileSync(`${directory}/bot-token`, token, { mode: 0o600 });
' "${AUDIT_SECRET_DIR}"

# Keep the source UID/GID so the mode-0600 manifest is owned by the Pi volume identity.
SOURCE_APP_UID=$(node --env-file=.env -e 'const v=process.env.APP_UID||"1000"; if (!/^\d+$/.test(v)) throw new Error("APP_UID must be numeric"); process.stdout.write(v)')
SOURCE_APP_GID=$(node --env-file=.env -e 'const v=process.env.APP_GID||"1000"; if (!/^\d+$/.test(v)) throw new Error("APP_GID must be numeric"); process.stdout.write(v)')
SOURCE_E2B_DEPLOYMENT_ID=$(node --env-file=.env -e 'const v=process.env.E2B_DEPLOYMENT_ID||process.env.OPEN_SANDBOX_DEPLOYMENT_ID||"ai-tg-bot"; if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v)) throw new Error("sandbox deployment ID is invalid"); process.stdout.write(v)')
SOURCE_BROWSER_USE_DEPLOYMENT_ID=$(node --env-file=.env -e 'const v=process.env.BROWSER_USE_DEPLOYMENT_ID||"ai-tg-bot"; if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v)) throw new Error("Browser Use deployment ID is invalid"); process.stdout.write(v)')
HOST_OPERATOR_UID=$(id -u)

# Keep the host operator as owner while granting the source application GID read-only access.
docker run --rm \
  --mount "type=bind,source=${AUDIT_SECRET_DIR},target=/run/secrets" \
  --entrypoint sh \
  ai-tg-bot-upgrade-audit \
  -c 'chown "$1:$2" /run/secrets /run/secrets/db-url /run/secrets/bot-token && chmod 750 /run/secrets && chmod 440 /run/secrets/db-url /run/secrets/bot-token' \
  sh "${HOST_OPERATOR_UID}" "${SOURCE_APP_GID}"

docker run --rm \
  --user "${SOURCE_APP_UID}:${SOURCE_APP_GID}" \
  --network "${OLD_DATABASE_NETWORK}" \
  --mount "type=volume,source=${OLD_PI_VOLUME},target=/app/data/pi" \
  --mount "type=bind,source=${AUDIT_SECRET_DIR},target=/run/secrets,readonly" \
  -e DB_URL_FILE=/run/secrets/db-url \
  -e BOT_TOKEN_FILE=/run/secrets/bot-token \
  -e "E2B_DEPLOYMENT_ID=${SOURCE_E2B_DEPLOYMENT_ID}" \
  -e "BROWSER_USE_DEPLOYMENT_ID=${SOURCE_BROWSER_USE_DEPLOYMENT_ID}" \
  -e PI_CODING_AGENT_DIR=/app/data/pi \
  --entrypoint node \
  ai-tg-bot-upgrade-audit \
  dist/scripts/upgrade-audit.js snapshot --out /app/data/pi/upgrade-baseline.json

rm -f -- "${AUDIT_SECRET_DIR}/db-url" "${AUDIT_SECRET_DIR}/bot-token"
rmdir -- "${AUDIT_SECRET_DIR}"
trap - EXIT
```

The snapshot command is read-only with respect to the database and never initializes its
schema. Running it as the source application UID keeps the mode-0600 manifest readable from
the Pi volume. It fails on malformed Telegram locators, unsafe PostgreSQL sequences, missing
Pi sessions, or unsafe Pi runtime state files. Its manifest contains counts and keyed
HMAC-SHA-256 fingerprints—including the bot account identity and any Pi `auth.json`,
`models.json`, or `settings.json`—not chat text, credentials, or raw Telegram identifiers.
The same bot token is required to verify them. Database rows are read in bounded keyset pages
so the audit neither loads the full corpus at once nor repeatedly scans earlier pages.

Create the two transfer artifacts while the bot remains stopped:

```bash
docker compose exec -T postgres \
  pg_dump -Fc --no-owner --no-acl -U aibot aibot > aibot.dump

docker run --rm \
  --mount "type=volume,source=${OLD_PI_VOLUME},target=/source,readonly" \
  --mount "type=bind,source=$(pwd),target=/backup" \
  alpine:3.22 \
  tar -C /source -czpf /backup/pi-home.tgz .
```

Copy `aibot.dump` and `pi-home.tgz` to the Dokploy host. Leave the old database, Pi volume,
shared root, and OpenSandbox state stopped and unchanged for rollback.

### 2. Restore and deploy on Dokploy

Restore `aibot.dump` into the new Dokploy PostgreSQL service. Restore `pi-home.tgz` into the
named application volume before its first deployment, preserving the archive paths and
permissions. Mount that volume at `/app/data/pi`.

Configure these application variables in addition to the normal E2B/provider credentials:

```dotenv
DB_URL=postgresql://<user>:<password>@<dokploy-postgres-host>:5432/<database>
PI_CODING_AGENT_DIR=/app/data/pi
UPGRADE_BASELINE_FILE=/app/data/pi/upgrade-baseline.json
E2B_DEPLOYMENT_ID=<source E2B_DEPLOYMENT_ID, or old OPEN_SANDBOX_DEPLOYMENT_ID>
BROWSER_USE_DEPLOYMENT_ID=<source BROWSER_USE_DEPLOYMENT_ID, default ai-tg-bot>
APP_UID=<source APP_UID, default 1000>
APP_GID=<source APP_GID, default 1000>
```

Reusing the deployment ID preserves database namespaces and source metadata; it does not
transfer or reconnect old OpenSandbox files, workspaces, or containers. Do not configure
other legacy OpenSandbox variables or mounts. Ensure
`E2B_TEMPLATE=ai-tg-bot-tools:production` exists before deployment.

At first startup, the bot migrates the restored database transactionally, requires exact
membership for pre-existing datasets (including E2B thread mappings and sandbox restoration
history), verifies every baseline record and Telegram locator, checks the configured bot, E2B,
and Browser Use deployment identities and Pi runtime state, requires every referenced Pi JSONL
session to match its snapshotted size and byte content, and only then starts Telegram polling. Success writes
`upgrade-baseline.json.verified`, bound to the manifest hash; subsequent restarts skip the
one-time scan only while that exact manifest is unchanged.

Confirm the logs contain `upgrade preservation baseline verified`, `database initialized`,
and `bot started`. Then verify an old thread, `search_thread` recall, restoration of an old
Telegram attachment into a newly created E2B sandbox, and delivery of a new file. The baseline
check is intentionally a one-time cutover gate, not an ongoing integrity check: normal bot use
updates operational file/source fields and appends messages after startup.

After the verification and smoke tests pass, remove `UPGRADE_BASELINE_FILE` from the Dokploy
application variables and redeploy once. The manifest and success marker remain available as
cutover evidence, but the one-time gate is disarmed. This matters if the original pre-cutover
Pi archive is restored later: that archive contains the baseline but not the success marker,
so leaving the variable configured could re-run the obsolete baseline against a database that
has legitimately changed since cutover.

For rollback, stop the Dokploy application before restarting the old bot. The old host state
was never modified beyond stopping the bot and writing the baseline into `pi-home`; the dump
and Pi archive provide an additional recovery copy.

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
