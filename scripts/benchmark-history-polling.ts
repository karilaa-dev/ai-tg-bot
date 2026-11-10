import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SQL } from "drizzle-orm";
import type { ToolActivity } from "../src/ai/toolActivity.js";

// Measures what the website's history polling costs on a long, tool-heavy thread.
// Usage: bun scripts/benchmark-history-polling.ts [checkout] [--polls N]
// The fixture is synthetic and lives in an in-memory SQLite database (or the
// PostgreSQL server in BENCH_POSTGRES_URL, in a temporary schema).
const args = process.argv.slice(2);
const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
const polls = Number(args[args.indexOf("--polls") + 1] ?? 0) || 40;
const moduleAt = (file: string) => import(pathToFileURL(path.join(root, "src", `${file}.ts`)).href);
const { loadTestConfig }: typeof import("../src/config.js") = await moduleAt("config");
const { createDatabase }: typeof import("../src/db/index.js") = await moduleAt("db/index");
const { createRepos }: typeof import("../src/db/repos/index.js") = await moduleAt("db/repos/index");
const { ConversationRepository }: typeof import("../src/web/repository.js") = await moduleAt("web/repository");
const { UsagePricing }: typeof import("../src/web/usage-pricing.js") = await moduleAt("web/usage-pricing");
// Checkouts without conditional history responses send every body in full.
const routes: Partial<typeof import("../src/web/chat-routes.js")> = await moduleAt("web/chat-routes");
const conditionalJson = routes.conditionalJson;

const postgres = process.env.BENCH_POSTGRES_URL;
let schema: string | undefined;
let admin: ReturnType<typeof createDatabase> | undefined;
let url = "sqlite::memory:";
if (postgres) {
  const { sql: raw } = await import("drizzle-orm");
  schema = `bench_history_${Date.now()}`;
  admin = createDatabase({ DB_URL: postgres });
  await admin.db.execute(raw.raw(`create schema ${schema}`));
  const parsed = new URL(postgres);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  url = parsed.toString();
}
const database = createDatabase(loadTestConfig({ DB_URL: url }));
await database.initialize();
const repos = createRepos(database.db, database.search);
const pricing = new UsagePricing(async () => Response.json({}));
const repository = new ConversationRepository(database.db, repos, 999, pricing);

