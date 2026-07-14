import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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
      redownloadFile: async () => Buffer.from("unused"),
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
