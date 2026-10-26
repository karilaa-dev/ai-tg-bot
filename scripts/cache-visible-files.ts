import { Api } from "grammy";
import { sql } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import type { FileRow } from "../src/db/types.js";
import { FileResolver } from "../src/files/resolver.js";
import { LocalFileStore } from "../src/files/localStore.js";
import { TelegramFileSourceAdapter } from "../src/files/telegramSource.js";
import { downloadTelegramFile } from "../src/files/telegram.js";
import { WebFileSourceAdapter } from "../src/web/file-source.js";
import { prepareWithTwoWorkers } from "../src/files/outgoingBuffers.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { E2BFileSourceAdapter } from "../src/e2b/fileSource.js";

const config = loadConfig();
const database = createDatabase(config);
let sandboxRuntime: ThreadE2BSandboxRuntimeManager | undefined;
try {
  const repos = createRepos(database.db, database.search);
  const resolver = new FileResolver(repos.files, undefined, new LocalFileStore(config.FILE_STORAGE_PATH));
  resolver.registry.register(new TelegramFileSourceAdapter({ api: new Api(config.BOT_TOKEN), config, download: downloadTelegramFile }));
  resolver.registry.register(new WebFileSourceAdapter(database.db));
  const recoverSandboxes = process.argv.includes("--recover-sandbox-sources");
  if (recoverSandboxes) {
    sandboxRuntime = new ThreadE2BSandboxRuntimeManager({ config, repos, fileResolver: resolver });
    resolver.registry.register(new E2BFileSourceAdapter(config, sandboxRuntime));
  }
  const files = await database.db.query<FileRow>(sql`
    select f.* from files f where f.message_id is not null
      or exists(select 1 from message_files m where m.file_id = f.id)
    order by f.created_at, f.id
  `);
  let finished = 0;
  const results = await prepareWithTwoWorkers(files, async file => {
    try {
      await resolver.resolveFile(file, AbortSignal.timeout(60_000), undefined,
        { excludeSandbox: !recoverSandboxes, allowSandboxResume: recoverSandboxes, pauseAfterRead: true });
    } finally {
      finished++;
      if (finished % 20 === 0) console.log(JSON.stringify({ checked: finished, total: files.length }));
    }
  });
  const unavailable = files.flatMap((file, index) => {
    const result = results[index];
    if (result?.status !== "rejected") return [];
    const message = String(result.reason);
    const reason = /mismatch|different bytes/i.test(message) ? "original_bytes_differ"
      : /exceeds|size limit|too large|too big/i.test(message) ? "download_limit" : "source_unavailable";
    return [{ id: file.id, reason }];
  });
  console.log(JSON.stringify({ checked: files.length, retained: files.length - unavailable.length, unavailable }));
  if (unavailable.length) process.exitCode = 1;
} finally { await sandboxRuntime?.dispose(); await database.destroy(); }
