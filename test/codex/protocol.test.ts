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

async function setup(modelReply?: (body: Record<string, unknown>, step: number) => unknown) {
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
name = "Local no-cost protocol fixture"
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
