import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { CodexAppServer, type RpcRequest } from "../../src/codex/appServer.js";
import { CodexRuntimeManager } from "../../src/codex/runtime.js";
import { ThreadBridge } from "../../src/codex/threadBridge.js";
import { dynamicToolSpecs, nativeToolSpecs } from "../../src/codex/tools.js";
import { readSkill, skillInstructions } from "../../src/codex/skills.js";
import { NATIVE_WORKSPACE_GUIDANCE, NATIVE_TOOL_DISCOVERY_GUIDANCE } from "../../src/ai/prompt.js";
import { SANDBOX_TOOL_GUIDANCE, SandboxToolsOutdatedError, OUTDATED_SANDBOX_TOOLS_MESSAGE } from "../../src/sandbox/toolPolicy.js";
import { asRecord } from "../../src/util/records.js";
import { workspaceRuntime, TEST_PNG } from "../helpers/workspaceRuntime.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function response(item: unknown, id: number): Response {
  return new Response([
    { type: "response.created", response: { id: `local-${id}` } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: `local-${id}`, usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function setup(modelReply?: (body: Record<string, unknown>, step: number) => unknown, options?: { providerName?: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-protocol-test-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const requests: Record<string, unknown>[] = [];
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ data: [] });
    const body = asRecord(await request.json()) ?? {};
    requests.push(body);
    const item = modelReply?.(body, requests.length) ?? { type: "message", id: "answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "A local protocol answer." }] };
    return response(item, requests.length);
  } });
  cleanup.push(async () => { model.stop(true); });
  const config = loadTestConfig({ CODEX_HOME: path.join(root, "codex"), DB_URL: "sqlite::memory:", CODEX_REQUEST_TIMEOUT_MS: 5000 });
  await fs.mkdir(config.CODEX_HOME, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config.CODEX_HOME, "config.toml"), `model = "gpt-6.1-sol"
model_provider = "local_protocol"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[model_providers.local_protocol]
name = ${JSON.stringify(options?.providerName ?? "Local no-cost protocol fixture")}
base_url = "http://127.0.0.1:${model.port}/v1"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
`, { mode: 0o600 });
  const db: AppDatabase = createDatabase(config);
  cleanup.push(() => db.destroy());
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 313, firstName: "Protocol", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Protocol" });
  const logger = createLogger(config);
  // Empty auth environment and private HOME ensure this never reads live credentials.
  const client = new CodexAppServer({ home: config.CODEX_HOME, requestTimeoutMs: 5000, logger,
    env: { HOME: root, OPENAI_API_KEY: "", CODEX_API_KEY: "", OPENAI_ACCESS_TOKEN: "" } });
  cleanup.push(() => client.dispose());
  const commandRuntime = Object.assign(workspaceRuntime(), { prepareRemoteExecutor: vi.fn(async () => { throw new Error("Protocol fixture must not start E2B"); }) });
  const bridge = new ThreadBridge({ config, db, repos, user, thread, logger, commandRuntime });
  cleanup.push(() => bridge.endTurn());
  return { root, config, db, repos, user, thread, logger, client, commandRuntime, bridge, requests };
}

