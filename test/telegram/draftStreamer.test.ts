import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { DraftStreamer } from "../../src/telegram/draftStreamer.js";

describe("DraftStreamer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resends the latest draft frame as a keepalive during long tool waits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
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
      updateMs: 1000,
      t: testT,
    });

    streamer.update({ thinkingMd: "🔎Searching web(5)", answerMd: "" });
    await flushPromises();
    expect(payloads).toHaveLength(1);
    const markdown = markdownOf(payloads[0]);
    expect(markdown).toContain("<details><summary>🧠 Thinking (1 steps)</summary>");
    expect(markdown).toContain("🔎Searching web(5)");
    expect(markdown).not.toContain("<tg-thinking>");

    streamer.startKeepalive();
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(payloads).toHaveLength(2);

    streamer.stopKeepalive();
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(payloads).toHaveLength(2);

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
  if (key === "thinking-summary") return `🧠 Thinking (${params?.steps} steps)`;
  return key;
}
