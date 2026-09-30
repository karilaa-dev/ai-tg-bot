import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import type { ThreadRow } from "../src/db/types.js";
import { createLogger } from "../src/logger.js";
import { CodexRuntimeManager } from "../src/codex/runtime.js";
import { expandPath, prepareCodexAuth } from "../src/codex/auth.js";
import { currentTurnAssistantResult } from "../src/ai/currentTurnResult.js";
import { inferenceUsageFromEntries } from "../src/ai/usage.js";
import type { CommandRuntime } from "../src/sandbox/types.js";

// This runs model requests only. Telegram, production data, and E2B are untouched.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-codex-live-"));
const configured = loadConfig();
const config = {
  ...configured,
  DB_URL: "sqlite::memory:",
  CODEX_HOME: path.join(directory, "codex"),
  PI_CODING_AGENT_DIR: path.join(directory, "pi"),
  CODEX_AUTH_FILE: undefined,
  CODEX_THINKING_LEVEL: "low" as const,
  CODEX_TURN_TIMEOUT_MS: 180_000,
  BROWSER_USE_API_KEY: undefined,
  LOG_LEVEL: "error" as const,
};
const database = createDatabase(config);
let manager: CodexRuntimeManager | undefined;
let sandboxCalls = 0;
const refuseSandbox = async (): Promise<never> => {
  sandboxCalls++;
  throw new Error("A sandbox operation was requested during a simple conversation check.");
};
const commandRuntime: CommandRuntime = {
  prepareRemoteExecutor: refuseSandbox,
  materializeFiles: refuseSandbox,
  execute: refuseSandbox,
  readWorkspaceFile: refuseSandbox,
  readSourceFile: refuseSandbox,
  publishWebsite: refuseSandbox,
  acquireActivityLease: () => ({ release() {} }),
  dispose: async () => {},
};

