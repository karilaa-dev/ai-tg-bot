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

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });

describe("persistent Pi server compaction", () => {
  it("persists native and portable state, replays after reopen/fork, and feeds the checkpoint into the next compaction", async () => {
    const { session, manager, requests, open } = await setup();
    await session.compact();
    const first = manager.getBranch().findLast(entry => entry.type === "compaction")!;
    expect(first.summary).toContain("Portable summary");
    expect(first.details).toMatchObject({ codexCompaction: { version: 1, items: [{ type: "compaction", encrypted_content: "opaque-1" }] } });
    expect(first.usage!.totalTokens).toBe(60);
    const native = requests.find(body => JSON.stringify(body.input).includes("compaction_trigger"))!;
    expect(JSON.stringify(native.input)).toContain("old project fact");
    expect(JSON.stringify(native.input)).not.toContain("recent retained request");
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
    expect(JSON.stringify(secondNative.input)).not.toContain("old project fact");
    expect(fork.sessionManager.getBranch().findLast(entry => entry.type === "compaction")!.details)
      .toMatchObject({ codexCompaction: { items: [{ encrypted_content: "opaque-2" }] } });
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

async function setup(options: { rejectNative?: boolean; disabled?: boolean; stallNative?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-compact-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "missing.json"),
    CODEX_SERVER_COMPACTION: !options.disabled, PI_REQUEST_TIMEOUT_MS: 2000 });
  const runtime = new PiRuntimeManager({ config, logger: createLogger(config), db: undefined as never, repos: undefined as never });
  await runtime.initialize();
  cleanups.push(() => runtime.dispose());
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.signature`;
  await runtime.modelRuntime.setRuntimeApiKey("openai-codex", token);
  vi.spyOn(runtime.modelRegistry, "hasConfiguredAuth").mockReturnValue(true);
  vi.spyOn(runtime.modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true, apiKey: token, headers: {} });
  const requests: Record<string, unknown>[] = [];
  let count = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
    requests.push(body);
    const native = JSON.stringify(body.input ?? []).includes("compaction_trigger");
    if (native && options.stallNative) return new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    if (native && options.rejectNative) return Response.json({ error: { message: "unsupported compaction" } }, { status: 400 });
    const output = native ? [{ type: "compaction", encrypted_content: `opaque-${++count}` }]
      : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Portable summary of project facts", annotations: [] }] }];
    const events = output.flatMap((item, output_index) => [{ type: "response.output_item.added", item, output_index }, { type: "response.output_item.done", item, output_index }]);
    return new Response([...events, { type: "response.completed", response: { status: "completed", output,
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  const manager = SessionManager.create(process.cwd(), directory);
  manager.appendMessage({ role: "user", content: "old project fact " + "filler ".repeat(200), timestamp: 1 });
  manager.appendMessage({ role: "user", content: "recent retained request " + "filler ".repeat(200), timestamp: 2 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: directory, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Preserve facts.",
    extensionFactories: [createCodexCompactionExtension({ config, modelRegistry: runtime.modelRegistry, providerRouter: runtime.providerRouter })] });
  await loader.reload();
  const open = async (sessionManager: SessionManager): Promise<AgentSession> => {
    const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: directory, modelRuntime: runtime.modelRuntime,
      model: runtime.providerRouter.mainModel, thinkingLevel: "low", noTools: "all", resourceLoader: loader, sessionManager, settingsManager });
    cleanups.push(() => session.dispose());
    return session;
  };
  return { session: await open(manager), manager, requests, open };
}
