import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { Api } from "grammy";
import { loadConfig } from "../src/config.js";
import { createDatabase, type AppDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import type { FileRow, FileSourceRow } from "../src/db/types.js";
import { FileByteCache } from "../src/files/cache.js";
import { MAX_FILE_BYTES } from "../src/files/limits.js";
import { FileResolver, rowToSource } from "../src/files/resolver.js";
import { ManagedFileStore } from "../src/files/storage.js";
import { TelegramFileSourceAdapter } from "../src/files/telegramSource.js";
import { downloadTelegramFile } from "../src/files/telegram.js";

type Candidate = FileSourceRow & {
  file_type: FileRow["type"];
  file_name: string;
  file_size: number;
  file_mime_type: string | null;
  file_content_sha256: string | null;
  file_summary: string | null;
  file_is_inline: number;
};

const baseConfig = loadConfig();
const sourceDb = createDatabase(baseConfig);
let smokeDb: AppDatabase | undefined;
let tempRoot: string | undefined;

try {
  const candidate = (await sourceDb.db.query<Candidate>(sql`
    select
      s.*,
      f.type as file_type,
      f.name as file_name,
      f.size as file_size,
      f.mime_type as file_mime_type,
      f.content_sha256 as file_content_sha256,
      f.summary as file_summary,
      f.is_inline as file_is_inline
    from file_sources s
    join files f on f.id = s.file_id
    where s.transport = 'telegram'
      and f.size <= ${MAX_FILE_BYTES}
    order by s.last_verified_at desc, s.id desc
    limit 1
  `))[0];
  if (!candidate) {
    process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: "no Telegram file locator is available" })}\n`);
    process.exitCode = 0;
  } else {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-telegram-restore-"));
    const config = {
      ...baseConfig,
      DB_URL: "sqlite::memory:",
      BASH_WORKSPACE_ROOT: path.join(tempRoot, "bash"),
      FILE_CACHE_DIR: path.join(tempRoot, "cache-first"),
    };
    smokeDb = createDatabase(config);
    await smokeDb.migrate();
    const repos = createRepos(smokeDb.db, smokeDb.search);
    const user = await repos.users.ensure({ tgId: 9_999_002, firstName: "Telegram restore smoke", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Telegram restore smoke" });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: candidate.file_type,
      contentSha256: candidate.file_content_sha256,
      mimeType: candidate.file_mime_type,
      name: candidate.file_name,
      path: null,
      size: candidate.file_size,
      summary: candidate.file_summary,
      isInline: Boolean(candidate.file_is_inline),
    });
    await repos.files.rememberSource(file.id, rowToSource(candidate));

    const api = new Api(baseConfig.BOT_TOKEN);
    const telegram = new TelegramFileSourceAdapter({ api, config, download: downloadTelegramFile });
    let downloads = 0;
    const registerTelegram = (resolver: FileResolver) => resolver.registry.register({
      transport: telegram.transport,
      connectionKey: telegram.connectionKey,
      fetch: async (source, signal) => {
        downloads += 1;
        return telegram.fetch(source, signal);
      },
    });
    const store = new ManagedFileStore(config);
    const firstResolver = new FileResolver(repos.files, new FileByteCache(config), store);
    registerTelegram(firstResolver);
    const first = await firstResolver.resolveFile(file);
    if (!first.bytes.length || first.path !== store.pathFor(file.id)) throw new Error("initial restore did not create the managed snapshot");

    await fs.rm(store.root, { recursive: true, force: true });
    const restartedConfig = { ...config, FILE_CACHE_DIR: path.join(tempRoot, "cache-restarted") };
    const restarted = new FileResolver(repos.files, new FileByteCache(restartedConfig), new ManagedFileStore(restartedConfig));
    registerTelegram(restarted);
    const restored = await restarted.resolveFile({ ...file, path: first.path });
    const local = await restarted.resolveFile({ ...file, path: restored.path });
    const storedMode = (await fs.stat(restored.path)).mode & 0o777;
    const directoryMode = (await fs.stat(path.dirname(restored.path))).mode & 0o777;
    if (downloads !== 2) throw new Error(`expected two isolated Telegram downloads, received ${downloads}`);
    if (!restored.bytes.equals(local.bytes)) throw new Error("the restored local snapshot changed between reads");
    if (storedMode !== 0o600 || directoryMode !== 0o700) throw new Error("managed snapshot permissions are not private");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      source: "telegram",
      initialDownload: true,
      restoredAfterDeletion: true,
      subsequentReadWasLocal: true,
      bytes: restored.bytes.length,
    })}\n`);
  }
} catch {
  process.stderr.write("Telegram restoration smoke failed without exposing the stored locator.\n");
  process.exitCode = 1;
} finally {
  await smokeDb?.destroy();
  await sourceDb.destroy();
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
}
