import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { prepareMigrationData } from "../../scripts/prepare-migration-data.js";
import { createDatabase } from "../../src/db/index.js";

describe("offline migration data preparation", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("upgrades the copied database and keeps Telegram-backed files and Pi sessions", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-prepare-migration-"));
    const appDataRoot = path.join(tempDir, "app-data");
    const piDirectory = path.join(appDataRoot, "pi");
    const sessionDirectory = path.join(piDirectory, "sessions", "telegram");
    const sessionFile = path.join(sessionDirectory, "session.jsonl");
    const databaseFile = path.join(appDataRoot, "bot.db");
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(sessionFile, "preserved Pi session\n");
    await fs.writeFile(path.join(piDirectory, "upgrade-baseline.json"), "obsolete\n");
    await fs.writeFile(path.join(piDirectory, "upgrade-baseline.json.verified"), "obsolete\n");

    const source = createDatabase({ DB_URL: `sqlite:${databaseFile}` });
    await source.initialize();
    await source.db.execute(sql`alter table files add column path text`);
    await source.db.execute(sql`
      insert into users(tg_id, first_name, lang, created_at)
      values (8, 'Migrated', 'en', 1)
    `);
    await source.db.execute(sql`
      insert into threads(id, user_id, title, pi_session_file, created_at)
      values (8, 8, 'Migrated', ${sessionFile}, 1)
    `);
    await source.db.execute(sql`
      insert into messages(id, thread_id, role, kind, content_json, text_plain, created_at)
      values (8, 8, 'user', 'file', '{}', '', 1)
    `);
    await source.db.execute(sql`
      insert into files(id, user_id, thread_id, message_id, type, mime_type, name, path, size, is_inline, created_at)
      values (8, 8, 8, 8, 'txt', 'text/plain', 'shared.txt', '/old/files/shared.txt', 12, 1, 1)
    `);
    await source.db.execute(sql`
      insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at)
      values (
        8, 'telegram', 'default', 'telegram-unique-8',
        '{"file_id":"telegram-file-8","file_unique_id":"telegram-unique-8"}', 1
      )
    `);
    await source.destroy();

    await expect(prepareMigrationData(appDataRoot)).resolves.toEqual({
      appDataRoot,
      databaseFile,
      piDirectory,
    });

    await expect(fs.readFile(sessionFile, "utf8")).resolves.toBe("preserved Pi session\n");
    await expect(fs.access(path.join(piDirectory, "upgrade-baseline.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(piDirectory, "upgrade-baseline.json.verified")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${databaseFile}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${databaseFile}-shm`)).rejects.toMatchObject({ code: "ENOENT" });

    const prepared = new Database(databaseFile, { readonly: true, fileMustExist: true });
    try {
      expect(prepared.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(prepared.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(prepared.prepare("pragma table_info(files)").all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "path" })]));
      expect(prepared.prepare(`
        select file_id, telegram_file_id, telegram_file_unique_id
        from telegram_file_refs
      `).all()).toEqual([{
        file_id: 8,
        telegram_file_id: "telegram-file-8",
        telegram_file_unique_id: "telegram-unique-8",
      }]);
    } finally {
      prepared.close();
    }
  });
});
