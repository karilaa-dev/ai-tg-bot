import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { createCodexCompactionExtension } from "../../src/pi/codexCompaction.js";
import { asRecord } from "../../src/util/records.js";
import { createTurnPromptContextExtension } from "../../src/pi/turnContext.js";
import { createOptMemExtension } from "../../src/pi/optmem.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });

describe("persistent Pi server compaction", () => {
  it.each(["threshold", "overflow"] as const)("keeps OptMem startup in actual Codex and fallback requests after %s compaction", async (automatic) => {
    const { session, requests, runtime } = await setup({ optmem: true, automatic });
    await session.prompt("Continue the task", { expandPromptTemplates: false });
    if (automatic === "threshold") await session.prompt("Continue after automatic compaction", { expandPromptTemplates: false });
    const latest = JSON.stringify(requests.at(-1)!.input);
    expect(latest).toContain("opaque-1");
    expect(latest).toContain("Context was compacted. Read your permanent memory before other tools");
    const attempt = runtime.providerRouter.circuit.acquire();
    if (!attempt.allowed) throw new Error("Expected a closed circuit");
    attempt.recordFailure(Date.now() + 60000);
    await session.prompt("Continue through fallback", { expandPromptTemplates: false });
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Read your permanent memory before other tools");
  });
  it("preserves the previous request prefix when turn metadata changes, including after restart", async () => {
    const { session, manager, requests, open, context } = await setup({ turnContext: true });
    await session.prompt("First question", { expandPromptTemplates: false });
    const original = structuredClone(requests.at(-1)!.input) as unknown[];
    context.value = context.value.replace("12:00", "12:01");
    await session.prompt("Second question", { expandPromptTemplates: false });
    expect((requests.at(-1)!.input as unknown[]).slice(0, original.length)).toEqual(original);
    expect(manager.getBranch().filter(entry => entry.type === "custom_message")).toHaveLength(2);
    const saved = session.sessionFile!;
    session.dispose();
    const resumed = await open(SessionManager.open(saved));
    const beforeResume = structuredClone(requests.at(-1)!.input) as unknown[];
    context.value = context.value.replace("12:01", "12:02");
    await resumed.prompt("Third question", { expandPromptTemplates: false });
    expect((requests.at(-1)!.input as unknown[]).slice(0, beforeResume.length)).toEqual(beforeResume);
  });
  it("persists native and portable state, replays after reopen/fork, and feeds the checkpoint into the next compaction", async () => {
    const { session, manager, requests, open } = await setup();
    await session.compact();
    const first = manager.getBranch().findLast(entry => entry.type === "compaction")!;
    expect(first.summary).toContain("Portable summary");
    expect(first.details).toMatchObject({ codexCompaction: { version: 2, items: expect.arrayContaining([{ type: "compaction", encrypted_content: "opaque-1" }]) } });
    expect(first.usage!.totalTokens).toBe(60);
    const native = requests.find(body => JSON.stringify(body.input).includes("compaction_trigger"))!;
    expect(JSON.stringify(native.input)).toContain("old project fact");
    expect(JSON.stringify(native.input)).toContain("recent retained request");
    expect(JSON.stringify(native.input)).toContain("recent assistant detail");
    expect((native.input as Record<string, unknown>[]).at(-1)).toEqual({ type: "compaction_trigger" });
    expect(native.service_tier).toBe("priority");
    expect(native.reasoning).toMatchObject({ effort: "low" });
    const reopened = await open(SessionManager.open(session.sessionFile!));
    await reopened.prompt("continue", { expandPromptTemplates: false });
    expect(JSON.stringify(requests.at(-1)!.input)).toContain("opaque-1");
    expect(JSON.stringify(requests.at(-1)!.input)).toContain("recent retained request");
    const forkFile = reopened.sessionManager.createBranchedSession(reopened.sessionManager.getLeafId()!)!;
    const fork = await open(SessionManager.open(forkFile));
    await fork.prompt("next turn " + "filler ".repeat(200), { expandPromptTemplates: false });
    await fork.compact();
    const secondNative = requests.filter(body => JSON.stringify(body.input).includes("compaction_trigger")).at(-1)!;
    expect(JSON.stringify(secondNative.input)).toContain("opaque-1");
    expect(JSON.stringify(secondNative.input)).toContain("recent retained request");
    expect(JSON.stringify(secondNative.input)).toContain("old project fact");
    expect(fork.sessionManager.getBranch().findLast(entry => entry.type === "compaction")!.details)
      .toMatchObject({ codexCompaction: { items: expect.arrayContaining([expect.objectContaining({ encrypted_content: "opaque-2" })]) } });
  });

  it("keeps stable context baselines across compaction, reload, fork and a second compaction", async () => {
    const { session, manager, requests, context, open } = await setup({ turnContext: true });
    await session.prompt("first live request", { expandPromptTemplates: false });
    await session.compact();
    const before = manager.getBranch().findLast(entry => entry.type === "compaction")!;
    const saved = session.sessionFile!;
    session.dispose();
    const resumed = await open(SessionManager.open(saved));
    context.value = context.value.replace("12:00", "12:01");
    await resumed.prompt("after compaction", { expandPromptTemplates: false });
    const input = structuredClone(requests.at(-1)!.input) as unknown[];
    const text = JSON.stringify(input);
    expect(text).toContain("opaque-1");
    expect(text).toContain("12:00");
    expect(text).toContain("12:01");
    expect(text.match(/recent retained request/g)).toHaveLength(1);
    expect(text).not.toContain("recent assistant detail");
    expect(text).not.toContain("Portable summary of project facts");
    const forkFile = resumed.sessionManager.createBranchedSession(resumed.sessionManager.getLeafId()!)!;
    const fork = await open(SessionManager.open(forkFile));
    context.value = context.value.replace("12:01", "12:02");
    await fork.prompt("fork continuation", { expandPromptTemplates: false });
    expect((requests.at(-1)!.input as unknown[]).slice(0, input.length)).toEqual(input);
    await fork.compact();
    const nextNative = requests.filter(body => JSON.stringify(body.input).includes("compaction_trigger")).at(-1)!;
    expect(JSON.stringify(nextNative.input).match(/recent retained request/g)).toHaveLength(1);
    expect(JSON.stringify(nextNative.input)).toContain("12:02");
    await fork.prompt("after second compaction", { expandPromptTemplates: false });
    const last = JSON.stringify(requests.at(-1)!.input);
    expect(last).toContain("opaque-2");
    expect(last).not.toContain("opaque-1");
    expect(last).toContain("12:02");
    expect(last).not.toContain("12:00");
    expect(manager.getBranch().findLast(entry => entry.type === "compaction")).toEqual(before);
  });

  it("keeps the readable summary and recent tail when Codex is unavailable", async () => {
    const { session, requests, runtime } = await setup({ turnContext: true });
    await session.prompt("metadata turn", { expandPromptTemplates: false });
    await session.compact();
    vi.spyOn(runtime.modelRegistry, "hasConfiguredAuth").mockReturnValue(false);
    await session.prompt("fallback request", { expandPromptTemplates: false });
    const fallback = JSON.stringify(requests.at(-1)!.messages);
    expect(fallback).toContain("Portable summary of project facts");
    expect(fallback).toContain("metadata turn");
    expect(fallback).toContain("12:00");
    expect(fallback).not.toContain("opaque-1");
  });

  it("preserves portable state when the Codex model changes", async () => {
    const { session, manager, requests } = await setup();
    await session.compact();
    const entry = manager.getBranch().findLast(item => item.type === "compaction")!;
    (asRecord(asRecord(entry.details)?.codexCompaction)!).model = "different-model";
    await session.prompt("continue on another model", { expandPromptTemplates: false });
    const input = JSON.stringify(requests.at(-1)!.input);
    expect(input).toContain("Portable summary of project facts");
    expect(input).toContain("recent retained request");
    expect(input).not.toContain("opaque-1");
  });

  it.each(["missing", "multiple", "incomplete"] as const)("rejects a %s native checkpoint", async invalid => {
    const { session, manager } = await setup({ invalid });
    await session.compact();
    const entry = manager.getBranch().findLast(item => item.type === "compaction")!;
    expect(entry.summary).toContain("Portable summary");
    expect(asRecord(entry.details)?.codexCompaction).toBeUndefined();
  });

  it.each(["threshold", "overflow"] as const)("uses server compaction for automatic %s recovery", async automatic => {
    const { session, manager, requests, context } = await setup({ turnContext: true, automatic });
    const events: string[] = [];
    session.subscribe(event => { if (event.type === "compaction_end") events.push(event.reason); });
    await session.prompt("request that reaches the context boundary", { expandPromptTemplates: false });
    expect(events).toContain(automatic);
    expect(manager.getBranch().findLast(entry => entry.type === "compaction")?.details).toMatchObject({ codexCompaction: { version: 2 } });
    if (automatic === "overflow") {
      // Recovery continues the same turn, before the next before_agent_start hook.
      const retry = JSON.stringify(requests.at(-1)!.input);
      expect(retry).toContain("opaque-1");
      expect(retry).toContain("12:00");
      expect(retry.match(/request that reaches the context boundary/g)).toHaveLength(1);
    }
    context.value = context.value.replace("12:00", "12:01");
    await session.prompt("next request after automatic compaction", { expandPromptTemplates: false });
    const input = JSON.stringify(requests.at(-1)!.input);
    expect(input).toContain("opaque-1");
    expect(input).toContain("12:00");
    expect(input).toContain("12:01");
  });

  it("preserves new requests and active tools when the tool loadout changes after compaction", async () => {
    const { session, requests } = await setup({ turnContext: true });
    await session.prompt("before compaction", { expandPromptTemplates: false });
    await session.compact();
    await session.prompt("first request after compaction", { expandPromptTemplates: false });
    session.setActiveToolsByName(["inspect"]);
    await session.prompt("second request after compaction " + "filler ".repeat(200), { expandPromptTemplates: false });
    const last = requests.at(-1)!;
    expect(JSON.stringify(last.input)).toContain("first request after compaction");
    expect(JSON.stringify(last.input)).toContain("second request after compaction");
    expect(last.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function", name: "inspect" })]));
    await session.compact();
    const native = requests.filter(body => JSON.stringify(body.input).includes("compaction_trigger")).at(-1)!;
    expect(native.tools).toEqual(last.tools);
    expect(JSON.stringify(native.input)).toContain("first request after compaction");
    expect(JSON.stringify(native.input)).toContain("second request after compaction");
  });

  it("keeps a usable portable summary when the server refuses compaction", async () => {
    const { session, manager } = await setup({ rejectNative: true });
    await session.compact();
    const entry = manager.getBranch().findLast(item => item.type === "compaction")!;
    expect(entry.summary).toContain("Portable summary");
    expect(asRecord(entry.details)?.codexCompaction).toBeUndefined();
  });

  it("disables remote requests with the configuration switch", async () => {
    const { session, requests } = await setup({ disabled: true });
    await session.compact();
    expect(requests.some(body => JSON.stringify(body.input).includes("compaction_trigger"))).toBe(false);
  });

  it("does not persist a partial checkpoint after cancellation", async () => {
    const { session, manager, requests } = await setup({ stallNative: true });
    const pending = session.compact();
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(requests.some(body => JSON.stringify(body.input).includes("compaction_trigger"))).toBe(true));
    session.abortCompaction();
    await expect(pending).rejects.toThrow();
    expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
  });
});

