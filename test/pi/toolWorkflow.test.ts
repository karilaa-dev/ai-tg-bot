import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { inferenceUsageFromEntries } from "../../src/pi/usage.js";
import { DatabaseMemoryStore } from "../../src/memory/optmem/databaseStore.js";
import { createMemoTool } from "../../src/ai/tools/memo.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("Pi tool discovery and codemode", () => {
  it.each([
    { instant: "2026-01-01T02:00:00Z", offset: -420, date: "2025-12-31" },
    { instant: "2026-12-31T22:00:00Z", offset: 330, date: "2027-01-01" },
    { instant: "2026-10-07T23:45:00Z", offset: 345, date: "2026-10-08" },
    { instant: "2026-01-01T02:00:00Z", offset: null, date: "2026-01-01" },
  ])("dates notes like the session context at $instant with offset $offset", async ({ instant, offset, date }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    try {
      const { runtime, repos, user } = await setup([]);
      if (offset !== null) await repos.users.setTimezone(user.tg_id, offset);
      runtime.bridge.user = { ...user, tz_offset_min: offset };
      await runtime.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, resolveFile: async () => { throw new Error("Unexpected file"); } });
      expect(runtime.bridge.currentTurnSessionContext()).toContain(`"current_time": "${date} `);
      const tool = createMemoTool(runtime.bridge.buildInput());
      expect((await tool.execute({ args: ["note", "calendar boundary"] })).exit_code).toBe(0);
      const store = new DatabaseMemoryStore(runtime.bridge.buildInput().db.db, user.tg_id);
      expect(await store.get(0)).toEqual([0, date, "calendar boundary"]);
    } finally { vi.useRealTimers(); }
  });

  it("runs OptMem through the real session, restores it after restart, and shares only within one user", async () => {
    const { runtime, contexts, reopen, pi, repos, user, thread } = await setup([
      { name: "memo", arguments: { args: ["wake"] } },
      { name: "memo", arguments: { args: ["note", "Prefers metric measurements"] } },
      { name: "memo", arguments: { args: ["note", "Lives in Helsinki"] } },
      { name: "memo", arguments: { args: ["nap", "0-1", "Lives in Helsinki and prefers metric measurements"] } },
      { name: "finish_response", arguments: { text: "Remembered" } },
      { name: "memo", arguments: { args: ["wake"] } },
      { name: "finish_response", arguments: { text: "Recalled" } },
    ]);
    await runtime.session.prompt("Remember my preferences", { expandPromptTemplates: false });
    expect(getCurrentSystemPrompt(contexts[0].messages)).toContain("Your memory is OptMem");
    expect(JSON.stringify(contexts[0])).toContain("Read your permanent memory before other tools");
    expect(JSON.stringify(contexts[3])).toContain("Compress memories #0-1");
    expect(runtime.session.getCallableToolNames()).not.toContain("memo");
    const store = new DatabaseMemoryStore(runtime.bridge.buildInput().db.db, user.tg_id);
    const original = await store.slice(0, 2);
    expect(original).toHaveLength(2);

    const secondThread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Same user" });
    const second = await pi.runtime(secondThread, user);
    const sameUser = createMemoTool(second.bridge.buildInput());
    expect((await sameUser.execute({ args: ["recall", "HELSINKI"] })).stdout).toContain("Lives in Helsinki");
    const anotherUser = await repos.users.ensure({ tgId: 99882, firstName: "Other", lang: "en" });
    const otherThread = await repos.threads.create({ userId: anotherUser.tg_id, topicId: null, title: "Different user" });
    const other = await pi.runtime(otherThread, anotherUser);
    const isolated = createMemoTool(other.bridge.buildInput());
    expect((await isolated.execute({ args: ["recall", "HELSINKI"] })).stdout).toBe("No match.\n");
    expect(sameUser.inputSchema.safeParse({ args: ["import", "/etc/passwd"] }).success).toBe(false);
    expect(sameUser.inputSchema.safeParse({ args: ["init"] }).success).toBe(false);

    const last = await repos.threads.get(thread.id);
    if (!last) throw new Error("Missing thread");
    // Emulate an existing transcript written before memo became a core tool.
    runtime.session.setActiveToolsByName(["read", "bash", "finish_response", "codemode", "tool_search"]);
    const resumed = await reopen();
    expect(resumed.session.getActiveToolNames()).toContain("memo");
    await resumed.session.prompt("What do you remember?", { expandPromptTemplates: false });
    expect(JSON.stringify(contexts.at(-1))).toContain("Prefers metric measurements");
    expect(JSON.stringify(contexts.at(-1))).toContain("Lives in Helsinki");
    expect(await store.slice(0, 2)).toEqual(original);
    const invalid = createPiToolAdapters(resumed.bridge).find(tool => tool.name === "memo")!;
    await expect(invalid.execute("bad-import", { args: ["import", "/etc/passwd"] }, new AbortController().signal, undefined, {} as never)).rejects.toThrow("Invalid memo input");
  });

  it("refreshes the off switch in a cached session and wakes again when re-enabled", async () => {
    const { runtime, contexts, repos, user } = await setup([
      { name: "finish_response", arguments: { text: "First" } },
      { name: "finish_response", arguments: { text: "Disabled" } },
      { name: "memo", arguments: { args: ["wake"] } },
      { name: "finish_response", arguments: { text: "Enabled" } },
    ]);
    const staleTool = createMemoTool(runtime.bridge.buildInput());
    await staleTool.execute({ args: ["note", "saved before disabling"] });
    await runtime.session.prompt("First turn", { expandPromptTemplates: false });
    await repos.users.setMemoryEnabled(user.tg_id, false);
    await runtime.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, resolveFile: async () => { throw new Error("Unexpected file"); } });
    await runtime.session.prompt("Second turn", { expandPromptTemplates: false });
    expect(getCurrentTools(contexts[1].messages).map(tool => tool.name)).not.toContain("memo");
    expect(getCurrentSystemPrompt(contexts[1].messages)).toContain("Permanent memory is disabled");
    expect(getCurrentSystemPrompt(contexts[1].messages)).not.toContain("Your memory is OptMem");
    expect(await staleTool.execute({ args: ["note", "must not save"] })).toMatchObject({ exit_code: 1, stderr: expect.stringContaining("disabled") });
    const wakesBefore = runtime.session.messages.filter(message => message.role === "custom" && message.customType === "optmem-wake-context").length;
    await repos.users.setMemoryEnabled(user.tg_id, true);
    await runtime.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, resolveFile: async () => { throw new Error("Unexpected file"); } });
    await runtime.session.prompt("Third turn", { expandPromptTemplates: false });
    expect(getCurrentTools(contexts[2].messages).map(tool => tool.name)).toContain("memo");
    expect(JSON.stringify(contexts.at(-1))).toContain("saved before disabling");
    expect(runtime.session.messages.filter(message => message.role === "custom" && message.customType === "optmem-wake-context")).toHaveLength(wakesBefore + 1);
  });

  it("starts with six tools and discovers a specialist without exposing mutations to scripts", async () => {
    const { runtime, contexts } = await setup([
      { name: "tool_search", arguments: { query: "browser_navigate", limit: 1 } },
      { name: "finish_response", arguments: { text: "Done" } },
    ], true);
    expect(runtime.session.getActiveToolNames().sort()).toEqual(["bash", "codemode", "finish_response", "memo", "read", "tool_search"]);
    expect(runtime.session.getCallableToolNames()).toEqual(expect.arrayContaining(["web_search", "web_extract", "read_file_section"]));
    for (const name of ["bash", "finish_response", "create_file", "generate_image", "browser_navigate", "materialize_chat_files"]) {
      expect(runtime.session.getCallableToolNames()).not.toContain(name);
    }

    await runtime.session.prompt("Find the browser navigation tool", { expandPromptTemplates: false });

    expect(getCurrentTools(contexts[0]!.messages)).toHaveLength(6);
    const initialToolChars = JSON.stringify(getCurrentTools(contexts[0]!.messages)).length;
    const initialPromptChars = getCurrentSystemPrompt(contexts[0]!.messages).length;
    // Bound the actual initial prompt and tool schemas independently of the full tool catalog.
    expect(initialPromptChars + initialToolChars).toBeLessThanOrEqual(18_500);
    const previousChars = JSON.stringify(runtime.session.getAllTools().filter((tool) => !["codemode", "tool_search"].includes(tool.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters }))).length;
    expect(initialToolChars).toBeLessThan(previousChars * 0.65);
    expect(getCurrentTools(contexts[1]!.messages).map((tool) => tool.name)).toContain("browser_navigate");
    expect(runtime.session.getCallableToolNames()).not.toContain("browser_navigate");
    expect(result(runtime.session.messages, "tool_search").details).toMatchObject({ loaded: ["browser_navigate"] });
  });

  it("runs independent reads with structured results and counts nested calls", async () => {
    const { runtime } = await setup([
      { name: "codemode", arguments: { code: "const results = await Promise.allSettled([tools.search_thread({query: 'alpha'}), tools.search_thread({query: 'beta'})]); text(results.map(r => r.status === 'fulfilled' ? {count: r.value.results.length} : {error: r.reason.message}));" } },
      { name: "finish_response", arguments: { text: "Research complete" } },
    ]);

    await runtime.session.prompt("Read both subjects", { expandPromptTemplates: false });

    const execution = result(runtime.session.messages, "codemode");
    expect(execution.isError).toBe(false);
    expect(JSON.stringify(execution.content)).toContain('count');
    expect(JSON.stringify(execution.content)).not.toContain('Script failed');
    expect(execution.nestedCalls?.calls.map((call) => call.name)).toEqual(["search_thread", "search_thread"]);
    expect(runtime.bridge.currentTurnBudget()!.snapshot()).toMatchObject({ modelCycles: 2, toolCalls: 4 });
  });

  it("restores discovered specialists after reopening a persistent session", async () => {
    const { runtime, contexts, reopen } = await setup([
      { name: "tool_search", arguments: { query: "browser_navigate", limit: 1 } },
      { name: "finish_response", arguments: { text: "Discovered" } },
      { name: "finish_response", arguments: { text: "Resumed" } },
    ], true);
    await runtime.session.prompt("Discover browser navigation", { expandPromptTemplates: false });
    const active = runtime.session.getActiveToolNames();
    expect(active).toContain("browser_navigate");

    const resumed = await reopen();

    expect(resumed.session.getActiveToolNames()).toEqual(active);
    expect(resumed.session.getCallableToolNames()).not.toContain("browser_navigate");
    await resumed.session.prompt("Continue working", { expandPromptTemplates: false });
    expect(getCurrentTools(contexts.at(-1)!.messages).map((tool) => tool.name)).toContain("browser_navigate");
  });

  it("returns structured failures to scripts and enforces the nested tool-call budget", async () => {
    const { runtime } = await setup([
      { name: "codemode", arguments: { code: "const results = await Promise.allSettled([tools.read_file_section({file_id: 99999, chunk_index: 0}), tools.read_file_section({file_id: 99998, chunk_index: 0}), tools.read_file_section({file_id: 99997, chunk_index: 0})]); text(results.map(r => r.status === 'fulfilled' ? r.value : {error: r.reason.message}));" } },
      { name: "finish_response", arguments: { text: "Handled" } },
    ], false, 3);

    await runtime.session.prompt("Read missing files", { expandPromptTemplates: false });

    expect(runtime.bridge.currentTurnBudget()!.snapshot()).toMatchObject({ toolCalls: 3, terminationReason: "tool_call_limit" });
    const execution = result(runtime.session.messages, "codemode");
    expect(execution.nestedCalls?.calls.filter((call) => call.status === "error")).toHaveLength(3);
    expect(JSON.stringify(execution.content)).toContain("file not found in this thread");
  });

  it("rejects delivery and workspace mutations inside scripts", async () => {
    const { runtime } = await setup([
      { name: "codemode", arguments: { code: "text(ALL_TOOLS.map(t => t.name)); await tools.finish_response({text: 'Must not deliver'});" } },
      { name: "finish_response", arguments: { text: "Delivered directly" } },
    ]);

    await runtime.session.prompt("Check available script tools", { expandPromptTemplates: false });

    const execution = result(runtime.session.messages, "codemode");
    expect(execution.isError).toBe(true);
    expect(JSON.stringify(execution.content)).not.toContain('"bash"');
    expect(result(runtime.session.messages, "finish_response").details).toMatchObject({ text: "Delivered directly", completed: true });
    expect(runtime.bridge.currentTurnBudget()!.snapshot().toolCalls).toBe(2);
  });

  it("keeps the failure limit across scripts that catch nested errors", async () => {
    const { runtime } = await setup(Array.from({ length: 3 }, (_, index) => ({
      name: "codemode", arguments: { code: `text(await tools.read_file_section({file_id: ${99000 + index}, chunk_index: 0}));` },
    })), false, 40, 3);

    await runtime.session.prompt("Read three missing files", { expandPromptTemplates: false });

    expect(runtime.bridge.currentTurnBudget()!.snapshot()).toMatchObject({
      modelCycles: 3, toolCalls: 6, terminationReason: "consecutive_tool_failures",
    });
    expect(result(runtime.session.messages, "codemode").isError).toBe(false);
  });

  it("completes beyond the previous cycle, call and failure limits with default configuration", async () => {
    const { runtime } = await setup([
      ...Array.from({ length: 22 }, () => ({
        name: "codemode", arguments: { code: "text(await Promise.all([tools.read_file_section({file_id: 99999, chunk_index: 0}), tools.read_file_section({file_id: 99999, chunk_index: 0})]));" },
      })),
      { name: "finish_response", arguments: { text: "Completed without a cap" } },
    ]);

    await runtime.session.prompt("Continue through many research attempts", { expandPromptTemplates: false });

    expect(runtime.bridge.currentTurnBudget()!.snapshot()).toMatchObject({ modelCycles: 23, toolCalls: 67, terminationReason: undefined });
    expect(result(runtime.session.messages, "finish_response").details).toMatchObject({ completed: true, text: "Completed without a cap" });
  });

  it("persists pruning before the next model request without losing raw results or usage", async () => {
    const { runtime, contexts } = await setup([
      { name: "codemode", arguments: { code: "text('old inspection output '.repeat(500));" } },
      ...Array.from({ length: 6 }, () => ({ name: "codemode", arguments: { code: "text('recent result');" } })),
      { name: "finish_response", arguments: { text: "Done" } },
    ]);

    await runtime.session.prompt("Work through a long task", { expandPromptTemplates: false });

    const entries = runtime.session.sessionManager.getEntries();
    const original = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "codemode");
    if (!original || original.type !== "message") throw new Error("Missing raw codemode result");
    expect(JSON.stringify(original.message).length).toBeGreaterThan(6000);
    expect(entries.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId)).toEqual([original.id]);
    const nextRequest = contexts.at(-1)!.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(JSON.stringify(nextRequest)).toContain("Earlier tool result shortened");
    expect(JSON.stringify(nextRequest).length).toBeLessThan(5000);
    expect(inferenceUsageFromEntries(entries).totalTokens).toBe(8 * 15);
    expect(runtime.bridge.currentTurnBudget()!.snapshot()).toMatchObject({ modelCycles: 8, toolCalls: 8 });
  });
});