try {
  await fs.mkdir(config.CODEX_HOME, { recursive: true, mode: 0o700 });
  await fs.mkdir(config.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
  // Copy credentials into the disposable home so native refresh cannot modify
  // the operator's original credential files during this check.
  const sources = configured.CODEX_AUTH_FILE
    ? [expandPath(configured.CODEX_AUTH_FILE)]
    : [path.join(expandPath(configured.CODEX_HOME), "auth.json"), path.join(os.homedir(), ".codex", "auth.json")];
  for (const source of sources) {
    try {
      await fs.writeFile(path.join(config.CODEX_HOME, "auth.json"), await fs.readFile(source), { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await fs.writeFile(path.join(config.PI_CODING_AGENT_DIR, "auth.json"), await fs.readFile(path.join(expandPath(configured.PI_CODING_AGENT_DIR), "auth.json")), { mode: 0o600 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const authentication = await prepareCodexAuth({ config, homeDirectory: path.join(directory, "isolated-home") });
  await database.initialize();
  const repos = createRepos(database.db, database.search);
  const user = await repos.users.ensure({ tgId: 9_999_031, firstName: "Codex migration check", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Old Pi conversation" });
  const phrase = `CERULEAN_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const futurePhrase = `AMBER_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const legacyFile = path.join(directory, "old-pi.jsonl");
  const legacyEntries = [
    { type: "session", version: 3, id: "legacy-live-check", timestamp: now, cwd: process.cwd() },
    { type: "message", id: "old-user", parentId: null, timestamp: now, message: { role: "user", content: `My migration verification phrase is ${phrase}. Remember it for later.` } },
    { type: "message", id: "old-assistant", parentId: "old-user", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "old-finish", name: "finish_response", arguments: { text: "I will remember your migration verification phrase." } }] } },
    { type: "message", id: "old-result", parentId: "old-assistant", timestamp: now, message: { role: "toolResult", toolCallId: "old-finish", toolName: "finish_response", content: [{ type: "text", text: "I will remember your migration verification phrase." }], isError: false, details: { completed: true, text: "I will remember your migration verification phrase." } } },
    { type: "message", id: "later-user", parentId: "old-result", timestamp: now, message: { role: "user", content: `A separate later branch phrase is ${futurePhrase}. This detail was added later.` } },
  ];
  await fs.writeFile(legacyFile, legacyEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  await repos.threads.setPiSession(thread.id, legacyFile, "legacy-live-check");
  await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: `My migration verification phrase is ${phrase}. Remember it for later.`, piEntryId: "old-user" });
  const oldAssistant = await repos.messages.insert({ threadId: thread.id, role: "assistant", content: {}, textPlain: "I will remember your migration verification phrase.", piEntryId: "old-result" });
  await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: `A separate later branch phrase is ${futurePhrase}. This detail was added later.`, piEntryId: "later-user" });

  const forceFallback = process.env.CODEX_SMOKE_FORCE_OPENROUTER === "1";
  const requiredProvider = process.env.CODEX_SMOKE_REQUIRE_PROVIDER?.trim();
  const results: Array<{ provider?: string; model?: string; totalTokens: number; durationMs: number }> = [];
  let updateId = 1;
  const startManager = async () => {
    manager = new CodexRuntimeManager({ config, db: database, repos, logger: createLogger(config), commandRuntime, auth: async () => authentication });
    if (process.env.CODEX_SMOKE_DEBUG_USAGE === "1") {
      const numericUsage = (value: unknown): Record<string, number> => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
      manager.client.onNotification(event => {
        if (event.method === "rawResponse/completed") console.error(JSON.stringify({ event: event.method, keys: Object.keys(event.params), usage: numericUsage(event.params.usage) }));
        if (event.method === "thread/tokenUsage/updated") {
          const usage = event.params.tokenUsage as { total?: unknown; last?: unknown } | undefined;
          console.error(JSON.stringify({ event: event.method, keys: Object.keys(event.params), total: numericUsage(usage?.total), last: numericUsage(usage?.last) }));
        }
        if (event.method === "turn/completed") console.error(JSON.stringify({ event: event.method, status: (event.params.turn as { status?: string } | undefined)?.status }));
      });
      manager.client.onRequest(async event => {
        if (event.method === "item/tool/call") console.error(JSON.stringify({ event: event.method, tool: event.params.tool }));
        return undefined;
      });
    }
    await manager.initialize();
    if (forceFallback) manager.circuit.recordFailure();
  };
  const ask = async (selected: ThreadRow, text: string, expected: string, inspect?: (runtime: Awaited<ReturnType<CodexRuntimeManager["runtime"]>>) => Promise<void>) => {
    const accepted = await repos.turnRuns.accept({ userId: user.tg_id, threadId: selected.id, chatId: user.tg_id, messageThreadId: selected.topic_id, locale: "en", kind: "text", content: { text }, textPlain: text, sources: [{ updateId: updateId++, messageId: updateId }] });
    const runtime = await manager!.runtime((await repos.threads.get(selected.id))!, user);
    await runtime.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, userMessageId: accepted.userMessage.id, resolveFile: async () => { throw new Error("This check has no Telegram attachments."); } });
    const previousEntryIds = new Set(runtime.session.sessionManager.getEntries().map(entry => entry.id));
    const startedAt = Date.now();
    try {
      await runtime.session.prompt(text);
      const entries = runtime.session.sessionManager.getEntries().filter(entry => !previousEntryIds.has(entry.id));
      const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const result = currentTurnAssistantResult(messages);
      if (!result.completed || result.text.trim().replace(/\s*\|\s*/g, "|") !== expected) throw new Error(`The check did not return its expected result through finish_response: ${JSON.stringify({ expected, actual: result.text, completed: result.completed })}`);
      const assistant = [...messages].reverse().find(message => message.role === "assistant");
      if (requiredProvider && assistant?.provider !== requiredProvider) throw new Error(`Expected provider ${requiredProvider}; received ${assistant?.provider ?? "none"}.`);
      const userEntry = entries.find(entry => entry.type === "message" && entry.message.role === "user");
      if (userEntry) await repos.messages.setPiEntryId(accepted.userMessage.id, userEntry.id);
      const stored = await repos.messages.insert({ threadId: selected.id, role: "assistant", content: { text: result.text }, textPlain: result.text, piEntryId: entries.at(-1)?.id });
      await runtime.session.acknowledgeDelivery(stored.id);
      const totalTokens = inferenceUsageFromEntries(entries).totalTokens;
      if (assistant?.provider === "openai-codex" && totalTokens === 0) throw new Error("The successful native turn did not report model usage.");
      results.push({ provider: assistant?.provider, model: assistant?.model, totalTokens, durationMs: Date.now() - startedAt });
      await inspect?.(runtime);
    } finally { await runtime.bridge.endTurn(); }
  };

  await startManager();
  await ask(thread, "What is my migration verification phrase from the old conversation? Use finish_response alone with that phrase as its exact text. Do not use other tools.", phrase);
  const nativeId = (await repos.threads.get(thread.id))?.codex_thread_id;
  await manager!.dispose(); manager = undefined;
  await startManager();
  await ask(thread, "Repeat my migration verification phrase from before the application update. Use finish_response alone with the phrase as its exact text. Do not use other tools.", phrase);
  const restartedNativeId = (await repos.threads.get(thread.id))?.codex_thread_id;
  if (nativeId && nativeId !== restartedNativeId) throw new Error("The native conversation id changed across the manager restart.");

  let forkChecked = false;
  if (process.env.CODEX_SMOKE_SKIP_FORK !== "1") {
    const fork = await repos.threads.create({ userId: user.tg_id, topicId: 987, title: "Legacy fork check", parentThreadId: thread.id, forkPointMessageId: oldAssistant.id });
    await manager!.fork((await repos.threads.get(thread.id))!, fork, user, "old-result");
    await ask(fork, "Return my migration verification phrase, a vertical bar, and the separate later branch phrase if it appears in this conversation, otherwise NOT_PRESENT. Use finish_response alone. Do not guess or search outside this conversation.", `${phrase}|NOT_PRESENT`);
    forkChecked = true;
  }
  const title = await manager!.generateThreadTitle({ userText: "Migrating an existing Telegram conversation to Codex", assistantText: "The old conversation can be resumed." });
  if (!title.trim()) throw new Error("The helper returned an empty conversation title.");
  let imageChecked = false;
  let imageEditChecked = false;
  if (process.env.CODEX_SMOKE_IMAGE === "1") {
    const imageThread = await repos.threads.create({ userId: user.tg_id, topicId: 988, title: "Native image check" });
    let imageBytes: Buffer | undefined;
    let imagePath: string | undefined;
    const inspectImage = async (runtime: Awaited<ReturnType<CodexRuntimeManager["runtime"]>>) => {
      const image = runtime.bridge.attachments.find(attachment => attachment.type === "image");
      if (!image?.data?.length || !image.sourceVirtualPath || !runtime.bridge.isNativeArtifact(image.sourceVirtualPath)) throw new Error("The native generated image was not prepared for Telegram delivery.");
      imageBytes = Buffer.from(image.data); imagePath = image.sourceVirtualPath;
    };
    await ask(imageThread, "Use native image generation to create one tiny simple icon: a solid blue circle centered on a pure white square, no text. Prefer the smallest available image size. Do not use shell or workspace tools. Then finish_response alone with text IMAGE_READY and the native generated savedPath as one image file.", "IMAGE_READY", inspectImage);
    const caption = await manager!.captionImage(imageBytes!, "image/png");
    if (!/blue/i.test(caption)) throw new Error("The native vision helper did not recognize the generated blue icon.");
    imageChecked = true;
    if (process.env.CODEX_SMOKE_IMAGE_EDIT === "1") {
      await ask(imageThread, `Use native image generation to edit the generated image at ${imagePath}: change its blue circle to red while preserving the white background. Do not use shell or workspace tools. Then finish_response alone with text IMAGE_EDIT_READY and the new native generated savedPath as one image file.`, "IMAGE_EDIT_READY", inspectImage);
      const editedCaption = await manager!.captionImage(imageBytes!, "image/png");
      if (!/red/i.test(editedCaption)) throw new Error("The native vision helper did not recognize the edited red icon.");
      imageEditChecked = true;
    }
  }
  if (sandboxCalls !== 0) throw new Error("The simple conversation started a sandbox.");
  console.log(JSON.stringify({ ok: true, nativeAuthConfigured: authentication.configured, forcedFallback: forceFallback, migratedPiContext: true, resumedAfterRestart: true, nativeIdPreserved: nativeId ? nativeId === restartedNativeId : null, legacyForkCutoffChecked: forkChecked, helperCompleted: true, nativeImageChecked: imageChecked, nativeImageEditChecked: imageEditChecked, sandboxCalls, results }, null, 2));
} finally {
  await manager?.dispose();
  await database.destroy();
  await fs.rm(directory, { recursive: true, force: true });
}
