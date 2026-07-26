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
One persistent runner container per active Telegram thread
        |
        | three scoped host binds
        v
<shared-root>/users/<userId>/threads/<threadId>/workspace    ->  /data/threads/<threadId>/workspace    (rw)
<shared-root>/users/<userId>/threads/<threadId>/attachments  ->  /data/threads/<threadId>/attachments  (ro)
<shared-root>/users/<userId>/shared                         ->  /data/shared                           (rw)
```

- Each Telegram thread maps to one persistent Pi JSONL session under `PI_CODING_AGENT_DIR`.
- Pi receives only the bot's scoped tools: `bash`, `create_file`, `web_search`, `web_extract`, `search_thread`, `load_message`, `search_in_file`, `read_file_section`, and `generate_image`.
- OpenSandbox provides one persistent command environment per Telegram user-and-thread pair. Commands are serialized within that thread; different threads can execute concurrently in separate sandboxes.
- Every thread starts in `/data/threads/<threadId>/workspace`; `/data/shared` is the supported location for intentional sharing across that user's threads. A runner mounts only its current workspace, a read-only attachment-staging directory, and that user's shared directory, so sibling thread directories are absent from its mount namespace.
- The first sandbox-backed operation lazily connects to OpenSandbox and creates or resumes the thread's environment. Idle environments pause after five minutes and expire after fifteen minutes by default. The mounted workspace and `/data/shared` survive expiration; container-layer state survives only while the same sandbox is retained.
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
npm run dev
```