function result(messages: Awaited<ReturnType<PiRuntimeManager["runtime"]>>["session"]["messages"], name: string) {
  const message = messages.find((message) => message.role === "toolResult" && message.toolName === name);
  if (!message || message.role !== "toolResult") throw new Error(`Missing ${name} result: ${JSON.stringify(messages)}`);
  return message;
}

async function setup(calls: Array<{ name: string; arguments: JsonObject }>, browser = false, maxToolCalls = 0, maxConsecutiveToolFailures = 0) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tool-workflow-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "no-auth.json"), BROWSER_USE_API_KEY: browser ? "test-browser" : undefined, PI_MAX_TOOL_CALLS: maxToolCalls, PI_MAX_CONSECUTIVE_TOOL_FAILURES: maxConsecutiveToolFailures });
  const db = createDatabase(config);
  await db.initialize();
  cleanups.push(() => db.destroy());
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 99881, firstName: "Test", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Tool workflow" });
  const contexts: TranscriptContext[] = [];
  let cycle = 0;
  const input: ConstructorParameters<typeof PiRuntimeManager>[0] = { config, db, repos, logger: createLogger(config), providerStreams: {
    openRouter: (model, context) => {
      contexts.push(structuredClone(context));
      const call = calls[cycle++];
      if (!call) throw new Error("Unexpected extra model cycle");
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "toolCall", id: `call-${cycle}`, ...call }],
        provider: model.provider, model: model.id, api: model.api, stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  } };
  const pi = new PiRuntimeManager(input);
  cleanups.push(() => pi.dispose());
  const runtime = await pi.runtime(thread, user);
  await runtime.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, resolveFile: async () => { throw new Error("Unexpected file reload"); } });
  return { runtime, contexts, pi, repos, user, config, thread, reopen: async () => {
    await pi.dispose();
    const savedThread = await repos.threads.get(thread.id);
    if (!savedThread) throw new Error("Missing persistent thread");
    const nextPi = new PiRuntimeManager(input);
    cleanups.push(() => nextPi.dispose());
    const resumed = await nextPi.runtime(savedThread, user);
    await resumed.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, resolveFile: async () => { throw new Error("Unexpected file reload"); } });
    return resumed;
  } };
}
