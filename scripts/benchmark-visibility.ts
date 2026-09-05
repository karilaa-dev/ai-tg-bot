import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SQL } from "drizzle-orm";

// Run the same fixture against a checkout without importing its implementation here.
const root = path.resolve(process.argv[2] ?? process.cwd());
const moduleAt = (file: string) => import(pathToFileURL(path.join(root, "src", `${file}.ts`)).href);
const { loadTestConfig }: typeof import("../src/config.js") = await moduleAt("config");
const { createDatabase }: typeof import("../src/db/index.js") = await moduleAt("db/index");
const { createRepos }: typeof import("../src/db/repos/index.js") = await moduleAt("db/repos/index");
const { threadVisibilityScope }: typeof import("../src/memory/retrieval.js") = await moduleAt("memory/retrieval");
const database = createDatabase(loadTestConfig());
await database.initialize();
const repos = createRepos(database.db, database.search);

try {
  const user = await repos.users.ensure({ tgId: 88771, firstName: "Benchmark" });
  let thread: Awaited<ReturnType<typeof repos.threads.create>> | undefined;
  let boundary: number | undefined;
  for (let level = 0; level < 6; level++) {
    thread = await repos.threads.create({
      userId: user.tg_id, topicId: level, title: "Fork",
      parentThreadId: thread?.id, forkPointMessageId: boundary,
    });
    for (let index = 0; index < 20; index++) {
      const text = "x".repeat(1000);
      const message = await repos.messages.insert({ threadId: thread.id, role: "user", content: { text }, textPlain: text });
      if (index === 10) boundary = message.id;
      if (index === 5 || index === 15) {
        await repos.files.insertFile({
          userId: user.tg_id, threadId: thread.id, messageId: message.id,
          type: "txt", name: "notes.txt", size: 1000, contentMd: text, isInline: true,
        });
      }
    }
  }

  const query = database.db.query.bind(database.db);
  let calls = 0;
  let rows = 0;
  let resultBytes = 0;
  let messageBodyQueries = 0;
  database.db.query = async <T extends object>(statement: SQL) => {
    const result = await query<T>(statement);
    calls++;
    rows += result.length;
    resultBytes += Buffer.byteLength(JSON.stringify(result));
    if (result.some((row) => "text_plain" in row)) messageBodyQueries++;
    return result;
  };
  const started = performance.now();
  const scope = await threadVisibilityScope(repos, thread!, boundary);
  process.stdout.write(`${JSON.stringify({ calls, rows, resultBytes, messageBodyQueries, elapsedMs: performance.now() - started, scope }, null, 2)}\n`);
} finally {
  await database.destroy();
}
