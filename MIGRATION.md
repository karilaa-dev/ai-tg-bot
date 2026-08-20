# Migrate from Unraid to Dokploy

This is an offline cutover. Export usually takes 5 to 15 minutes. Upload and import time depends on the archive size and network.

> Never run the Unraid and Dokploy bots at the same time. They share a Telegram token and will compete for updates.

## Before you start

- [ ] Check out the migration branch on Unraid.
- [ ] Confirm that the old bot and PostgreSQL run in separate Docker UI containers.
- [ ] Use Dokploy `0.29.3` or newer. Versions through `0.29.2` do not validate the destination path used by container upload. The check first appears in [the `v0.29.3` upload implementation](https://github.com/Dokploy/dokploy/blob/v0.29.3/packages/server/src/services/docker.ts#L658-L676). See [CVE-2026-45663](https://github.com/Dokploy/dokploy/security/advisories/GHSA-9m66-74x3-5mwr) for the reported command-injection flaw.
- [ ] Have the old `BOT_TOKEN` ready.
- [ ] Be able to create an empty PostgreSQL 17 service in Dokploy.

The export contains PostgreSQL chat state and the complete `/app/data/pi` volume. It excludes `bot-data`, shared roots, outbox data, OpenSandbox workspaces, and sandbox containers.

Keep the same `BOT_TOKEN`. Telegram file IDs belong to the bot that received them.

## 1. Stop the bot and export from Unraid

Stop the old bot in the Unraid UI. Leave PostgreSQL running.

From a terminal in this repository, run:

```bash
bash scripts/unraid-migration-wizard.sh
```

Choose the stopped bot container and the running PostgreSQL container. Press Enter when the wizard offers the only valid container as its default. If the old container does not expose `BOT_TOKEN` or `DB_URL`, enter the missing value at the hidden prompt.

The wizard does not stop, start, or remove either source container. Its only source-data write is `/app/data/pi/upgrade-baseline.json`.

Wait for:

```text
Migration export ready:
```

The printed directory must contain exactly:

```text
aibot.dump
pi-home.tgz
SHA256SUMS
```

Keep the directory private. `pi-home.tgz` may contain provider credentials from `auth.json`.

## 2. Prepare an empty Dokploy destination

Create an empty PostgreSQL 17 service and a Railpack application with one replica.

Add two empty named-volume mounts in Dokploy's [advanced application settings](https://docs.dokploy.com/docs/core/applications/advanced):

| Volume | Container path | Keep after migration |
| --- | --- | --- |
| Pi data | `/app/data/pi` | Yes |
| Import files | `/app/data/import` | No |

Set these variables. Use the identity and UID/GID values printed by the export wizard.

```dotenv
UPGRADE_MODE=import
BOT_TOKEN=<same token as the old bot>
DB_URL=postgresql://<user>:<password>@<dokploy-postgres-host>:5432/<database>
PI_CODING_AGENT_DIR=/app/data/pi
UPGRADE_BASELINE_FILE=/app/data/pi/upgrade-baseline.json
E2B_DEPLOYMENT_ID=<value printed by the wizard>
BROWSER_USE_DEPLOYMENT_ID=<value printed by the wizard>
APP_UID=<value printed by the wizard>
APP_GID=<value printed by the wizard>
```

Deploy the application. Import mode starts a staging container without Telegram polling. Its logs must contain:

```text
offline import staging mode; Telegram polling is disabled
```

Stop if the logs contain `bot started`.

## 3. Upload and import

Use Dokploy's authenticated [container upload API](https://docs.dokploy.com/docs/api/docker) to upload each file to the exact path shown here:

| Exported file | Destination |
| --- | --- |
| `aibot.dump` | `/app/data/import/aibot.dump` |
| `pi-home.tgz` | `/app/data/import/pi-home.tgz` |
| `SHA256SUMS` | `/app/data/import/SHA256SUMS` |

Do not rename or unpack the files.

Open **Advanced > Run Command** and run:

```bash
./docker/import-migration.sh
```

The importer checks the files, destination database, and Pi volume before it restores anything. Leave import mode enabled until the command finishes.

A successful run prints these lines in order:

```text
upgrade import artifacts verified
upgrade import destinations verified empty
upgrade import PostgreSQL dump restored
upgrade import Pi archive restored
upgrade import schema migrated
upgrade import verification complete
```

Do not start the bot if the last line is missing.

## 4. Start the new bot

After a successful import:

1. Remove `UPGRADE_MODE`.
2. Detach `/app/data/import`. Keep its volume for now.
3. Add the normal OpenRouter, Tavily, E2B, and optional Browser Use or Codex credentials.
4. Redeploy with one replica.
5. Confirm that the logs contain `upgrade preservation baseline already verified`, `database initialized`, and `bot started`.

Run these smoke tests:

- [ ] Continue an existing conversation.
- [ ] Find an old message with `search_thread`.
- [ ] Restore an old Telegram attachment into a new E2B sandbox.
- [ ] Send and process a new file.

When all four pass, remove `UPGRADE_BASELINE_FILE`, redeploy once, and delete the temporary import volume. Keep the Unraid export and stopped source deployment until you are comfortable with the new system.

## Recovery and rollback

- If export fails, leave the old bot stopped, fix the reported problem, and rerun the wizard.
- If import fails before changing either destination, replace the bad upload and rerun `./docker/import-migration.sh`.
- If import fails after PostgreSQL or Pi restoration starts, recreate the Dokploy PostgreSQL database, Pi volume, and import volume. Upload all three files again and retry.
- To roll back, stop the Dokploy application first. Then restart the old Unraid bot.
