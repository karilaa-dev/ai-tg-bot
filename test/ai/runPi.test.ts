import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "../../src/ai/run.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import type { PiProviderStreamOverrides } from "../../src/pi/provider.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";

describe("runTurn with Pi", () => {
  let db: AppDatabase | undefined;
  let manager: PiRuntimeManager | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await manager?.dispose();
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("streams Pi events, persists Telegram rows, and maps both Pi entries", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7001, firstName: "Runner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi run" });
    const stream = ((model: Model<Api>) => textStream(model, "Pi answered the Telegram turn.")) as PiProviderStreamOverrides["openRouter"];
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const richMessages: unknown[] = [];
    const drafts: unknown[] = [];
    const api = {
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richMessages.push(payload);
          return { message_id: 9001, date: 1, chat: { id: user.tg_id, type: "private", first_name: "Runner" } };
        },
        sendRichMessageDraft: async (payload: unknown) => {
          drafts.push(payload);
          return true;
        },
      },
    } as unknown as import("grammy").Api;

    await runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "hello persistent Pi",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    });

    const messages = await repos.messages.listThread(thread.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.text_plain).toBe("hello persistent Pi");
    expect(messages[0]?.pi_entry_id).toBeTruthy();
    expect(messages[1]?.text_plain).toBe("Pi answered the Telegram turn.");
    expect(messages[1]?.pi_entry_id).toBeTruthy();
    expect(messages[0]?.pi_entry_id).not.toBe(messages[1]?.pi_entry_id);
    expect(drafts.length).toBeGreaterThan(0);
    expect(richMessages).toHaveLength(1);
  }, 20_000);

  it("reports Pi setup failures through the normal Telegram error boundary", async () => {
    const config = loadTestConfig();
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7002, firstName: "NoPi", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Missing Pi" });
    const richMessages: unknown[] = [];
    const api = {
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richMessages.push(payload);
          return { message_id: 9002, date: 1, chat: { id: user.tg_id, type: "private", first_name: "NoPi" } };
        },
        sendRichMessageDraft: async () => true,
      },
    } as unknown as import("grammy").Api;

    await expect(runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "this setup must fail safely",
      t: (key) => key,
    })).resolves.toBeUndefined();

    expect(richMessages).toHaveLength(1);
    expect(JSON.stringify(richMessages[0])).toContain("Pi runtime is not configured");
  });

  it("sends a terminal generated image before final text and stores its Telegram file id once", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-image-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: path.join(tempDir, "pi") });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7003, firstName: "ImageRunner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi image run" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>) => {
      providerCalls += 1;
      return providerCalls === 1
        ? toolStream(model, {
            type: "toolCall",
            id: "generate-call",
            name: "generate_image",
            arguments: { prompt: "a red square", output_format: "png" },
          })
        : textStream(model, "unexpected follow-up");
    }) as PiProviderStreamOverrides["openRouter"];
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ b64_json: Buffer.from("generated-image-bytes").toString("base64"), media_type: "image/png" }],
    })));
    const events: string[] = [];
    let photoCalls = 0;
    const api = {
      raw: {
        sendRichMessage: async () => {
          events.push("final-text");
          return { message_id: 9010, date: 1, chat: { id: user.tg_id, type: "private", first_name: "ImageRunner" } };
        },
        sendRichMessageDraft: async () => {
          events.push("draft");
          return true;
        },
      },
      sendPhoto: async () => {
        photoCalls += 1;
        events.push("photo");
        return {
          message_id: 9011,
          photo: [{ file_id: "AgAC-sent-image", file_unique_id: "unique-sent-image", width: 10, height: 10, file_size: 21 }],
        };
      },
    } as unknown as import("grammy").Api;

    await runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "generate a red square",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key) => key === "image-generated-done" || key === "image-generated-ready"
        ? "Done — the image is ready."
        : key,
    });

    expect(providerCalls).toBe(1);
    expect(photoCalls).toBe(1);
    expect(events.indexOf("photo")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("photo")).toBeLessThan(events.indexOf("final-text"));
    const files = await repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      type: "image",
      path: null,
    });
    await expect(repos.files.listSources(files[0]!.id)).resolves.toMatchObject([{
      transport: "telegram",
      connection_key: "default",
      remote_key: "unique-sent-image",
    }]);
    const messages = await repos.messages.listThread(thread.id);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text_plain: "Done — the image is ready." });
  }, 20_000);
});

function textStream(model: Model<Api>, text: string) {
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

function resolvedFile(bytes: Buffer, fileId: number) {
  return {
    path: "",
    bytes,
    mimeType: null,
    size: bytes.length,
    contentSha256: "test-hash",
    expiresAt: Number.POSITIVE_INFINITY,
    source: { transport: "test", connectionKey: "default", remoteKey: String(fileId), locator: {} },
  };
}
