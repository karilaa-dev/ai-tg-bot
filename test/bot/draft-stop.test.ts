import { afterEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { ThreadRow } from "../../src/db/types.js";
import type { MessageGenerationStopped } from "grammy/types";
import { DraftStreamer } from "../../src/telegram/draftStreamer.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { deferred } from "../helpers/async.js";

let env: GrammyEmulator | undefined;
afterEach(async () => { await env?.dispose(); });

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
