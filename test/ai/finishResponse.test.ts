import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import { currentTurnAssistantResult } from "../../src/ai/currentTurnResult.js";
import { testOutgoingFiles } from "../helpers/outgoingFiles.js";
import type { ToolBuildInput } from "../../src/ai/tools/types.js";
import type { SandboxCommandRequest } from "../../src/sandbox/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("finish_response", () => {
  it("prepares with two workers, registers requested order, retains bytes and durable sources, and terminates", async () => {
    const { input, read } = await setup();
    let active = 0;
    let peak = 0;
    const original = read.getMockImplementation()!;
    read.mockImplementation(async (request) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, request.virtualPath === "/a.stl" ? 25 : 1));
      try { return await original(request); } finally { active--; }
    });
    const result = await finish(input, { text: "Ready", files: [{ path: "/a.stl" }, { path: "/b.stl" }, { path: "/c.stl" }] });
    expect(result.terminate).toBe(true);
    expect(peak).toBe(2);
    expect(input.outgoingFiles!.items.map((file) => file.sourceVirtualPath)).toEqual(["/a.stl", "/b.stl", "/c.stl"]);
    for (const attachment of input.outgoingFiles!.items) {
      expect(await input.repos.files.listSources(attachment.fileId)).toHaveLength(1);
    }
    expect(input.outgoingFiles!.items.filter((file) => file.data).length).toBeGreaterThanOrEqual(2);
    expect(input.outgoingFiles!.buffers.snapshot().peakBufferedBytes).toBeLessThanOrEqual(40 * 1024 * 1024);
    expect(result.details).toMatchObject({ completed: true, text: "Ready" });
  });

  it("reserves capacity and rejects duplicate normalized paths before any exports", async () => {
    const { input, read } = await setup();
    await finish(input, { files: Array.from({ length: 25 }, (_, index) => ({ path: `/${index}.stl` })) });
    read.mockClear();
    expect((await finish(input, { files: [{ path: "/new.stl" }] })).details).toMatchObject({ completed: false, error: expect.stringContaining("limit") });
    expect(read).not.toHaveBeenCalled();
    expect((await finish(input, { files: [{ path: "/0.stl" }, { path: "/home/user/workspace/0.stl" }] })).details).toMatchObject({ completed: false, error: expect.stringContaining("unique") });
    expect(read).not.toHaveBeenCalled();
    expect((await finish(input, { files: [{ path: "/0.stl" }] })).terminate).toBe(true);
    expect(input.outgoingFiles!.items).toHaveLength(25);
  });

  it("retains partial successes and repairs a failed earlier slot without re-exporting successes", async () => {
    const { input, read } = await setup();
    read.mockRejectedValueOnce(new Error("missing STL"));
    const partial = await finish(input, { files: [{ path: "/a.stl" }, { path: "/b.stl" }] });
    expect(partial.terminate).not.toBe(true);
    expect(partial.details).toMatchObject({ completed: false, prepared: [{ path: "/b.stl" }], errors: [{ path: "/a.stl" }] });
    const successfulId = input.outgoingFiles!.items[0]!.fileId;
    const incomplete = await finish(input, { text: "Done" });
    expect(incomplete.terminate).not.toBe(true);
    expect(incomplete.details).toMatchObject({ completed: false, errors: [{ path: "/a.stl", error: expect.stringContaining("missing STL") }] });
    const unrelated = await finish(input, { files: [{ path: "/c.stl" }] });
    expect(unrelated.terminate).not.toBe(true);
    expect(unrelated.details).toMatchObject({ completed: false, prepared: [{ path: "/c.stl" }], errors: [{ path: "/a.stl" }] });
    const repaired = await finish(input, { files: [{ path: "/home/user/workspace/a.stl" }] });
    expect(repaired.terminate).toBe(true);
    expect(input.outgoingFiles!.items.map((file) => file.sourceVirtualPath)).toEqual(["/a.stl", "/b.stl", "/c.stl"]);
    expect(input.outgoingFiles!.items[1]!.fileId).toBe(successfulId);
    expect(read.mock.calls.filter(([request]) => request.virtualPath === "/b.stl")).toHaveLength(1);
  });

  it("keeps a failed replacement unresolved until its new revision is prepared", async () => {
    const { input, read } = await setup();
    await input.outgoingFiles!.workspace([{ path: "/a.stl" }]);
    const oldId = input.outgoingFiles!.items[0]!.fileId;
    read.mockRejectedValueOnce(new Error("replacement not ready"));
    await finish(input, { files: [{ path: "/a.stl" }] });
    expect(input.outgoingFiles!.items[0]!.fileId).toBe(oldId);
    expect((await finish(input, { text: "Done" })).details).toMatchObject({ completed: false, errors: [{ path: "/a.stl" }] });
    expect((await finish(input, { files: [{ path: "/a.stl" }] })).terminate).toBe(true);
    expect(await input.repos.files.get(oldId)).toBeUndefined();
  });

  it("reserves failed slots so other files cannot exhaust their repair capacity", async () => {
    const { input, read } = await setup();
    read.mockRejectedValueOnce(new Error("missing first"));
    await finish(input, { files: Array.from({ length: 25 }, (_, index) => ({ path: `/${index}.stl` })) });
    read.mockClear();
    expect((await finish(input, { files: [{ path: "/extra.stl" }] })).details)
      .toMatchObject({ completed: false, error: expect.stringContaining("limit") });
    await expect(input.outgoingFiles!.bytes(async () => ({ name: "browser.pdf", bytes: Buffer.alloc(1) })))
      .rejects.toThrow("limit");
    expect(read).not.toHaveBeenCalled();
    expect((await finish(input, { files: [{ path: "/0.stl" }] })).terminate).toBe(true);
    expect(input.outgoingFiles!.items).toHaveLength(25);
  });

  it("cancels preparation without queuing files or terminating successfully", async () => {
    const { input, read } = await setup();
    const controller = new AbortController();
    read.mockImplementation(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
    await expect(finish(input, { files: [{ path: "/a.stl" }, { path: "/b.stl" }] }, controller.signal)).rejects.toThrow("cancelled");
    expect(input.outgoingFiles!.items).toEqual([]);
    expect(input.outgoingFiles!.buffers.snapshot().bufferedBytes).toBe(0);
  });

  it("repairs a finish_response slot through create_file without changing queue order", async () => {
    const { input, read } = await setup();
    read.mockRejectedValueOnce(new Error("missing first file"));
    await finish(input, { files: [{ path: "/first.stl" }, { path: "/second.stl" }] });
    const tools = createPiToolAdapters({ buildInput: () => input });
    const create = tools.find((tool) => tool.name === "create_file")!;
    await create.execute("extra", { path: "/third.stl" }, undefined, undefined, {} as never);
    await create.execute("repair", { path: "/first.stl" }, undefined, undefined, {} as never);
    expect(input.outgoingFiles!.items.map((file) => file.sourceVirtualPath)).toEqual(["/first.stl", "/second.stl", "/third.stl"]);
    const result = await finish(input, { text: "Ready" });
    expect(result.terminate).toBe(true);
    expect(read.mock.calls.filter(([request]) => request.virtualPath === "/second.stl")).toHaveLength(1);
  });

  it("releases prepared successes if another worker is cancelled before registration", async () => {
    const { input, read } = await setup();
    const original = read.getMockImplementation()!;
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    read.mockImplementation(async (request) => {
      if (request.virtualPath === "/second.stl") {
        await gate;
        controller.signal.throwIfAborted();
      }
      return original(request);
    });
    const result = finish(input, { files: [{ path: "/first.stl" }, { path: "/second.stl" }] }, controller.signal);
    const rejected = expect(result).rejects.toThrow("cancelled");
    try {
      await vi.waitFor(async () => expect(await input.repos.files.listForThreads([input.thread.id])).toHaveLength(1));
    } finally {
      controller.abort(new Error("cancelled"));
      release();
    }
    await rejected;
    expect(input.outgoingFiles!.items).toEqual([]);
    expect(input.outgoingFiles!.buffers.snapshot().bufferedBytes).toBe(0);
    await vi.waitFor(async () => expect(await input.repos.files.listForThreads([input.thread.id])).toEqual([]));
  });

  it("removes abandoned files and sources at turn end while retaining confirmed and ambiguous sends", async () => {
    const { input, runtime } = await setupPi([]);
    const queue = runtime.bridge.outgoingFiles;
    await queue.workspace(["abandoned", "confirmed", "unknown", "rejected"].map((name) => ({ path: `/${name}.stl` })));
    const [abandoned, confirmed, unknown, rejected] = queue.items;
    const generated = await queue.bytes(async () => ({ name: "generated.png", bytes: Buffer.from("image"), origin: "generated_image", summary: "Generated" }));
    const browser = await queue.bytes(async () => ({ name: "browser.png", bytes: Buffer.from("screenshot") }));
    // An acknowledged send must survive even if its metadata could not be saved.
    confirmed!.telegramDelivery = { messageId: 55, fileId: null, fileUniqueId: null };
    unknown!.telegramDeliveryUnknown = true;
    rejected!.telegramDeliveryFailure = "telegram_rejected";
    const remove = vi.spyOn(input.repos.files, "deleteFile");

    await runtime.bridge.endTurn();
    await runtime.bridge.endTurn();

    expect(remove).toHaveBeenCalledTimes(4);
    for (const file of [abandoned!, rejected!, generated, browser]) {
      expect(await input.repos.files.get(file.fileId)).toBeUndefined();
      expect(await input.repos.files.listSources(file.fileId)).toEqual([]);
    }
    for (const file of [confirmed!, unknown!]) {
      expect(await input.repos.files.get(file.fileId)).toBeDefined();
      expect(await input.repos.files.listSources(file.fileId)).toHaveLength(1);
    }
    expect(queue.buffers.snapshot().bufferedBytes).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it("executes four Pi cycles with both inspections and ends with one STL and final photo", async () => {
    const { input, runtime, contexts, calls } = await setupPi([
      [{ name: "read", arguments: { path: path.resolve("skills/openscad/SKILL.md") } }],
      [{ name: "bash", arguments: { script: "openscad-build preview model.scad", inspect_images: ["/model.preview.png"] } }],
      [{ name: "bash", arguments: { script: "openscad-build final model.scad", inspect_images: ["/model.final.png"] } }],
      [{ name: "finish_response", arguments: { text: "Ready to print", files: [{ path: "/model.stl", delivery: "document" }, { path: "/model.final.png", mime: "image/png", delivery: "photo_only" }] } }],
    ]);
    await runtime.session.prompt("Build the adapter", { expandPromptTemplates: false });
    expect(calls(), JSON.stringify(runtime.session.messages)).toBe(4);
    expect(runtime.bridge.currentTurnBudget()!.snapshot()).toMatchObject({ modelCycles: 4, toolCalls: 4 });
    expect(runtime.bridge.attachments.map(({ name, delivery }) => ({ name, delivery }))).toEqual([
      { name: "model.stl", delivery: "document" }, { name: "model.final.png", delivery: "photo" },
    ]);
    expect(runtime.bridge.attachments.every((file) => file.data)).toBe(true);
    const inspected = contexts[3]!.messages.filter((message) => message.role === "toolResult" && message.content.some((part) => part.type === "image"));
    expect(inspected).toHaveLength(2);
    expect(currentTurnAssistantResult(runtime.session.messages)).toMatchObject({ completed: true, text: "Ready to print" });
    const stored = await fs.readFile(runtime.session.sessionFile!, "utf8");
    expect(stored).toContain("Ready to print");
    expect(stored).not.toContain("Model: GPT-6 Astra");
    expect(input.config.PI_THINKING_LEVEL).toBe("low");
  });

  it("persists final text against the terminal result entry so forks retain a complete exchange", async () => {
    const { input, runtime } = await setupPi([[{ name: "finish_response", arguments: { text: "Persisted final" } }]]);
    const send = vi.fn(async () => ({ message_id: 7 }));
    await runTurn({ ...input, user: { ...input.user, stream_mode: 0 }, logger: input.logger!,
      api: { raw: { sendRichMessage: send, editMessageText: async () => true }, sendChatAction: async () => true } as never,
      chatId: input.user.tg_id, text: "Complete this", pi: { runtime: async () => runtime }, t: (key) => key,
    });
    const messages = await input.repos.messages.listForThreadChain([input.thread]);
    const assistant = messages.find((message) => message.role === "assistant")!;
    const terminal = runtime.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "finish_response")!;
    expect(assistant.text_plain).toBe("Persisted final");
    expect(assistant.pi_entry_id).toBe(terminal.id);
    expect(JSON.stringify(send.mock.calls)).toContain("Persisted final");
  });

  it.each(["confirmed", "ambiguous"])("preserves a %s send through turn cleanup when delivery metadata is unavailable", async (outcome) => {
    const { input, runtime } = await setupPi([[{ name: "finish_response", arguments: { files: [{ path: "/model.stl" }] } }]]);
    const metadata = vi.spyOn(input.repos.files, "rememberTelegramObservation").mockRejectedValue(new Error("metadata unavailable"));
    const sendDocument = vi.fn(async () => {
      if (outcome === "ambiguous") throw new Error("connection closed after upload");
      return { message_id: 7, document: { file_id: "sent-stl", file_unique_id: "unique-stl" } };
    });
    await runTurn({ ...input, user: { ...input.user, stream_mode: 0 }, logger: input.logger!,
      api: { sendDocument, raw: { sendRichMessage: async () => ({ message_id: 8 }), editMessageText: async () => true }, sendChatAction: async () => true } as never,
      chatId: input.user.tg_id, text: "Send the model", pi: { runtime: async () => runtime }, t: (key) => key,
    });

    expect(sendDocument).toHaveBeenCalledOnce();
    expect(metadata).toHaveBeenCalledTimes(outcome === "confirmed" ? 2 : 0);
    const retained = await input.repos.files.listForThreads([input.thread.id]);
    expect(retained).toHaveLength(1);
    expect(await input.repos.files.listSources(retained[0]!.id)).toMatchObject([{ transport: "e2b" }]);
    expect(runtime.bridge.attachments).toEqual([]);
  });

  it("blocks every tool in a mixed terminal batch before mutations, then allows repair", async () => {
    const { runtime, calls, read, execute } = await setupPi([
      [{ name: "bash", arguments: { script: "touch unwanted" } }, { name: "finish_response", arguments: { files: [{ path: "/a.stl" }] } }],
      [{ name: "finish_response", arguments: { text: "Done" } }],
    ]);
    await runtime.session.prompt("Complete the task", { expandPromptTemplates: false });
    expect(calls(), JSON.stringify(runtime.session.messages)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(currentTurnAssistantResult(runtime.session.messages)).toMatchObject({ text: "Done", completed: true });
  });
});

async function finish(input: ToolBuildInput, args: unknown, signal?: AbortSignal) {
  return createPiToolAdapters({ buildInput: () => input }).find((tool) => tool.name === "finish_response")!.execute("finish", args, signal, undefined, {} as never);
}

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-finish-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "no-auth.json"), BROWSER_USE_API_KEY: undefined });
  const db = createDatabase(config);
  await db.initialize();
  cleanups.push(() => db.destroy());
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9191, firstName: "Test", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Harness" });
  const read = vi.fn(async (request: { virtualPath: string }) => {
    const bytes = request.virtualPath.endsWith(".stl") ? Buffer.alloc(84) : Buffer.from([255, 216, 255, 224, 0]);
    return { bytes, size: bytes.length, sandboxId: "test", canonicalPath: request.virtualPath, sourceCanonicalPath: "/home/user/.file-sources/test", contentSha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const execute = vi.fn(async (request: SandboxCommandRequest) => ({
    stdout: request.args?.[1]?.includes("MISSING:magick") ? "1 100 100\n" : "Build validated",
    stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false,
    threadFiles: { directory: "/home/user/telegram-files", available: 0, files: [] },
  }));
  const input: ToolBuildInput = { config, db, repos, user, thread,
    commandRuntime: { execute, readWorkspaceFile: read, dispose: async () => undefined } as never,
    logger: createLogger({ LOG_LEVEL: "error" }),
  };
  input.outgoingFiles = testOutgoingFiles(input);
  return { input, read, execute };
}

async function setupPi(cycles: Array<Array<{ name: string; arguments: Record<string, unknown> }>>) {
  const { input, read, execute } = await setup();
  const contexts: Context[] = [];
  let call = 0;
  const pi = new PiRuntimeManager({ config: input.config, db: input.db, repos: input.repos, logger: input.logger!, commandRuntime: input.commandRuntime,
    providerStreams: { openRouter: (model, context) => {
      contexts.push({ ...context, messages: structuredClone(context.messages), tools: undefined });
      const tools = cycles[call++];
      if (!tools) throw new Error("Unexpected extra model cycle");
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(), stopReason: "toolUse",
        content: tools.map((tool, index) => ({ type: "toolCall", id: `call-${call}-${index}`, ...tool })),
        usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    } },
  });
  cleanups.push(() => pi.dispose());
  const runtime = await pi.runtime(input.thread, input.user);
  await runtime.bridge.beginTurn({ api: {} as never, chatId: input.user.tg_id, resolveFile: async () => { throw new Error("Unexpected reload"); } });
  return { input, runtime, contexts, read, execute, calls: () => call };
}
