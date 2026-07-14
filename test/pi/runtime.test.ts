import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import type { PiProviderStreamOverrides } from "../../src/pi/provider.js";

describe("PiRuntimeManager", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists, reopens, maps, and forks text-only Pi sessions", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9123, firstName: "PiTest", lang: "en" });
    const parent = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Parent" });
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const image = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: parent.id,
      type: "image",
      name: "telegram.png",
      path: null,
      size: imageBytes.length,
      telegramFileId: "AgAC-runtime",
      summary: "a Telegram image marker",
      isInline: true,
    });
    let providerImageCount = 0;
    const streams = echoStreams((context) => {
      providerImageCount = context.messages.flatMap((message) =>
        message.role === "user" && Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image")
          : []).length;
    });

    const firstManager = new PiRuntimeManager({ config, db, repos, logger, providerStreams: streams });
    const first = await firstManager.runtime(parent, user);
    expect(first.session.model?.contextWindow).toBe(config.MODEL_CONTEXT_TOKENS);
    expect(first.session.settingsManager.getCompactionSettings().enabled).toBe(true);
    first.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      redownloadFile: async (file) => {
        expect(file.telegram_file_id).toBe("AgAC-runtime");
        return imageBytes;
      },
    });
    first.bridge.stageImages([image.id]);
    await first.session.prompt("persist this marker", { expandPromptTemplates: false, source: "extension" });
    const appended = first.session.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "message" ? [{ id: entry.id, role: entry.message.role }] : []);

    expect(appended.some((entry) => entry.role === "user")).toBe(true);
    expect(appended.some((entry) => entry.role === "assistant")).toBe(true);
    expect(providerImageCount).toBe(1);
    const storedParent = await repos.threads.get(parent.id);
    expect(storedParent?.pi_session_file).toBeTruthy();
    const sessionText = await fs.readFile(storedParent!.pi_session_file!, "utf8");
    expect(sessionText).toContain("persist this marker");
    expect(sessionText).not.toContain("data:image/");
    expect(sessionText).not.toContain(imageBytes.toString("base64"));
    expect(sessionText).not.toMatch(/[A-Za-z0-9+/]{500,}={0,2}/);
    await firstManager.dispose();

    const secondManager = new PiRuntimeManager({ config, db, repos, logger, providerStreams: streams });
    const reopened = await secondManager.runtime(storedParent!, user);
    expect(userText(reopened.session.messages)).toContain("persist this marker");

    const child = await repos.threads.create({
      userId: user.tg_id,
      topicId: 99,
      title: "Child",
      parentThreadId: parent.id,
      forkPointMessageId: null,
    });
    await secondManager.fork(storedParent!, child, user, reopened.session.sessionManager.getLeafId());
    const storedChild = await repos.threads.get(child.id);
    expect(storedChild?.pi_session_file).toBeTruthy();
    const childRuntime = await secondManager.runtime(storedChild!, user);
    childRuntime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      redownloadFile: async () => Buffer.from("unused"),
    });
    expect(userText(childRuntime.session.messages)).toContain("persist this marker");
    await childRuntime.session.prompt("child-only marker", { expandPromptTemplates: false, source: "extension" });
    expect(userText(childRuntime.session.messages)).toContain("child-only marker");
    expect(userText(reopened.session.messages)).not.toContain("child-only marker");
    await secondManager.dispose();
  }, 20_000);

  it("continues the Pi loop after executing a project-scoped tool", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-tools-"));
    const config = loadTestConfig({
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "bash"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9124, firstName: "ToolTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Tools" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>, context: Context) => {
      providerCalls += 1;
      const hasToolResult = context.messages.some((message) => message.role === "toolResult");
      return hasToolResult
        ? successStream(model, "Tool loop complete")
        : toolStream(model, { type: "toolCall", id: "bash-call", name: "bash", arguments: { script: "echo pi-tool-ok" } });
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      redownloadFile: async () => Buffer.from("unused"),
    });

    await runtime.session.prompt("run the bash tool", { expandPromptTemplates: false, source: "extension" });

    expect(providerCalls).toBe(2);
    const toolResult = runtime.session.messages.find((message) => message.role === "toolResult");
    expect(toolResult?.role === "toolResult" ? toolResult.content[0] : undefined).toMatchObject({ type: "text" });
    expect(toolResult?.role === "toolResult" ? toolResult.content[0]?.type === "text" && toolResult.content[0].text : "")
      .toContain("pi-tool-ok");
    expect(runtime.session.messages.at(-1)?.role).toBe("assistant");
    expect(userText(runtime.session.messages)).toContain("run the bash tool");
    await manager.dispose();
  }, 20_000);

  it("cancels an active Pi provider turn", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-abort-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9125, firstName: "AbortTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Abort" });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const stream = ((model: Model<Api>, _context: Context, options?: { signal?: AbortSignal }) => {
      const events = createAssistantMessageEventStream();
      events.push({ type: "start", partial: assistant(model, "") });
      options?.signal?.addEventListener("abort", () => {
        events.push({
          type: "error",
          reason: "aborted",
          error: { ...assistant(model, ""), stopReason: "aborted", errorMessage: "operation aborted" },
        });
      }, { once: true });
      markStarted?.();
      return events;
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      redownloadFile: async () => Buffer.from("unused"),
    });
    const prompt = runtime.session.prompt("start a cancellable turn", {
      expandPromptTemplates: false,
      source: "extension",
    });
    await started;
    expect(await manager.abort(thread.id)).toBe(true);
    await prompt;

    const assistants = runtime.session.messages.filter((message) => message.role === "assistant");
    expect(assistants.at(-1)?.stopReason).toBe("aborted");
    await manager.dispose();
  }, 20_000);

  it("uses Pi's built-in manual compaction and persists its entry", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-compact-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9126, firstName: "CompactTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Compact" });
    const stream = ((model: Model<Api>, context: Context) => successStream(
      model,
      /summari/i.test(context.systemPrompt ?? "") ? "Pi manual compact summary" : "acknowledged",
    )) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      redownloadFile: async () => Buffer.from("unused"),
    });
    await runtime.session.prompt(`durable-start ${"context ".repeat(100)} durable-end`, {
      expandPromptTemplates: false,
      source: "extension",
    });

    await manager.compact((await repos.threads.get(thread.id))!, user);

    const entries = runtime.session.sessionManager.getEntries();
    const compaction = entries.find((entry) => entry.type === "compaction");
    expect(compaction?.type === "compaction" ? compaction.summary : "").toContain("Pi manual compact summary");
    const sessionText = await fs.readFile(runtime.session.sessionFile!, "utf8");
    expect(sessionText).toContain('"type":"compaction"');
    await manager.dispose();
  }, 20_000);
});

