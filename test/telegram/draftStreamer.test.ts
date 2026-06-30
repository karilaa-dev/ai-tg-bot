import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { DraftStreamer } from "../../src/telegram/draftStreamer.js";

describe("DraftStreamer", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    streamer.update({ thinkingMd: "🖼️ Generating image <code>blue square</code>", answerMd: "" });
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🖼️ Generating image for 4s</summary>");
    expect(markdownOf(payloads.at(-1))).toContain("🖼️ Generating image <code>blue square</code>");

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(markdownOf(payloads.at(-1))).toContain("<summary>🖼️ Generating image for 14s</summary>");

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  if (key === "thinking-summary-generating-image") return `🖼️ Generating image for ${params?.time}`;
  if (key === "thinking-summary-final") return `🧠 Thought for ${params?.time}`;
  return key;
}