The bot initializes the current schema at startup. Use an empty SQLite database or PostgreSQL schema for this release; databases created by other releases are unsupported and are not transformed or cleaned automatically.

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
OPENSANDBOX_EGRESS_DNS_UPSTREAM=1.1.1.1,8.8.8.8
OPEN_SANDBOX_IDLE_PAUSE_MS=300000
OPEN_SANDBOX_IDLE_RELEASE_MS=900000
```

The image reference, resources, username/group, UID/GID, shared root, idle-release timeout, public DNS upstreams, and layout markers form the provisioning fingerprint. `OPEN_SANDBOX_USER` and `OPEN_SANDBOX_GROUP` must exist in the runner image and resolve to the configured numeric identity so private mode-`0600` command input is readable. `OPEN_SANDBOX_UID` and `OPEN_SANDBOX_GID` must both be nonzero, and the runner UID should remain aligned with the bot's `APP_UID` so bind-mounted files remain readable for export. `OPEN_SANDBOX_IDLE_RELEASE_MS` must be greater than `OPEN_SANDBOX_IDLE_PAUSE_MS`. A changed fingerprint replaces obsolete managed sandboxes on their next use while preserving the bind-mounted thread and shared trees.

The default lightweight Alpine runner includes Bash, Python, Node.js, `curl`, archives, Git, SQLite, and common utilities. The separate `dev-sha-...` variant adds compilers and full diagnostics. See [`docker/ai-agent-box/README.md`](./docker/ai-agent-box/README.md). Pin an immutable `sha-...` or `dev-sha-...` tag in production rather than relying on mutable tags.

The server example config enables `opensandbox/egress:v1.1.4` in `dns+nft` mode. That implementation enforces the bot's IPv4 and IPv6 IP/CIDR deny rules in nftables and applies the same address-family handling to DNS A/AAAA results despite stale FQDN-only comments in the lifecycle SDK schema; changing the egress image or mode requires fresh direct-IP validation. Unmatched public internet traffic remains allowed. The bot provisions Cloudflare and Google as public DNS upstreams by default and automatically derives the sidecar's nameserver exemption, avoiding dependence on Docker's inherited host resolver or Tailscale MagicDNS. `OPENSANDBOX_EGRESS_DNS_UPSTREAM` accepts comma-separated public IP literals with optional ports; private, local, reserved, and named resolver values are rejected. Do not set `OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT` yourself.

Upstream server `v0.2.2` routes approved `OPENSANDBOX_EGRESS_*` request variables to the sidecar but omits these two documented DNS variables from its approval list. The bundled `ghcr.io/karilaa-dev/opensandbox-server:v0.2.2-ai-tg-bot.1` compatibility image is built directly from upstream `v0.2.2` and only adds `OPENSANDBOX_EGRESS_DNS_UPSTREAM` and `OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT` to that list. Its fail-closed build patch stops applying once upstream contains the fix, so a future supported upstream release can replace it without carrying a fork.

A Docker daemon-level DNS override is not required for OpenSandbox. If one was added while troubleshooting, keep it until the live verification below succeeds with the updated bot, then remove it if no other containers need it. The pinned sidecar exempts its shared loopback interface before evaluating the policy deny sets, so do not expose sensitive services on sandbox loopback. Keep a host/network firewall as defense in depth and test literal private, Docker/LAN, link-local/metadata, and public destinations plus DNS behavior before production exposure.

For stronger runtime isolation, install and register Kata on the Docker host, then enable the commented `[secure_runtime]` block in the server config. Kata requires supported virtualization and `/dev/kvm` on the trusted OpenSandbox host; the bot container remains unprivileged. gVisor is another OpenSandbox option, but server v0.2.2 cannot combine gVisor with the `networkPolicy` enforcement used here, so do not enable `runsc` without redesigning egress enforcement.

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

- `docker-compose.opensandbox.yml` builds/uses the pinned server compatibility image, mounts `/var/run/docker.sock` only into `opensandbox-server`, persists lifecycle state, mounts the shared folder under the identical absolute host path, and maps `host.docker.internal` to the Docker host gateway for runner readiness checks.
- `docker-compose.yml` runs the bot with PostgreSQL, mounts the shared folder at `/data`, and passes the original host path through `OPEN_SANDBOX_SHARED_HOST_ROOT` for runner provisioning.
- Both services join `ai-tg-bot-opensandbox` by default. Do not publish port 8080 unless another trusted client needs it; if it is published, restrict it with host firewall rules.
- The bot starts as root only long enough to prepare owned persistent directories, then executes Node through `setpriv` as `APP_UID:APP_GID` with groups and capabilities cleared and `no-new-privs` enabled.
- PostgreSQL is available only to the bot on an internal Compose network and is not published on a host port. Set `POSTGRES_PASSWORD` in `.env` to a long random value; the container entrypoint safely URL-encodes it when constructing `DB_URL`.

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
4. Verify the TOML allowlist contains only `/mnt/user/ai-tg-bot-shared/users`, retain the pinned `dns+nft` egress image, and retain `[docker] host_ip = "host.docker.internal"`.
5. Install and start `opensandbox-server` on `ai-tg-bot-opensandbox`. Set a long random API key and retain the template's `--add-host=host.docker.internal:host-gateway` extra parameter.
6. Install `ai-tg-bot` on the same network, use the identical API key, and keep:
   - Agent Shared Data: `/mnt/user/ai-tg-bot-shared` -> `/data`
   - OpenSandbox Shared Host Root: `/mnt/user/ai-tg-bot-shared`
   - OpenSandbox Domain: `opensandbox-server:8080`
   - Runner username/group set to `agent:agent` and UID/GID values aligned at `1000:1000`
   - OpenSandbox Public DNS: `1.1.1.1,8.8.8.8`, unless different public resolvers are required
7. Leave Docling URL empty unless a separately operated service is available.

If the shared location changes, update all four places together: bot bind source, `OPEN_SANDBOX_SHARED_HOST_ROOT`, server bind source/target, and the TOML `allowed_host_paths`. The path string passed to Docker must be the actual Unraid host path, not `/data` and not an SMB URL.

### Upgrading an existing OpenSandbox installation

1. Update the server TOML with `[docker] host_ip = "host.docker.internal"`.
2. Select `ghcr.io/karilaa-dev/opensandbox-server:v0.2.2-ai-tg-bot.1`, add `--add-host=host.docker.internal:host-gateway` to the server container, and recreate it.
3. Update and recreate `ai-tg-bot`; the default public DNS setting requires no manual change.
4. Run `npm run live:opensandbox-check` from a configured checkout or execute the equivalent DNS, public HTTPS, and private-address checks from a bot-managed sandbox.
5. Confirm the egress log reports that a configured upstream is in the nameserver exempt list and therefore does not use `SO_MARK`.
6. After verification succeeds, remove any Docker daemon DNS override that was added solely for OpenSandbox and restart Docker at a suitable maintenance time.

## Security boundary

OpenSandbox's default Docker runtime isolates workloads with Linux containers. Treat untrusted commands accordingly.

- The OpenSandbox server's Docker socket is root-equivalent host authority. Restrict who can reach or configure it.
- Keep API-key authentication enabled and use a private Docker network or strict firewall rules.
- Give each runner exactly three scoped binds: its workspace read-write at `/data/threads/<threadId>/workspace`, its attachment staging read-only at `/data/threads/<threadId>/attachments`, and its user-shared directory read-write at `/data/shared`. Sibling threads are not mounted. Canonical `.chat-files`, `.outbox`, database files, Pi credentials, and bot secrets remain outside runner mounts.
- Do not inject Telegram, OpenRouter, Tavily, Codex, or OpenSandbox credentials into runner commands.
- The default `dns+nft` policy denies routed RFC1918/LAN, carrier-grade NAT, link-local/cloud metadata, multicast, reserved, and documentation/benchmark ranges for IPv4 and IPv6 before allowing unmatched public traffic. The sidecar permits the sandbox's own loopback interface before policy evaluation, so the loopback CIDR entries are defense in depth only and sensitive services must not listen there. Retain host/network firewall enforcement as defense in depth, especially for host public addresses and deployment-specific routes, and test literal IP plus DNS-rebinding cases separately.
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

It asks the agent to download exactly ten safe-for-work Hatsune Miku artworks from Wikimedia Commons, record source/creator/license/hash metadata, build and test a ZIP with the `zip` command, and deliver it through `create_file`. The harness independently verifies archive paths, count, image signatures, unique hashes, Wikimedia source metadata, approved licenses, size, persistence, tool-call/failure budgets, and one captured document delivery. It inherits the configured production idle-pause duration rather than shortening it; after the turn it explicitly pauses the uniquely tagged sandbox and proves that the same sandbox resumes with the archive intact. Failed runs retain a sanitized diagnostic bundle and transcript after copied Pi authentication is removed.