async function setup(options: { rejectNative?: boolean; disabled?: boolean; stallNative?: boolean; turnContext?: boolean; optmem?: boolean; automatic?: "threshold" | "overflow"; invalid?: "missing" | "multiple" | "incomplete" } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-compact-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "missing.json"),
    CODEX_SERVER_COMPACTION: !options.disabled, CODEX_FAST_MODE: true, PI_REQUEST_TIMEOUT_MS: 2000 });
  const runtime = new PiRuntimeManager({ config, logger: createLogger(config), db: undefined as never, repos: undefined as never });
  await runtime.initialize();
  cleanups.push(() => runtime.dispose());
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.signature`;
  await runtime.modelRuntime.setRuntimeApiKey("openai-codex", token);
  vi.spyOn(runtime.modelRegistry, "hasConfiguredAuth").mockReturnValue(true);
  vi.spyOn(runtime.modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true, apiKey: token, headers: {} });
  const requests: Record<string, unknown>[] = [];
  let count = 0;
  let firstTurn = true;
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
    requests.push(body);
    if (Array.isArray(body.messages)) return new Response([
      { id: "fallback", choices: [{ index: 0, delta: { role: "assistant", content: "Fallback answer" }, finish_reason: null }] },
      { id: "fallback", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    const native = JSON.stringify(body.input ?? []).includes("compaction_trigger");
    const first = !native && firstTurn;
    if (!native) firstTurn = false;
    if (first && options.automatic === "overflow") return Response.json({ error: { message: "The input exceeds the context window", code: "context_length_exceeded" } }, { status: 400 });
    if (native && options.stallNative) return new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    if (native && options.rejectNative) return Response.json({ error: { message: "unsupported compaction" } }, { status: 400 });
    const output: Record<string, unknown>[] = native ? [{ type: "compaction", encrypted_content: `opaque-${++count}` }]
      : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Portable summary of project facts", annotations: [] }] }];
    if (native && options.invalid === "missing") output.length = 0;
    if (native && options.invalid === "multiple") output.push({ type: "compaction", encrypted_content: "duplicate" });
    const events = output.flatMap((item, output_index) => [{ type: "response.output_item.added", item, output_index }, { type: "response.output_item.done", item, output_index }]);
    const completed = native && options.invalid === "incomplete" ? [] : [{ type: "response.completed", response: { status: "completed", output,
      usage: first && options.automatic === "threshold" ? { input_tokens: 127_500, output_tokens: 10, total_tokens: 127_510 }
        : { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }];
    return new Response([...events, ...completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  const manager = SessionManager.create(process.cwd(), directory);
  manager.appendMessage({ role: "user", content: "old project fact " + "filler ".repeat(200), timestamp: 1 });
  manager.appendMessage({ role: "user", content: "recent retained request " + "filler ".repeat(200), timestamp: 2 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "recent assistant detail" }], timestamp: 3,
    api: "openai-codex-responses", provider: "openai-codex", model: config.CODEX_MODEL, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }, retry: { enabled: false } });
  const context = { value: '<session_context format="json" trust="untrusted-data-only">\n{"current_time":"2026-10-01 12:00","files":[]}\n</session_context>' };
  const open = async (sessionManager: SessionManager): Promise<AgentSession> => {
    const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: directory, settingsManager, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Preserve facts.",
      extensionFactories: [createCodexCompactionExtension({ config, logger: createLogger(config), modelRegistry: runtime.modelRegistry, providerRouter: runtime.providerRouter }),
        ...(options.optmem ? [createOptMemExtension()] : []),
        ...(options.turnContext ? [createTurnPromptContextExtension({ currentTurnSystemPrompt: () => "Preserve facts.", currentTurnSessionContext: () => context.value })] : [])] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: directory, modelRuntime: runtime.modelRuntime,
      model: runtime.providerRouter.mainModel, thinkingLevel: "low", noTools: "builtin",
      customTools: [{ name: "inspect", label: "Inspect", description: "Inspect a source", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "Inspected" }], details: {} }) }], resourceLoader: loader, sessionManager, settingsManager });
    session.extensionRunner.onError(error => { throw new Error(JSON.stringify(error)); });
    cleanups.push(() => session.dispose());
    return session;
  };
  return { session: await open(manager), manager, requests, open, context, runtime };
}