const MESSAGES = 160;
const REPLY_BYTES = 6_000;
try {
  const user = await repos.users.ensure({ tgId: 77001, firstName: "Benchmark" });
  const thread = await repos.threads.create({ userId: user.tg_id, title: "Long benchmark thread", topicId: null, origin: "web" });
  let actionId = 0;
  let attachments = 0;
  for (let index = 0; index < MESSAGES; index++) {
    if (index === 60) {
      const now = Date.now();
      // A running compaction older than the 50-message tail keeps the client's cursor far back.
      actionId = (await repos.messages.insert({ threadId: thread.id, role: "system", kind: "system",
        content: { action: { kind: "compaction", status: "running", requestedAt: now, startedAt: now, updatedAt: now } },
        textPlain: "Compacting context" })).id;
      continue;
    }
    if (index % 2 === 0) {
      const text = `Question ${index}: ${"please look into this ".repeat(20)}`;
      const message = await repos.messages.insert({ threadId: thread.id, role: "user", content: { text }, textPlain: text });
      if (index % 10 === 0) {
        await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: message.id,
          type: "txt", name: `notes-${index}.txt`, size: 2_000, contentMd: "n".repeat(2_000), isInline: true });
        attachments++;
      }
      continue;
    }
    const text = `Answer ${index}. ${"Detailed findings with sources and caveats. ".repeat(Math.ceil(REPLY_BYTES / 44))}`.slice(0, REPLY_BYTES);
    const toolActivity: ToolActivity = { version: 1, omittedCalls: 0, reasoning: ["Checked the sources.", "Compared the results."],
      calls: Array.from({ length: 6 }, (_, tool) => ({ id: `call-${index}-${tool}`, name: "web_search", status: "succeeded", durationMs: 100,
        args: { format: "json", text: JSON.stringify({ query: `query ${index} ${tool}` }), truncated: false },
        result: { format: "text", text: "r".repeat(600), truncated: false } })) };
    await repos.messages.insert({ threadId: thread.id, role: "assistant", content: { text, toolActivity }, textPlain: text, thinking: "" });
  }

  const query = database.db.query.bind(database.db);
  const execute = database.db.execute.bind(database.db);
  let statements = 0;
  database.db.query = async <T extends object>(statement: SQL) => { statements++; return query<T>(statement); };
  database.db.execute = (async (statement: SQL) => { statements++; return execute(statement); }) as typeof database.db.execute;

  type History = Awaited<ReturnType<typeof repository.history>>;
  const fetchHistory = async (cursor: { after?: number }) => {
    const pages: History[] = [];
    let after = cursor.after;
    do {
      const page = await repository.history(thread.id, undefined, after);
      pages.push(page);
      after = page.newerCursor ?? undefined;
    } while (after !== undefined);
    return pages;
  };
  // The client's own cursor rule from src/web/client/chat/conversation.tsx.
  const clientCursor = (messages: History["messages"]) => {
    const active = messages.find((message) => message.action?.status === "queued" || message.action?.status === "running");
    return Math.min(messages.slice(-50)[0]?.id ?? Infinity, active?.id ?? Infinity);
  };

  const initial = await repository.history(thread.id);
  let known = initial.messages;
  // Model a reader who has loaded older messages containing the still-running
  // action. Otherwise the initial 50-message page never exposes that action.
  let older = initial.olderCursor;
  while (!known.some(message => message.id === actionId) && older !== null) {
    const page = await repository.history(thread.id, older);
    known = [...page.messages, ...known];
    older = page.olderCursor;
  }
  assert(known.some(message => message.id === actionId && message.action?.status === "running"), "The active action must be visible to the polling cursor.");
  assert.equal(clientCursor(known), actionId, "Polling must include the older active action.");
  const assertToolCalls = (messages: History["messages"]) => {
    for (const message of messages.filter(message => message.role === "assistant")) {
      assert.equal(message.toolActivity?.calls.length, 6, `Reply ${message.id} lost its persisted tool calls.`);
    }
  };
  assertToolCalls(known);
  const samples: Array<{ requests: number; statements: number; bytes: number; transferred: number; notModified: number; messages: number; ms: number; digest: string }> = [];
  const etags = new Map<string, string>();
  for (let poll = 0; poll < polls; poll++) {
    const cursor = clientCursor(known);
    statements = 0;
    const started = performance.now();
    const pages = await fetchHistory({ after: cursor === Infinity ? undefined : cursor });
    for (const page of pages) assertToolCalls(page.messages);
    const bodies = pages.map((page) => JSON.stringify(page));
    let transferred = 0, notModified = 0;
    for (const [index, body] of bodies.entries()) {
      if (!conditionalJson) { transferred += Buffer.byteLength(body); continue; }
      const key = `${cursor}:${index}`;
      const previous = etags.get(key);
      const response = conditionalJson(new Request("http://bench.invalid/history", { headers: previous ? { "If-None-Match": previous } : {} }), body);
      etags.set(key, response.headers.get("ETag")!);
      if (response.status === 304) notModified++;
      transferred += (await response.arrayBuffer()).byteLength;
    }
    const ms = performance.now() - started;
    samples.push({ requests: pages.length, statements, bytes: bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0),
      transferred, notModified, messages: pages.reduce((sum, page) => sum + page.messages.length, 0), ms,
      digest: createHash("sha256").update(bodies.join("\n")).digest("hex") });
    known = [...new Map([...known, ...pages.flatMap((page) => page.messages)].map((message) => [message.id, message])).values()]
      .sort((a, b) => a.id - b.id);
  }
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  const first = samples[0]!;
  // Steady state: every poll after the first, which a client can revalidate.
  const steady = samples.slice(1);
  const steadyTransferred = Math.round(steady.reduce((sum, sample) => sum + sample.transferred, 0) / steady.length);
  process.stdout.write(`${JSON.stringify({
    checkout: path.basename(root),
    dialect: database.dialect,
    runtime: `bun ${Bun.version}`,
    fixture: { messages: MESSAGES, assistantReplyBytes: REPLY_BYTES, toolCallsPerReply: 6, attachments, activeActionId: actionId, activeActionLoaded: true },
    polls,
    unchangedPoll: {
      requests: first.requests,
      sqlStatements: first.statements,
      responseBytes: first.bytes,
      messagesReturned: first.messages,
      identicalResponses: samples.every((sample) => sample.digest === first.digest),
      medianMs: Number(median.toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
      conditionalResponses: Boolean(conditionalJson),
      firstPollTransferredBytes: first.transferred,
      steadyTransferredBytesPerPoll: steadyTransferred,
      steadyNotModifiedPerPoll: steady.reduce((sum, sample) => sum + sample.notModified, 0) / steady.length,
    },
    perMinute: {
      busyEvery1500ms: { requests: first.requests * 40, transferredBytes: steadyTransferred * 40 },
      idleEvery8000ms: { requests: first.requests * 7.5, transferredBytes: steadyTransferred * 7.5 },
      compactingEvery1000ms: { requests: first.requests * 60, transferredBytes: steadyTransferred * 60 },
    },
  }, null, 2)}\n`);
} finally {
  await database.destroy();
  if (admin && schema) {
    const { sql: raw } = await import("drizzle-orm");
    await admin.db.execute(raw.raw(`drop schema ${schema} cascade`));
    await admin.destroy();
  }
}