describe("bundled native Codex protocol", () => {
  it("returns an old sandbox failure to the model with recreation guidance without upgrading or replacing it", async () => {
    const input = await setup((_body, step) => step === 1 ? {
      type: "function_call", call_id: "old-sandbox-command", name: "exec_command",
      arguments: JSON.stringify({ cmd: "python --version", workdir: "/home/user/workspace", login: false }),
    } : { type: "message", id: "recreate-answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: OUTDATED_SANDBOX_TOOLS_MESSAGE }] });
    input.commandRuntime.prepareRemoteExecutor.mockRejectedValue(new SandboxToolsOutdatedError());
    const manager = new CodexRuntimeManager({ ...input, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => manager.dispose());
    const active = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Use Python" });
    const runtime = await manager.runtime(input.thread, input.user);
    await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture files"); } });
    await runtime.session.prompt("Use Python");
    expect(input.commandRuntime.prepareRemoteExecutor).toHaveBeenCalledOnce();
    expect(JSON.stringify(input.requests[1]!.input)).toContain(OUTDATED_SANDBOX_TOOLS_MESSAGE);
    expect(JSON.stringify(input.requests[0]!.input)).toContain(SANDBOX_TOOL_GUIDANCE);
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps native caption and title helpers without host command or filesystem tools", async () => {
    const input = await setup((_body, step) => step % 2 === 1 ? {
      type: "custom_tool_call", call_id: `inspect-${step}`, namespace: "functions", name: "exec",
      input: 'text({names:ALL_TOOLS.map(tool=>tool.name),process:typeof process,require:typeof require,fetch:typeof fetch,command:typeof tools.exec_command,patch:typeof tools.apply_patch,view:typeof tools.view_image});',
    } : { type: "message", id: `answer-${step}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Helper answer" }] });
    const manager = new CodexRuntimeManager({ ...input, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => manager.dispose());
    expect(await manager.captionImage(TEST_PNG, "image/png")).toBe("Helper answer");
    expect(await manager.generateThreadTitle({ userText: "Title this conversation" })).toBe("Helper answer");
    for (const step of [1, 3]) {
      const output = (input.requests[step]!.input as unknown[]).map(asRecord).find(item => item?.type === "custom_tool_call_output");
      const encoded = JSON.stringify(output);
      expect(encoded).toContain('\\"command\\":\\"undefined\\"');
      expect(encoded).toContain('\\"patch\\":\\"undefined\\"');
      expect(encoded).toContain('\\"view\\":\\"undefined\\"');
      expect(encoded).toContain('\\"process\\":\\"undefined\\"');
      expect(encoded).toContain('\\"require\\":\\"undefined\\"');
      expect(encoded).toContain('\\"fetch\\":\\"undefined\\"');
      expect(encoded).not.toMatch(/exec_command|write_stdin|apply_patch|view_image/);
    }
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
    expect(input.commandRuntime.materializeFiles).not.toHaveBeenCalled();
  }, 15_000);

  it("accepts runtime namespaces with deferred tools and rejects the old flat deferred declarations", async () => {
    const input = await setup();
    const specs = nativeToolSpecs(input.bridge);
    const namespace = specs[0]!;
    expect(namespace).toMatchObject({ type: "namespace", name: "telegram" });
    expect(namespace.tools.find(tool => tool.name === "search_thread")?.deferLoading).toBe(true);
    expect(namespace.tools.find(tool => tool.name === "finish_response")?.deferLoading).toBe(false);
    const settings = { model: input.config.CODEX_MODEL, cwd: input.root, environments: [], ephemeral: true, approvalPolicy: "never" };
    const started = await input.client.request("thread/start", { ...settings, dynamicTools: specs });
    expect(asRecord(started.thread)?.id).toEqual(expect.any(String));
    await expect(input.client.request("thread/start", { ...settings, dynamicTools: dynamicToolSpecs(input.bridge) })).rejects.toThrow(/defer|namespace/i);
    const fallback = dynamicToolSpecs(input.bridge, true);
    expect(fallback.every(tool => typeof tool.name === "string" && !Array.isArray(asRecord(tool)?.tools))).toBe(true);
    expect(fallback.some(tool => tool.name === "bash")).toBe(true);
    expect(input.requests).toHaveLength(0);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  }, 10_000);

  it("keeps legacy tool call ids within the provider limit in the actual Responses request", async () => {
    const input = await setup();
    const legacyCallId = `call_${"x".repeat(78)}`;
    expect(legacyCallId).toHaveLength(83);
    const timestamp = "2026-09-29T19:24:26.429Z";
    const sessionFile = path.join(input.root, "legacy.jsonl");
    await fs.writeFile(sessionFile, [
      { type: "session", version: 3, id: "legacy-call-id", timestamp, cwd: input.root },
      { type: "message", id: "u", parentId: null, timestamp, message: { role: "user", content: "Remember [[chat-file:17]]." } },
      { type: "message", id: "a", parentId: "u", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: legacyCallId, name: "finish_response", arguments: { text: "Legacy reply" } }] } },
      { type: "message", id: "t", parentId: "a", timestamp, message: { role: "toolResult", toolCallId: legacyCallId, toolName: "finish_response", content: [{ type: "text", text: "Legacy reply" }], details: { completed: true, files: [{ file_id: 17 }] } } },
    ].map(entry => JSON.stringify(entry)).join("\n"));
    await input.repos.threads.setPiSession(input.thread.id, sessionFile, "legacy-call-id");
    const thread = (await input.repos.threads.get(input.thread.id))!;
    const manager = new CodexRuntimeManager({ ...input, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => manager.dispose());
    const active = await input.repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Continue" });
    const runtime = await manager.runtime(thread, input.user);
    await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture files"); } });
    await runtime.session.prompt("Continue");
    const calls = (input.requests[0]!.input as unknown[]).map(asRecord).filter(item => item?.type === "function_call" || item?.type === "function_call_output");
    expect(calls).toHaveLength(2);
    expect(calls.map(item => String(item!.call_id).length)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(calls.every(item => String(item!.call_id).length <= 64)).toBe(true);
    expect(calls[0]!.call_id).toBe(calls[1]!.call_id);
    expect(JSON.stringify(input.requests[0]!.input)).toContain("[[chat-file:17]]");
    expect(JSON.stringify(input.requests[0]!.input)).toContain("Legacy reply");
    expect(await fs.readFile(sessionFile, "utf8")).toContain(legacyCallId);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  }, 15_000);

  it("repairs a persisted invalid import while preserving subsequent native turns in provider input", async () => {
    const input = await setup((_body, step) => ({ type: "message", id: `native-answer-${step}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Native continuation ${step}` }] }));
    const legacyCallId = `call_${"p".repeat(78)}`;
    const started = await input.client.request("thread/start", { model: input.config.CODEX_MODEL, cwd: input.root, environments: [], ephemeral: false, approvalPolicy: "never", dynamicTools: nativeToolSpecs(input.bridge) });
    const oldId = String(asRecord(started.thread)!.id);
    await input.client.request("thread/inject_items", { threadId: oldId, items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Legacy context [[chat-file:17]]" }] },
      { type: "function_call", name: "finish_response", arguments: '{"text":"Legacy reply"}', call_id: legacyCallId },
      { type: "function_call_output", call_id: legacyCallId, output: "Legacy reply" },
    ] });
    const completed = new Promise<void>(resolve => {
      const off = input.client.onNotification(event => { if (event.method === "turn/completed" && event.params.threadId === oldId) { off(); resolve(); } });
    });
    const previousTurn = await input.client.request("turn/start", { threadId: oldId, environments: [], input: [{ type: "text", text: "A successful native continuation" }] });
    await completed;
    const turnId = String(asRecord(previousTurn.turn)!.id);
    const prior = await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "Native continuation 1", piEntryId: `codex:${turnId}` });
    await input.repos.threads.setCodexSession(input.thread.id, oldId, Date.now(), prior.id);
    const read = await input.client.request("thread/read", { threadId: oldId });
    const sourcePath = String(asRecord(read.thread)!.path);
    const manager = new CodexRuntimeManager({ ...input, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => manager.dispose());
    const active = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Continue after upgrade" });
    const runtime = await manager.runtime((await input.repos.threads.get(input.thread.id))!, input.user);
    await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture files"); } });
    await runtime.session.prompt("Continue after upgrade");
    const finalInput = input.requests.at(-1)!.input as unknown[];
    expect(finalInput.map(asRecord).every(item => typeof item?.call_id !== "string" || item.call_id.length <= 64)).toBe(true);
    expect(JSON.stringify(finalInput)).toContain("Legacy reply");
    expect(JSON.stringify(finalInput)).toContain("[[chat-file:17]]");
    expect(JSON.stringify(finalInput)).toContain("A successful native continuation");
    expect(JSON.stringify(finalInput)).toContain("Native continuation 1");
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).not.toBe(oldId);
    expect(await fs.readFile(sourcePath, "utf8")).toContain(legacyCallId);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  }, 15_000);

  it("discovers deferred tools and transports namespaced bot calls as basenames without starting E2B", async () => {
    const input = await setup((_body, step) => {
      if (step === 1) return { type: "custom_tool_call", call_id: "discover", namespace: "functions", name: "exec", input: 'text(ALL_TOOLS.filter(tool => tool.name === "telegram__search_thread"));' };
      if (step === 2) return { type: "function_call", call_id: "search", namespace: "telegram", name: "search_thread", arguments: JSON.stringify({ query: "fixture" }) };
      if (step === 3) return { type: "function_call", call_id: "finish", namespace: "telegram", name: "finish_response", arguments: JSON.stringify({ text: "Protocol finished." }) };
      return { type: "message", id: "answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Protocol finished." }] };
    });
    const calls: RpcRequest[] = [];
    input.client.onRequest(async event => { calls.push(event); return undefined; });
    const manager = new CodexRuntimeManager({ ...input, commandRuntime: input.commandRuntime, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => manager.dispose());
    const active = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Search and finish the reply" });
    const runtime = await manager.runtime(input.thread, input.user);
    await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture files"); } });
    await runtime.session.prompt("Search and finish the reply");
    const botCalls = calls.filter(call => call.method === "item/tool/call");
    expect(botCalls.map(call => [call.params.namespace, call.params.tool])).toEqual([["telegram", "search_thread"], ["telegram", "finish_response"]]);
    const declared = (step: number) => {
      const body = input.requests[step]!;
      const inputItems = Array.isArray(body.input) ? body.input.flatMap(value => { const item = asRecord(value); return item?.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : []; }) : [];
      const tools = (Array.isArray(body.tools) ? body.tools : inputItems) as Array<Record<string, unknown>>;
      const namespace = tools.find(tool => tool.type === "namespace" && tool.name === "telegram");
      // The bundled code-mode transport exposes namespace functions inside exec's declarations.
      const codeModeTools = tools.flatMap(tool => Array.isArray(tool.tools) ? tool.tools : []);
      const codeModeNames = codeModeTools.flatMap(tool => [...String(asRecord(tool)?.description ?? "").matchAll(/telegram__(\w+)\s*\(/g)].map(match => match[1]));
      return [...((namespace?.tools as Array<Record<string, unknown>> | undefined)?.map(tool => tool.name) ?? []), ...codeModeNames];
    };
    expect(declared(0)).toContain("finish_response");
    expect(declared(0)).not.toContain("search_thread");
    const discoveries = (input.requests[1]?.input as unknown[]).filter(value => asRecord(value)?.type === "custom_tool_call_output");
    expect(JSON.stringify(discoveries)).toContain("telegram__search_thread");
    expect(runtime.session.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "finish_response" && asRecord(entry.message.details)?.completed === true)).toBe(true);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
    expect(input.commandRuntime.materializeFiles).not.toHaveBeenCalled();
  }, 15_000);
});

describe("native skill catalog isolation", () => {
  it("stops new host catalogs on native resume while retaining valid history and its old catalog", async () => {
    const input = await setup();
    const hostSkill = path.join(input.config.CODEX_HOME, "skills", "resume-host-only", "SKILL.md");
    await fs.mkdir(path.dirname(hostSkill), { recursive: true });
    await fs.writeFile(hostSkill, "---\nname: resume-host-only\ndescription: Controlled host-only workflow for a native resume regression.\n---\nThis host guide is not in E2B.\n");
    const request = input.client.request.bind(input.client);
    vi.spyOn(input.client, "request").mockImplementation((method, params, signal) => {
      if (method === "thread/start") {
        const values = asRecord(params) ?? {};
        params = { ...values,
          developerInstructions: String(values.developerInstructions ?? "").replace(NATIVE_TOOL_DISCOVERY_GUIDANCE, "").replace(SANDBOX_TOOL_GUIDANCE, ""),
          config: { ...asRecord(values.config), "skills.include_instructions": true } };
      }
      if (method === "turn/start") {
        const values = asRecord(params) ?? {};
        params = { ...values, input: (values.input as unknown[]).map(value => {
          const part = asRecord(value)!;
          return typeof part.text === "string" ? { ...part, text: part.text.replace(`${NATIVE_WORKSPACE_GUIDANCE}\n\n`, "") } : part;
        }) };
      }
      return request(method, params, signal);
    });
    const first = new CodexRuntimeManager({ ...input, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => first.dispose());
    const run = async (manager: CodexRuntimeManager) => {
      const thread = (await input.repos.threads.get(input.thread.id))!;
      const runtime = await manager.runtime(thread, input.user);
      const active = await input.repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Continue the controlled resume fixture." });
      await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture files"); } });
      await runtime.session.prompt("Continue the controlled resume fixture.");
      await runtime.bridge.endTurn();
    };
    await run(first);
    const nativeId = (await input.repos.threads.get(input.thread.id))!.codex_thread_id;
    expect(JSON.stringify(input.requests[0]).includes("resume-host-only/SKILL.md")).toBe(true);
    expect(JSON.stringify(input.requests[0]).includes("host skill paths are unavailable")).toBe(false);
    await first.dispose();
    const client = new CodexAppServer({ home: input.config.CODEX_HOME, requestTimeoutMs: 5000, logger: input.logger,
      env: { HOME: input.root, OPENAI_API_KEY: "", CODEX_API_KEY: "", OPENAI_ACCESS_TOKEN: "" } });
    const restarted = new CodexRuntimeManager({ ...input, client, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => restarted.dispose());
    await run(restarted);
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe(nativeId);
    const resumed = JSON.stringify(input.requests[1]);
    if (process.env.CODEX_PROTOCOL_REQUEST_CAPTURE) await fs.writeFile(`${process.env.CODEX_PROTOCOL_REQUEST_CAPTURE}.resume.json`, JSON.stringify({ baseline: input.requests[0], resumed: input.requests[1] }), { mode: 0o600 });
    expect(resumed.match(/resume-host-only\/SKILL\.md/g)).toHaveLength(1);
    expect(resumed).toContain("openscad:");
    expect(resumed).toContain("A local protocol answer.");
    expect(resumed).toContain("Use read_skill for bot workflows");
    expect(resumed).toContain("host skill paths are unavailable in the remote workspace");
    expect(resumed).toContain(SANDBOX_TOOL_GUIDANCE);
    await run(restarted);
    const next = JSON.stringify(input.requests[2]);
    expect(next.match(/resume-host-only\/SKILL\.md/g)).toHaveLength(1);
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe(nativeId);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
  }, 15_000);

  it("removes host skill paths while keeping sandbox workflow discovery and read_skill", async () => {
    const input = await setup((_body, step) => {
      if (step === 2) return { type: "custom_tool_call", call_id: "skills-discovery", namespace: "functions", name: "exec", input: 'text(ALL_TOOLS.filter(tool => tool.name === "telegram__read_skill").map(tool => tool.name));' };
      if (step === 3) return { type: "function_call", call_id: "sandbox-skill", namespace: "telegram", name: "read_skill", arguments: JSON.stringify({ name: "openscad" }) };
      return { type: "message", id: `answer-${step}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Local skill check completed." }] };
    });
    const hostSkill = path.join(input.config.CODEX_HOME, "skills", "host-only-workflow", "SKILL.md");
    await fs.mkdir(path.dirname(hostSkill), { recursive: true });
    await fs.writeFile(hostSkill, "---\nname: host-only-workflow\ndescription: An installed host workflow for the controlled protocol fixture.\n---\nThis host workflow is unavailable in the remote executor.\n");
    const instructions = await skillInstructions();
    const settings = { model: input.config.CODEX_MODEL, cwd: input.root, environments: [], ephemeral: true, approvalPolicy: "never", developerInstructions: instructions, dynamicTools: nativeToolSpecs(input.bridge) };
    const calls: RpcRequest[] = [];
    input.client.onRequest(async event => {
      if (event.method !== "item/tool/call" || event.params.tool !== "read_skill") return undefined;
      calls.push(event);
      return { contentItems: [{ type: "inputText", text: await readSkill("openscad") }], success: true };
    });
    const run = async (config?: Record<string, unknown>) => {
      const started = await input.client.request("thread/start", { ...settings, ...(config ? { config } : {}) });
      const threadId = String(asRecord(started.thread)?.id);
      let unsubscribe = () => {};
      const completed = new Promise<void>((resolve, reject) => {
        unsubscribe = input.client.onNotification(event => {
          if (event.params.threadId !== threadId) return;
          if (event.method === "turn/completed") {
            if (asRecord(event.params.turn)?.status === "failed") reject(new Error("Controlled skill fixture failed."));
            else resolve();
          }
        });
      });
      try {
        await input.client.request("turn/start", { threadId, input: [{ type: "text", text: "Check the available sandbox workflow.", text_elements: [] }] });
        await completed;
      } finally { unsubscribe(); }
    };
    await run();
    const initialPrompt = JSON.stringify(input.requests[0]!.input);
    expect(initialPrompt.includes("host-only-workflow/SKILL.md")).toBe(true);
    expect(initialPrompt.includes("<skills_instructions>")).toBe(true);
    await run({ "skills.include_instructions": false });
    const optimizedPrompt = JSON.stringify(input.requests[1]!.input);
    expect(optimizedPrompt).not.toContain("host-only-workflow/SKILL.md");
    expect(optimizedPrompt).not.toContain("<skills_instructions>");
    expect(optimizedPrompt).toContain(instructions.split("\n")[0]);
    expect(optimizedPrompt).toContain("openscad:");
    expect(calls.map(event => [event.params.namespace, event.params.tool])).toEqual([["telegram", "read_skill"]]);
    const skillOutput = (input.requests[3]!.input as unknown[]).map(asRecord).find(item => item?.type === "function_call_output" && item.call_id === "sandbox-skill");
    expect(JSON.stringify(skillOutput)).toContain(JSON.stringify(await readSkill("openscad")).slice(1, -1));
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
    // These requests contain only this synthetic fixture. Opt in to a private
    // capture for prompt-size measurements without live inference or credentials.
    if (process.env.CODEX_PROTOCOL_REQUEST_CAPTURE) await fs.writeFile(process.env.CODEX_PROTOCOL_REQUEST_CAPTURE, JSON.stringify({ baseline: input.requests[0], optimized: input.requests[1], discovered: input.requests[2], skillLoaded: input.requests[3] }), { mode: 0o600 });
  }, 15_000);
});

describe("native prompt measurements", () => {
  it("measures the complete native chat prompt without starting the remote executor", async () => {
    // Use an OpenAI-shaped provider while keeping every model request local.
    // Anonymous fixtures do not load authenticated account apps or image tools.
    const input = await setup((_body, step) => step % 2 === 1 ? {
      type: "custom_tool_call", call_id: `capabilities-${step}`, namespace: "functions", name: "exec",
      input: 'text({command:typeof tools.exec_command,patch:typeof tools.apply_patch,view:typeof tools.view_image,imageNames:ALL_TOOLS.filter(tool=>tool.name.includes("imagegen")).map(tool=>tool.name),skill:typeof tools.telegram__read_skill});',
    } : { type: "message", id: `answer-${step}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Local prompt check completed." }] }, { providerName: "OpenAI" });
    const request = input.client.request.bind(input.client);
    let includeSkills = true;
    vi.spyOn(input.client, "request").mockImplementation((method, params, signal) => {
      if (method === "thread/start" || method === "thread/resume") {
        const values = asRecord(params) ?? {};
        params = { ...values, config: { ...asRecord(values.config), "skills.include_instructions": includeSkills } };
      }
      return request(method, params, signal);
    });
    const manager = new CodexRuntimeManager({ ...input, auth: async () => ({ home: input.config.CODEX_HOME, configured: true }) });
    cleanup.push(() => manager.dispose());
    const run = async (thread: typeof input.thread) => {
      const runtime = await manager.runtime(thread, input.user);
      const active = await input.repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Answer this simple fixture question." });
      await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture files"); } });
      await runtime.session.prompt("Answer this simple fixture question.");
      await runtime.bridge.endTurn();
    };
    await run(input.thread);
    includeSkills = false;
    const otherThread = await input.repos.threads.create({ userId: input.user.tg_id, topicId: null, title: "Optimized fixture" });
    await run(otherThread);
    const baseline = JSON.stringify(input.requests[0]);
    const optimized = JSON.stringify(input.requests[2]);
    if (process.env.CODEX_PROTOCOL_REQUEST_CAPTURE) await fs.writeFile(process.env.CODEX_PROTOCOL_REQUEST_CAPTURE, JSON.stringify({ baseline: input.requests[0], optimized: input.requests[2] }), { mode: 0o600 });
    expect(baseline.includes("<skills_instructions>")).toBe(true);
    expect(optimized.includes("<skills_instructions>")).toBe(false);
    expect(optimized.length).toBeLessThan(baseline.length);
    // A prompt reduction must keep the native core tools and bot workflows.
    for (const name of ["exec_command", "apply_patch", "view_image", "telegram__finish_response"]) {
      expect(baseline.includes(name), name).toBe(true);
      expect(optimized.includes(name), name).toBe(true);
    }
    expect(optimized).toContain("openscad:");
    expect(optimized).toContain("filtering ALL_TOOLS");
    const capabilities: unknown[] = [];
    for (const step of [1, 3]) {
      const output = (input.requests[step]!.input as unknown[]).map(asRecord).find(item => item?.type === "custom_tool_call_output");
      const encoded = JSON.stringify(output);
      for (const name of ["command", "patch", "view", "skill"]) expect(encoded, name).toContain(`\\"${name}\\":\\"function\\"`);
      capabilities.push((output!.output as unknown[]).map(asRecord).find(item => String(item?.text).startsWith("{"))?.text);
    }
    expect(capabilities[1]).toBe(capabilities[0]);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
  }, 15_000);
});
