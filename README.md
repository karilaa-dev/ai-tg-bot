# ai-tg-bot

A private Telegram agent built on persistent [Pi](https://github.com/earendil-works/pi) sessions. Pi owns inference, tool loops, conversation persistence, branching, cancellation, retries, and compaction. Codex OAuth is preferred; OpenRouter is the automatic fallback and vector-embedding backend.

Telegram controls who can reach the bot. The bot accepts private-chat senders delivered by Telegram and rejects groups and supergroups; there is no separate application allowlist.

## Architecture

```text
Telegram / Pi bot container (non-root)
        |
        | OpenSandbox HTTP API + API key
        v
OpenSandbox lifecycle server (trusted Docker-socket service)
        |
        | Docker API
        v
One persistent runner container per Telegram user
        |
        | host bind
        v
<shared-root>/users/<userId>  ->  /data
```

- Each Telegram thread maps to one persistent Pi JSONL session under `PI_CODING_AGENT_DIR`.
- Pi receives only the bot's scoped tools: `bash`, `create_file`, `web_search`, `web_extract`, `search_thread`, `load_message`, `search_in_file`, `read_file_section`, and `generate_image`.
- OpenSandbox provides one persistent command environment per Telegram user. Commands are serialized for the same user while different users can execute concurrently.
- Every thread starts in `/data/threads/<threadId>/workspace`; `/data/shared` is shared across that user's threads.
- The first sandbox-backed operation lazily connects to OpenSandbox and creates or resumes the user's environment. Healthy idle environments are paused, not destroyed, so files and the retained container state survive pause/resume and bot restarts.
- Chat attachments are copied into an immutable per-call staging directory only when Pi passes their exact IDs. Canonical chat files live outside `users/` and are never mounted into a sandbox.
- Online conversation, retrieval, web, image, and ingestion turns do not require OpenSandbox. If the service is unavailable, only sandbox-backed tools fail, and later calls retry initialization.

## Provider routing

The internal `telegram-auto/main` and `telegram-auto/helper` models route through Pi's existing providers:

1. Use Pi's `openai-codex` OAuth credentials when configured.
2. Use OpenRouter when Codex is not configured.
3. Before output begins, fall back for quota/429, OAuth refresh, network, timeout, and retryable 5xx failures.
4. Do not fall back after partial output or for context overflow, policy, invalid-request, or tool errors.

Main, helper, and image calls share one Codex circuit breaker. While it is open, requests use OpenRouter and only one half-open Codex probe is allowed at a time.

## Files, images, and retrieval

- `generate_image` creates or edits one PNG, JPEG, or WebP with up to five current-thread image references. Generated originals are saved under `MANAGED_FILE_ROOT/<file_id>/content` and delivered immediately.
- Original inbound attachments and `create_file` outputs are also persisted under `MANAGED_FILE_ROOT`. Pi JSONL and database rows contain metadata, not raw bytes or base64.
- `[[chat-file:<id>]]` markers are durable Pi references. `search_thread` and metadata-only `load_message` discover older files; selecting exact IDs restores only those files.
- Large documents use full-text plus vector chunk search. Searchable PDFs have native extraction; DOCX, scanned PDFs, and PDFs without usable native text require an optional external Docling service.
- Sandbox exports are copied through a private outbox using no-follow file opens, descriptor-path validation, regular-file and byte-limit checks, exclusive mode-`0600` destinations, and partial-output cleanup.

## Requirements

- Node.js 22.19 or newer for source development.
- Telegram bot token.
- OpenRouter API key.
- Tavily API key.
- OpenSandbox API key shared with the lifecycle server.
- A reachable OpenSandbox server using the pinned Docker server/execd releases.
- One absolute host folder visible under the same path to the bot deployment, OpenSandbox server, host Docker daemon, and runner bind mounts.
- Optional Codex OAuth login through Pi.
- Optional external Docling server.

The bot container itself does **not** need `/dev/kvm`, `/var/run/docker.sock`, privileged mode, writable/private cgroups, or unconfined security profiles.

## Source setup

Start the OpenSandbox server first. On Linux with Docker:

```bash
cp .env.example .env
# Edit API keys and set BOT_SHARED_HOST_PATH to a real absolute host path.
. ./.env
mkdir -p "${BOT_SHARED_HOST_PATH:?set BOT_SHARED_HOST_PATH to the shared host folder}/users"

docker network create "${OPEN_SANDBOX_NETWORK:-ai-tg-bot-opensandbox}" 2>/dev/null || true
docker compose \
  -f docker-compose.opensandbox.yml \
  -f docker-compose.opensandbox.dev.yml \
  up -d
```

The checked-in example server configuration permits host binds only below:

```text
/mnt/user/ai-tg-bot-shared/users
```

If `BOT_SHARED_HOST_PATH` differs, copy `docker/opensandbox/config.example.toml`, change `allowed_host_paths` to `<your-root>/users`, and set `OPEN_SANDBOX_CONFIG_FILE` to that copy. Do not allow the entire filesystem or the shared root's `.chat-files` and `.outbox` directories.

The development override publishes the authenticated lifecycle API only on `127.0.0.1:8080`, allowing the host-run bot configuration below to use `localhost:8080`. Do not include this override in the normal two-container deployment.

Run the bot from source:

```bash
npm install
npm run migrate
npm run dev
```

For source execution, the bot-visible and server-visible shared roots can be the same absolute local directory:

```dotenv
AGENT_SHARED_ROOT=/absolute/path/to/ai-tg-bot-shared
MANAGED_FILE_ROOT=/absolute/path/to/ai-tg-bot-shared/.chat-files
OPEN_SANDBOX_SHARED_HOST_ROOT=/absolute/path/to/ai-tg-bot-shared
OPEN_SANDBOX_DOMAIN=localhost:8080
OPEN_SANDBOX_PROTOCOL=http
OPEN_SANDBOX_API_KEY=<same-secret-as-server>
```

`MANAGED_FILE_ROOT` must remain outside `AGENT_SHARED_ROOT/users`.

To configure Codex OAuth in the same Pi directory used by the bot:

```bash
PI_CODING_AGENT_DIR=./data/pi npx pi
```

Enter `/login` and choose OpenAI Codex. Without Codex credentials, the bot operates through OpenRouter.

## OpenSandbox configuration

Important settings are documented in [`.env.example`](./.env.example):

```dotenv
OPEN_SANDBOX_DOMAIN=opensandbox-server:8080
OPEN_SANDBOX_PROTOCOL=http
OPEN_SANDBOX_API_KEY=<long-random-secret>
OPEN_SANDBOX_USE_SERVER_PROXY=true
OPEN_SANDBOX_SHARED_HOST_ROOT=/mnt/user/ai-tg-bot-shared
OPEN_SANDBOX_DEPLOYMENT_ID=ai-tg-bot
OPEN_SANDBOX_IMAGE=ghcr.io/karilaa-dev/ai-agent-box:sha-<commit>
OPEN_SANDBOX_CPU=2
OPEN_SANDBOX_MEMORY=512Mi
OPEN_SANDBOX_USER=agent
OPEN_SANDBOX_GROUP=agent
OPEN_SANDBOX_UID=1000
OPEN_SANDBOX_GID=1000
OPEN_SANDBOX_IDLE_PAUSE_MS=600000
```

The image reference, resources, username/group, UID/GID, shared root, and layout markers form the provisioning fingerprint. `OPEN_SANDBOX_USER` and `OPEN_SANDBOX_GROUP` must exist in the runner image and resolve to the configured numeric identity so private mode-`0600` command input is readable. `OPEN_SANDBOX_UID` and `OPEN_SANDBOX_GID` must both be nonzero, and the runner UID should remain aligned with the bot's `APP_UID` so bind-mounted files remain readable for export. A changed fingerprint replaces obsolete managed sandboxes on their next use while preserving each user's bind-mounted `/data` tree.

The published Ubuntu 24.04 runner image includes Bash, Python, Node.js, `curl`, `zip`, `unzip`, Git, SQLite, build tools, and common diagnostics. See [`docker/ai-agent-box/README.md`](./docker/ai-agent-box/README.md). Pin an immutable `sha-...` tag in production rather than relying on `latest`.

The server example config enables `opensandbox/egress:v1.1.4` in `dns+nft` mode. The bot supplies ordered deny rules for routed non-public IPv4 ranges and otherwise allows public internet traffic. IPv6 is disabled by the egress sidecar by default. Keep a host/network firewall as defense in depth and test the policy against the actual LAN, Docker networks, metadata endpoints, and DNS setup before production exposure.

For stronger runtime isolation, install and register Kata on the Docker host, then enable the commented `[secure_runtime]` block in the server config. Kata requires supported virtualization and `/dev/kvm` on the trusted OpenSandbox host; the bot container remains unprivileged. gVisor is another OpenSandbox option, but server v0.2.2 cannot combine gVisor with the `networkPolicy` enforcement used here, so do not enable `runsc` without redesigning egress enforcement.

## Data migration and rollback

The database migrations preserve users and the existing documented Pi/file migrations. Before sandbox cutover, back up the database, Pi directory, legacy workspace root, shared root, and old BoxLite state.

Migrate legacy thread workspaces and managed originals with a dry run first:

```bash
npm run migrate:sandbox-data:dev
npm run migrate:sandbox-data:dev -- --apply
```

For a built image:

```bash
npm run migrate:sandbox-data
npm run migrate:sandbox-data -- --apply
```

The temporary `migrate:boxlite-data` and `migrate:boxlite-data:dev` aliases invoke the same neutral migration for one compatibility release. The migration refuses symlinks, reports nonidentical conflicts instead of overwriting, updates managed-file paths only after successful writes, and leaves the old tree untouched for rollback.

Do not delete the former BoxLite runtime data until representative workspaces, exports, pause/resume, bot restart/reconciliation, and backups have been verified. The new bot never opens the old BoxLite runtime home.

## Docker Compose

Create the shared directory and private network, then start the trusted lifecycle service and bot:

```bash
cp .env.example .env
# Edit API keys and BOT_SHARED_HOST_PATH.
. ./.env
mkdir -p "${BOT_SHARED_HOST_PATH:?set BOT_SHARED_HOST_PATH to the shared host folder}/users"
docker network create "${OPEN_SANDBOX_NETWORK:-ai-tg-bot-opensandbox}" 2>/dev/null || true

docker compose -f docker-compose.opensandbox.yml up -d
docker compose up --build -d
```

- `docker-compose.opensandbox.yml` mounts `/var/run/docker.sock` only into `opensandbox-server`, persists lifecycle state, and mounts the shared folder under the identical absolute host path.
- `docker-compose.yml` mounts that folder at `/data` in the bot and passes the original host path through `OPEN_SANDBOX_SHARED_HOST_ROOT` for runner provisioning.
- Both services join `ai-tg-bot-opensandbox` by default. Do not publish port 8080 unless another trusted client needs it; if it is published, restrict it with host firewall rules.
- The bot starts as root only long enough to prepare owned persistent directories, then executes Node through `setpriv` as `APP_UID:APP_GID` with groups and capabilities cleared and `no-new-privs` enabled.

PostgreSQL remains available through the existing override:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up --build -d
```

## Unraid deployment

This deployment uses two templates:

1. [`templates/opensandbox-server.xml`](./templates/opensandbox-server.xml) — trusted lifecycle service with Docker-socket access.
2. [`templates/ai-tg-bot.xml`](./templates/ai-tg-bot.xml) — unprivileged Telegram bot.

Setup:

1. Create a custom Docker network:

   ```bash
   docker network create ai-tg-bot-opensandbox
   ```

2. Create `/mnt/user/ai-tg-bot-shared/users` and ensure UID/GID `1000:1000` can write it.
3. Copy `docker/opensandbox/config.example.toml` to `/mnt/user/appdata/opensandbox/config.toml`.
4. Verify the TOML allowlist contains only `/mnt/user/ai-tg-bot-shared/users` and retain the pinned `dns+nft` egress image.
5. Install and start `opensandbox-server` on `ai-tg-bot-opensandbox`. Set a long random API key.
6. Install `ai-tg-bot` on the same network, use the identical API key, and keep:
   - Agent Shared Data: `/mnt/user/ai-tg-bot-shared` -> `/data`
   - OpenSandbox Shared Host Root: `/mnt/user/ai-tg-bot-shared`
   - OpenSandbox Domain: `opensandbox-server:8080`
   - Runner username/group set to `agent:agent` and UID/GID values aligned at `1000:1000`
7. Leave Docling URL empty unless a separately operated service is available.

If the shared location changes, update all four places together: bot bind source, `OPEN_SANDBOX_SHARED_HOST_ROOT`, server bind source/target, and the TOML `allowed_host_paths`. The path string passed to Docker must be the actual Unraid host path, not `/data` and not an SMB URL.

Back up `/mnt/user/appdata/ai-tg-bot`, `/mnt/user/appdata/opensandbox`, and `/mnt/user/ai-tg-bot-shared`. Preserve the old BoxLite data separately during rollback validation.

## Security boundary

OpenSandbox's default Docker runtime isolates workloads with Linux containers; it is not the BoxLite microVM boundary. Treat untrusted commands accordingly.

- The OpenSandbox server's Docker socket is root-equivalent host authority. Restrict who can reach or configure it.
- Keep API-key authentication enabled and use a private Docker network or strict firewall rules.
- Mount only `<shared-root>/users/<userId>` into each runner. Canonical `.chat-files`, `.outbox`, database files, Pi credentials, and bot secrets must stay outside runner mounts.
- Do not inject Telegram, OpenRouter, Tavily, Codex, or OpenSandbox credentials into runner commands.
- The default `dns+nft` policy denies routed RFC1918/LAN, carrier-grade NAT, link-local/cloud metadata, multicast, reserved, and documentation/benchmark IPv4 ranges before allowing unmatched public traffic. IPv6 is disabled by the sidecar by default. The sidecar permits the sandbox's own loopback interface, so do not expose sensitive services there. Retain host/network firewall enforcement as defense in depth, especially for host public addresses and deployment-specific routes, and test literal IP plus DNS-rebinding cases separately.
- No guest ports are intentionally published. `OPEN_SANDBOX_USE_SERVER_PROXY=true` keeps command/file traffic routed through the authenticated lifecycle endpoint.

## Telegram commands

- `/lang` — change language
- `/timezone` — set timezone
- `/stream` — toggle draft streaming
- `/stop` — cancel the active Pi turn or file ingest
- `/fork` — branch the current Pi session into a Telegram topic
- `/compact` — invoke Pi compaction
- `/help` — show command help

## Verification

Automated checks:

```bash
npm run typecheck
npm test
npm run build
```

Provider checks use configured credentials:

```bash
npm run live:pi-check
npm run live:pi-fallback
```

With a real OpenSandbox server and shared host path configured:

```bash
npm run live:opensandbox-check
npm run live:opensandbox-check   # repeat to exercise reconciliation
```

The runtime check covers real command execution, shared-path visibility, interruption/recovery, export, pause/resume, and manager recreation. It cleans up only its uniquely identified test resources.

The end-to-end benchmark uses the real Pi tool loop and provider credentials while replacing Telegram transmission with a capture adapter:

```bash
npm run live:opensandbox-turn-check
```

It asks the agent to download exactly ten safe-for-work Hatsune Miku artworks from Wikimedia Commons, record source/creator/license/hash metadata, build and test a ZIP with the `zip` command, and deliver it through `create_file`. The harness independently verifies archive paths, count, image signatures, unique hashes, Wikimedia source metadata, approved licenses, size, persistence, and one captured document delivery.
