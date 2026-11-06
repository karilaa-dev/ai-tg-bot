import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import type { MessageGenerationStopped } from "grammy/types";
import { DraftStreamer } from "../../src/telegram/draftStreamer.js";
import { deferred } from "../helpers/async.js";

describe("DraftStreamer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("only stops the matching live draft and discards queued frames and retries", async () => {
    vi.useFakeTimers();
    const first = deferred<boolean>();
    const sendRichMessageDraft = vi.fn((_payload: unknown, _signal?: AbortSignal) => first.promise);
    const api = { raw: { sendRichMessageDraft } };
    const onStop = vi.fn(async () => true);
    const streamer = new DraftStreamer({ api, chatId: 1, messageThreadId: 42,
      startedAt: Date.now(), updateMs: 1000, t: testT, onStop });
    try {
      streamer.update({ thinkingMd: "", answerMd: "first" });
      streamer.update({ thinkingMd: "", answerMd: "queued" });
      const payload = sendRichMessageDraft.mock.calls[0]![0] as { draft_id: number; can_stop: boolean };
      expect(payload.can_stop).toBe(true);
      const stopped: MessageGenerationStopped = {
        chat: { id: 1, type: "private", first_name: "Test" }, message_thread_id: 42, draft_id: payload.draft_id,
      };
      for (const mismatch of [
        { ...stopped, draft_id: payload.draft_id + 1 },
        { ...stopped, message_thread_id: 43 },
        { ...stopped, chat: { ...stopped.chat, id: 2 } },
      ]) expect(await DraftStreamer.stopGeneration(api, mismatch)).toBe(false);
      expect(await DraftStreamer.stopGeneration({ raw: {} }, stopped)).toBe(false);
      expect(onStop).not.toHaveBeenCalled();
      expect(await DraftStreamer.stopGeneration(api, stopped)).toBe(true);
      expect(onStop).toHaveBeenCalledOnce();
      expect(sendRichMessageDraft.mock.calls[0]![1]?.aborted).toBe(true);
      expect(await DraftStreamer.stopGeneration(api, stopped)).toBe(false);

      first.reject(floodWaitError(2));
      await flushPromises();
      await vi.advanceTimersByTimeAsync(30_000);
      await streamer.finish({ thinkingMd: "", answerMd: "late final frame" });
      expect(sendRichMessageDraft).toHaveBeenCalledOnce();
    } finally { streamer.stop(); }
  });

  it("matches native stop updates after falling back from a deleted topic", async () => {
    const payloads: Array<{ draft_id: number; message_thread_id?: number; can_stop?: boolean }> = [];
    const api = { raw: { sendRichMessageDraft: async (payload: typeof payloads[number]) => {
      payloads.push(payload);
      if (payload.message_thread_id) throw new GrammyError("thread missing", {
        ok: false, error_code: 400, description: "Bad Request: message thread not found",
      }, "sendRichMessageDraft", payload);
      return true;
    } } };
    const onStop = vi.fn(async () => true);
    const streamer = new DraftStreamer({ api, chatId: 1, messageThreadId: 42,
      startedAt: Date.now(), updateMs: 0, t: testT, onStop });
    try {
      streamer.update({ thinkingMd: "", answerMd: "draft" });
      await streamer.finish();
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toMatchObject({ can_stop: true, message_thread_id: undefined });
      expect(await DraftStreamer.stopGeneration(api, {
        chat: { id: 1, type: "private", first_name: "Test" }, draft_id: payloads[1]!.draft_id,
      })).toBe(true);
      expect(onStop).toHaveBeenCalledOnce();
    } finally { streamer.stop(); }
  });

  it("shows the plain thinking placeholder before any response content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const startedAt = Date.now();
    const payloads: unknown[] = [];
    const streamer = new DraftStreamer({
      api: {
        raw: {
          sendRichMessageDraft: async (payload: unknown) => {
            payloads.push(payload);
            return true;
          },
        },
      },
      chatId: 1,
      startedAt,
      updateMs: 1000,
      t: testT,
    });

    streamer.update({ thinkingMd: "", answerMd: "" });
    await flushPromises();
    expect(payloads).toHaveLength(1);
    expect(markdownOf(payloads[0])).toBe("💭 Thinking...");
    expect(markdownOf(payloads[0])).not.toContain("<details>");

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(payloads).toHaveLength(2);
    expect(markdownOf(payloads[1])).toBe("💭 Thinking...");

    streamer.stop();
  });

  it("refreshes elapsed time for thinking changes but not answer-only frames", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const startedAt = Date.now();
    const payloads: unknown[] = [];
    const streamer = new DraftStreamer({
      api: {
        raw: {
          sendRichMessageDraft: async (payload: unknown) => {
            payloads.push(payload);
            return true;
          },
        },
      },
      chatId: 1,
      startedAt,
      updateMs: 0,
      t: testT,
    });

    streamer.update({ thinkingMd: "", answerMd: "" });
    await flushPromises();

    await vi.advanceTimersByTimeAsync(3_000);
    streamer.update({ thinkingMd: "", answerMd: "Partial answer." });
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("🧠 Thinking for 0s");
    expect(markdownOf(payloads.at(-1))).toContain("Partial answer.");

    await vi.advanceTimersByTimeAsync(2_000);
    streamer.update({ thinkingMd: "🔎 Searching web <code>alpha</code> (5 results)", answerMd: "Partial answer." });
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<details>\n<summary>🧠 Thinking for 5s</summary>");
    expect(markdownOf(payloads.at(-1))).toContain("🔎 Searching web <code>alpha</code> (5 results)");
    expect(markdownOf(payloads.at(-1))).not.toContain("<tg-thinking>");

    await vi.advanceTimersByTimeAsync(3_000);
    streamer.update({ thinkingMd: "🔎 Searching web <code>alpha</code> (5 results)", answerMd: "Longer partial answer." });
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🧠 Thinking for 5s</summary>");
    expect(markdownOf(payloads.at(-1))).toContain("Longer partial answer.");

    await vi.advanceTimersByTimeAsync(7_000);
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🧠 Thinking for 15s</summary>");

    streamer.stop();
  });

  it("changes the elapsed draft title while image generation is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const startedAt = Date.now();
    const payloads: unknown[] = [];
    const streamer = new DraftStreamer({
      api: {
        raw: {
          sendRichMessageDraft: async (payload: unknown) => {
            payloads.push(payload);
            return true;
          },
        },
      },
      chatId: 1,
      startedAt,
      updateMs: 0,
      t: testT,
    });

    streamer.update({ thinkingMd: "🔎 Searching web <code>alpha</code>", answerMd: "" });
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🧠 Thinking for 0s</summary>");

    await vi.advanceTimersByTimeAsync(4_000);
    streamer.update({ thinkingMd: "🎨 Generating image <code>blue square</code>", answerMd: "" });
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🎨 Generating image for 4s</summary>");
    expect(markdownOf(payloads.at(-1))).toContain("🎨 Generating image <code>blue square</code>");

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🎨 Generating image for 14s</summary>");

    streamer.stop();
  });

  it("sends only the newest queued frame after an in-flight draft completes", async () => {
    const first = deferred();
    const payloads: unknown[] = [];
    let calls = 0;
    const streamer = new DraftStreamer({
      api: {
        raw: {
          sendRichMessageDraft: async (payload: unknown) => {
            payloads.push(payload);
            calls += 1;
            if (calls === 1) await first.promise;
            return true;
          },
        },
      },
      chatId: 1,
      startedAt: Date.now(),
      updateMs: 0,
      t: testT,
    });

    streamer.update({ thinkingMd: "", answerMd: "first" });
    await flushPromises();
    expect(payloads).toHaveLength(1);

    streamer.update({ thinkingMd: "", answerMd: "second" });
    streamer.update({ thinkingMd: "", answerMd: "third" });
    await flushPromises();
    expect(payloads).toHaveLength(1);

    first.resolve();
    await flushPromises();
    expect(payloads).toHaveLength(2);
    expect(markdownOf(payloads[1])).toContain("third");
    expect(markdownOf(payloads[1])).not.toContain("second");

    streamer.stop();
  });

  it("waits for Telegram flood-wait before retrying the newest draft frame", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const payloads: unknown[] = [];
    let calls = 0;
    const streamer = new DraftStreamer({
      api: {
        raw: {
          sendRichMessageDraft: async (payload: unknown) => {
            payloads.push(payload);
            calls += 1;
            if (calls === 1) throw floodWaitError(2);
            return true;
          },
        },
      },
      chatId: 1,
      startedAt: Date.now(),
      updateMs: 0,
      t: testT,
    });

    streamer.update({ thinkingMd: "", answerMd: "old frame" });
    await flushPromises();
    expect(payloads).toHaveLength(1);

    streamer.update({ thinkingMd: "", answerMd: "new frame" });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(payloads).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(payloads).toHaveLength(2);
    expect(markdownOf(payloads[1])).toContain("new frame");
    expect(calls).toBe(2);

    streamer.stop();
  });

  it("retries draft frames without message_thread_id when Telegram rejects the topic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const payloads: Array<Record<string, unknown>> = [];
    const streamer = new DraftStreamer({
      api: {
        raw: {
          sendRichMessageDraft: async (payload: Record<string, unknown>) => {
            payloads.push(payload);
            if (payload.message_thread_id === 42) throw threadError();
            return true;
          },
        },
      },
      chatId: 1,
      messageThreadId: 42,
      threadTitle: "Topic 42",
      startedAt: Date.now(),
      updateMs: 1000,
      t: testT,
    });

    streamer.update({ thinkingMd: "thinking", answerMd: "answer" });
    await flushPromises();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.message_thread_id).toBe(42);
    expect(payloads[1]?.message_thread_id).toBeUndefined();
    expect(JSON.stringify(payloads[1]?.rich_message)).toContain("Topic 42");

    streamer.update({ thinkingMd: "thinking", answerMd: "answer two" });
    await vi.runOnlyPendingTimersAsync();
    await flushPromises();
    expect(payloads.at(-1)?.message_thread_id).toBeUndefined();

    streamer.stop();
  });
});

function threadError(): GrammyError {
  return new GrammyError(
    "Call to sendRichMessageDraft failed",
    { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
    "sendRichMessageDraft",
    {},
  );
}

function floodWaitError(retryAfter: number): GrammyError {
  return new GrammyError(
    "Call to sendRichMessageDraft failed",
    { ok: false, error_code: 429, description: "Too Many Requests: retry later", parameters: { retry_after: retryAfter } },
    "sendRichMessageDraft",
    {},
  );
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function markdownOf(payload: unknown): string {
  return ((payload as Record<string, Record<string, string>>).rich_message).markdown ?? "";
}

function testT(key: string, params?: Record<string, string | number>): string {
  if (key === "thinking-placeholder") return "💭 Thinking...";
  if (key === "thinking-summary-running") return `🧠 Thinking for ${params?.time}`;
  if (key === "thinking-summary-generating-image") return `🎨 Generating image for ${params?.time}`;
  if (key === "thinking-summary-final") return `🧠 Thought for ${params?.time}`;
  return key;
}
