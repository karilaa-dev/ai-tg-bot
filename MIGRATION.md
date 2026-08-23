# Migrate the Unraid SQLite deployment to Dokploy

The migration is an offline conversion. The Unraid wizard creates one `app-data.tgz` archive in the format expected by the current bot. After that archive is unpacked into `/app/data`, the new bot starts normally. The bot has no migration mode or one-time startup hook.

> Never run the Unraid and Dokploy bots at the same time. They use the same Telegram token and will compete for updates.

## Source layout

This guide matches the Unraid layout shown below.

| Unraid path | Container path | Contents | Migrated |
| --- | --- | --- | --- |
| `/mnt/user/appdata/ai-tg-bot` | `/app/data` | `bot.db` and `pi/` | Yes |
| `/mnt/user/ai-bot` | `/app/data/files` | `.outbox/`, `chats/`, and `users/` | No |

The converted archive preserves:

- users, threads, messages, and file metadata from `bot.db`;
- Telegram file IDs used to retrieve files shared through Telegram;
- Pi sessions, settings, models, and authentication state from `pi/`.

Agent-generated data that existed only in an old sandbox or under `/mnt/user/ai-bot` is not copied. Keep the same `BOT_TOKEN`: Telegram file IDs are scoped to the bot that received or sent the files.

The Dokploy deployment continues to use SQLite at `/app/data/bot.db`. It does not need PostgreSQL.

## 1. Create the converted archive on Unraid

Check out this version of the repository on Unraid, then stop the old bot in the Unraid UI. Leave it stopped for the whole cutover.

Run the wizard from the repository:

```bash
bash scripts/unraid-migration-wizard.sh
```

Choose the stopped bot container when prompted. The wizard:

1. audits the source database, Pi sessions, and Telegram file references;
2. creates a consistent SQLite backup without changing the source;
3. upgrades that copied database to the current schema;
4. copies `pi/` and verifies the converted data against the source audit;
5. creates and checks the final archive.

Wait for `Migration export ready`. The printed private directory contains exactly:

```text
app-data.tgz
SHA256SUMS
```

Confirm the archive before uploading it:

```bash
cd /path/printed/by/the/wizard
sha256sum --check SHA256SUMS
```

`app-data.tgz` contains `bot.db` and `pi/`. Treat it as a secret because Pi authentication data may be present.

## 2. Create a holding Dokploy container

Create a Railpack application with one replica. Under **Advanced > Mounts**, create one Docker named volume mounted at `/app/data`. Dokploy documents named application volumes in its [mount settings](https://docs.dokploy.com/docs/core/applications/advanced#volumesmounts).

Set the normal application identity and data variables printed by the wizard:

```dotenv
BOT_TOKEN=<same token as the old bot>
DB_URL=sqlite:/app/data/bot.db
PI_CODING_AGENT_DIR=/app/data/pi
E2B_DEPLOYMENT_ID=<value printed by the wizard>
BROWSER_USE_DEPLOYMENT_ID=<value printed by the wizard>
APP_UID=<value printed by the wizard>
APP_GID=<value printed by the wizard>
```

Do not set `POSTGRES_PASSWORD` or any `UPGRADE_*` variables.

For the first deployment only, add this Railpack start-command override:

```dotenv
RAILPACK_START_CMD=sleep infinity
```

[Dokploy supports `RAILPACK_START_CMD`](https://docs.dokploy.com/docs/core/applications/build-type#railpack-new) as the container start command for Railpack applications. Deploy once. This creates the empty named volume and keeps the container alive without starting Telegram polling. The logs must not contain `bot started`.

## 3. Seed `/app/data`

Upload both exported files to the holding container:

| File | Container path |
| --- | --- |
| `app-data.tgz` | `/tmp/app-data.tgz` |
| `SHA256SUMS` | `/tmp/SHA256SUMS` |

You can use Dokploy's authenticated [container upload API](https://docs.dokploy.com/docs/api/docker#docker-upload-file-to-container). For example:

```bash
curl --fail --show-error \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -F "containerId=$CONTAINER_ID" \
  -F "file=@app-data.tgz" \
  -F "destinationPath=/tmp/app-data.tgz" \
  "$DOKPLOY_URL/api/docker.uploadFileToContainer"

curl --fail --show-error \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -F "containerId=$CONTAINER_ID" \
  -F "file=@SHA256SUMS" \
  -F "destinationPath=/tmp/SHA256SUMS" \
  "$DOKPLOY_URL/api/docker.uploadFileToContainer"
```

Use Dokploy `0.29.3` or newer when using this API. Older releases have a reported destination-path command-injection issue; see [CVE-2026-45663](https://github.com/Dokploy/dokploy/security/advisories/GHSA-9m66-74x3-5mwr).

In **Advanced > Run Command**, execute:

```bash
set -eu
cd /tmp
sha256sum --check SHA256SUMS
test -z "$(find /app/data -mindepth 1 -maxdepth 1 -print -quit)"
tar -xzf app-data.tgz -C /app/data --no-same-owner --no-same-permissions
test -s /app/data/bot.db
test -d /app/data/pi
test ! -e /app/data/bot.db-wal
test ! -e /app/data/bot.db-shm
rm -f /tmp/app-data.tgz /tmp/SHA256SUMS
```

The empty-volume check makes this step fail instead of merging the archive into existing data. If it fails after extraction starts, recreate the named volume and repeat this section with a fresh empty volume.

## 4. Start the bot normally

Remove `RAILPACK_START_CMD`, add the normal OpenRouter, Tavily, E2B, and optional Browser Use or Codex credentials, then redeploy with one replica.

The bot now starts through its ordinary entrypoint. Confirm that the logs contain `database initialized` and `bot started`, then run these smoke tests:

- [ ] Continue an existing conversation.
- [ ] Find an old message with `search_thread`.
- [ ] Restore an old Telegram attachment into a new E2B sandbox.
- [ ] Send and process a new file.

Keep the old Unraid bot stopped, and retain the export plus `/mnt/user/ai-bot`, until these checks pass.

## Rollback

Stop the Dokploy bot before restarting the Unraid bot. Never let both deployments poll Telegram with the same token.