function echoStreams(onContext?: (context: Context) => void): PiProviderStreamOverrides {
  const stream = ((model: Model<Api>, context: Context) => {
    onContext?.(context);
    const latest = [...context.messages].reverse().find((message) => message.role === "user");
    const input = latest?.role !== "user"
      ? ""
      : typeof latest.content === "string"
        ? latest.content
        : latest.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    return successStream(model, `Echo: ${input}`);
  }) as PiProviderStreamOverrides["openRouter"];
  return { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] };
}

function successStream(model: Model<Api>, text: string) {
  const stream = createAssistantMessageEventStream();
  const empty = assistant(model, "");
  stream.push({ type: "start", partial: empty });
  stream.push({ type: "text_start", contentIndex: 0, partial: empty });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant(model, text) });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant(model, text) });
  stream.push({ type: "done", reason: "stop", message: assistant(model, text) });
  return stream;
}

function toolStream(model: Model<Api>, toolCall: ToolCall) {
  const stream = createAssistantMessageEventStream();
  const start = assistant(model, "");
  const message: AssistantMessage = { ...start, content: [toolCall], stopReason: "toolUse" };
  stream.push({ type: "start", partial: start });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...start, content: [{ ...toolCall, arguments: {} }] } });
  stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: JSON.stringify(toolCall.arguments),
    partial: { ...start, content: [{ ...toolCall, arguments: {} }] },
  });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  return stream;
}

function assistant(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function userText(messages: AgentMessage[]): string {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string") return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
      ? [String((part as { text?: unknown }).text ?? "")]
      : []);
  }).join("\n");
}
