# Unraid to Dokploy migration

This is an offline cutover. Allow 5 to 15 minutes for the export, plus upload and import
time.

> Never run the Unraid bot and the Dokploy bot at the same time. They use the same Telegram
> token and will compete for updates.

## Before you start

- [ ] The migration branch is checked out on Unraid.
- [ ] The old bot and PostgreSQL use separate Docker UI containers.
- [ ] Dokploy is newer than `0.29.1`. Older versions have a
      [container-upload vulnerability](https://github.com/Dokploy/dokploy/security/advisories/GHSA-9m66-74x3-5mwr).
- [ ] You know the old `BOT_TOKEN` and can create a new PostgreSQL 17 service in Dokploy.

The migration copies PostgreSQL chat state and the complete `/app/data/pi` volume. It does
not copy `bot-data`, shared roots, outbox data, OpenSandbox workspaces, or sandbox containers.
Keep the same `BOT_TOKEN`, because Telegram file IDs belong to the bot that received them.

## 1. Stop and export on Unraid

In the Unraid UI, stop the old bot. Leave PostgreSQL running.

Open an Unraid terminal in this repository and run:

```bash
bash scripts/unraid-migration-wizard.sh
```

The wizard asks you to select the stopped bot and running PostgreSQL containers. Press Enter
to accept the default when only one valid container is listed. If `BOT_TOKEN` or `DB_URL` is
missing from the old container, paste it at the hidden prompt.

The wizard does not stop, start, or remove either source container. Its only change to the
source data is `/app/data/pi/upgrade-baseline.json`.

Wait for this message:

```text
Migration export ready:
```

The printed folder must contain exactly these files:

```text
aibot.dump
pi-home.tgz
SHA256SUMS
```

Keep the folder private. `pi-home.tgz` can contain provider credentials from `auth.json`.

## 2. Create the empty Dokploy destination

Create an empty PostgreSQL 17 service and a Railpack application with exactly one replica.
Add two empty named-volume mounts in Dokploy's
[advanced application settings](https://docs.dokploy.com/docs/core/applications/advanced):

| Volume | Container path | Keep after migration |
| --- | --- | --- |
| Pi data | `/app/data/pi` | Yes |
| Import files | `/app/data/import` | No |

Set the following environment variables. Copy the identity and UID/GID values printed by the
Unraid wizard.

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

Deploy the application. Import mode keeps the container available without starting Telegram
polling. Check the logs for:

```text
offline import staging mode; Telegram polling is disabled
```

Stop if the logs contain `bot started`.

## 3. Upload and import

Use Dokploy's authenticated [container upload](https://docs.dokploy.com/docs/api/docker) to
upload each file to its exact destination:

| Exported file | Dokploy destination |
| --- | --- |
| `aibot.dump` | `/app/data/import/aibot.dump` |
| `pi-home.tgz` | `/app/data/import/pi-home.tgz` |
| `SHA256SUMS` | `/app/data/import/SHA256SUMS` |

Do not rename or unpack the files. Open **Advanced > Run Command** and run:

```bash
./docker/import-migration.sh
```

The import checks the files, destination database, and Pi volume before restoring anything.
Keep import mode enabled until the command finishes. A successful run prints these messages
in order:

```text
upgrade import artifacts verified
upgrade import destinations verified empty
upgrade import PostgreSQL dump restored
upgrade import Pi archive restored
upgrade import schema migrated
upgrade import verification complete
```

Do not start the bot if the final message is missing.

## 4. Enable the new bot

After the import succeeds:

1. Remove `UPGRADE_MODE`.
2. Detach the `/app/data/import` mount. Keep the volume for now.
3. Add the normal provider and E2B credentials.
4. Redeploy one replica.
5. Check the logs for `upgrade preservation baseline already verified`, `database initialized`,
   and `bot started`.

Run these smoke tests before accepting the migration:

- [ ] Continue an existing conversation.
- [ ] Search old messages with `search_thread`.
- [ ] Restore an old Telegram attachment into a fresh E2B sandbox.
- [ ] Send and process a new file.

When all four pass, remove `UPGRADE_BASELINE_FILE`, redeploy once, and delete the temporary
import volume. Keep the Unraid export and stopped source deployment until you are satisfied
with the new bot.

## If something fails

- If export fails, keep the old bot stopped, fix the reported problem, and rerun the wizard.
- If import fails before either destination changes, replace the incorrect upload and rerun
  `./docker/import-migration.sh`.
- If import fails after PostgreSQL or Pi restoration starts, recreate the Dokploy PostgreSQL
  database, Pi volume, and import volume. Upload the three files again, then retry.
- To roll back, stop the Dokploy application first. Only then restart the old Unraid bot.
