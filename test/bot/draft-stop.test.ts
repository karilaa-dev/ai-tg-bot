import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeService } from "../../src/pi/runtime.js";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import { sql } from "drizzle-orm";
import type { ThreadRow } from "../../src/db/types.js";
import type { MessageGenerationStopped } from "grammy/types";
import { DraftStreamer } from "../../src/telegram/draftStreamer.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { deferred } from "../helpers/async.js";

let env: GrammyEmulator | undefined;
afterEach(async () => { await env?.dispose(); });

it("explains when a native Stop request can no longer cancel the reply", async () => {
  env = await createGrammyEmulator();
  const [response] = await env.bot.processUpdatesConcurrently([{ update_id: 99011,
    stopped_message_generation: { chat: env.chat, draft_id: 123 },
  }]);
  expect(response?.text).toBe("ℹ️ This reply has already finished or started sending.");
});

it.each([
  { lang: "en", draftIdType: "number" },
  { lang: "ru", draftIdType: "number" },
  { lang: "en", draftIdType: "string" },
])("acknowledges native Stop ($lang/$draftIdType) and suppresses a model response that settles later", async ({ lang, draftIdType }) => {
  const model = deferred<void>();
  const started = deferred<MessageGenerationStopped>();
  let emit: ((event: AgentSessionEvent) => void) | undefined;
  const abort = vi.fn(async () => undefined);
  const sent: Array<{ method: string; text: string; topic?: number }> = [];
  const pi = {
    runtime: async () => ({
      bridge: { beginTurn: async () => undefined, endTurn: async () => undefined, currentTurnBudget: () => undefined,
        attachments: [], publishedWebsites: [], outgoingFiles: { verifyOfficeAttachments: async () => undefined, unresolved: [] } },
      session: {
        sessionManager: { getEntries: () => [] },
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        subscribe: (listener: typeof emit) => { emit = listener; return () => undefined; },
        prompt: async () => {
          emit?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Completed answer",
            contentIndex: 0, partial: { content: [] } } } as unknown as AgentSessionEvent);
          await model.promise;
        },
        abort,
      },
    }),
    abort: async () => { await abort(); return true; },
    generateThreadTitle: async () => "Test",
  } as unknown as PiRuntimeService;
  env = await createGrammyEmulator({ privateTopics: true, turnRunner: runTurn, pi });
  await env.repos.users.setLang(env.user.id, lang === "ru" ? "ru" : "en");
  env.bot.api.config.use((previous, method, payload, requestSignal) => {
    if (method === "sendRichMessageDraft") {
      const draft = payload as { draft_id: number; message_thread_id?: number };
      started.resolve({ chat: env!.chat, draft_id: draft.draft_id, message_thread_id: draft.message_thread_id });
    } else if (method === "sendMessage" || method === "sendRichMessage") {
      const message = payload as { text?: string; rich_message?: { markdown?: string }; message_thread_id?: number };
      sent.push({ method, text: message.text ?? message.rich_message?.markdown ?? "", topic: message.message_thread_id });
    }
    return previous(method, payload, requestSignal);
  });
  const running = env.bot.sendMessage(env.user, env.chat, "Work", { messageThreadId: 42 });
  try {
    const stopped = await started.promise;
    // Telegram sends draft_id as a JSON string in real stopped-generation updates,
    // despite grammY's numeric type declaration.
    const wireStop = JSON.parse(JSON.stringify({ ...stopped,
      draft_id: draftIdType === "string" ? String(stopped.draft_id) : stopped.draft_id,
    })) as MessageGenerationStopped;
    await env.bot.handleUpdate({ update_id: 99010, stopped_message_generation: wireStop });
    expect(abort).toHaveBeenCalled();
    expect(sent).toContainEqual({ method: "sendMessage", topic: 42,
      text: lang === "ru" ? "🛑 Ответ остановлен." : "🛑 Reply stopped." });
    model.resolve();
    await running;
    const threads = await env.db.db.query<ThreadRow>(sql`select * from threads where user_id = ${env.user.id}`);
    expect(await env.repos.turnRuns.listForThread(threads[0]!.id)).toMatchObject([{ status: "cancelled" }]);
    expect(sent.some(message => message.text === "Completed answer")).toBe(false);
    expect((await env.repos.messages.listThread(threads[0]!.id)).some(message => message.role === "assistant" && message.text_plain === "Completed answer")).toBe(false);
  } finally {
    model.resolve();
    const threads = await env.db.db.query<ThreadRow>(sql`select * from threads where user_id = ${env.user.id}`);
    for (const thread of threads) await env.services.turnCoordinator.cancelActive(thread.id);
    await running;
  }
});

it("cancels the exact draft turn without a sender or waiting for its starting update", async () => {
  const started = deferred<MessageGenerationStopped>();
  let signal: AbortSignal | undefined;
  env = await createGrammyEmulator({ privateTopics: true, turnRunner: async input => {
    signal = input.signal;
    const streamer = new DraftStreamer({ api: input.api, chatId: input.chatId,
      messageThreadId: input.messageThreadId, startedAt: Date.now(), updateMs: 0,
      t: input.t, onStop: input.onCancel });
    try {
      streamer.update({ thinkingMd: "", answerMd: "working" });
      await new Promise<void>(resolve => {
        input.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally { streamer.stop(); }
  } });
  env.bot.api.config.use((previous, method, payload, requestSignal) => {
    if (method === "sendRichMessageDraft") {
      const draft = payload as { draft_id: number; message_thread_id?: number; can_stop?: boolean };
      expect(draft.can_stop).toBe(true);
      started.resolve({ chat: env!.chat, message_thread_id: draft.message_thread_id, draft_id: draft.draft_id });
    }
    return previous(method, payload, requestSignal);
  });
  const threadsForUser = () => env!.db.db.query<ThreadRow>(sql`select * from threads where user_id = ${env!.user.id}`);
  const running = env.bot.sendMessage(env.user, env.chat, "Work", { messageThreadId: 42 });
  try {
    const stopped = await started.promise;
    const before = await threadsForUser();
    for (const mismatch of [
      { ...stopped, message_thread_id: 43 },
      { ...stopped, chat: { ...env.chat, id: 2002 } },
      { ...stopped, draft_id: stopped.draft_id + 1 },
    ]) await env.bot.handleUpdate({ update_id: 99001, stopped_message_generation: mismatch });
    expect(signal?.aborted).toBe(false);
    await env.bot.handleUpdate({ update_id: 99002, stopped_message_generation: stopped });
    await running;
    expect(signal?.aborted).toBe(true);
    expect(await threadsForUser()).toEqual(before);
    const runs = await env.repos.turnRuns.listForThread(before[0]!.id);
    expect(runs).toMatchObject([{ status: "cancelled" }]);
    await env.bot.handleUpdate({ update_id: 99003, stopped_message_generation: stopped });
    expect(await env.repos.turnRuns.listForThread(before[0]!.id)).toEqual(runs);
  } finally {
    const threads = await threadsForUser();
    for (const thread of threads) await env.services.turnCoordinator.cancelActive(thread.id);
    await running;
  }
});
