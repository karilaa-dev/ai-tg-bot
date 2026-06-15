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
    await vi.runOnlyPendingTimersAsync();
    expect(payloads).toHaveLength(1);
    const markdown = ((payloads[0] as Record<string, Record<string, string>>).rich_message).markdown ?? "";
    expect(markdown).toContain("<details><summary>🧠 Thinking (1 steps)</summary>");
    expect(markdown).toContain("🔎Searching web(5)");
    expect(markdown).not.toContain("<tg-thinking>");

    streamer.startKeepalive();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(payloads).toHaveLength(2);

    streamer.stopKeepalive();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(payloads).toHaveLength(2);

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
    await vi.runOnlyPendingTimersAsync();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.message_thread_id).toBe(42);
    expect(payloads[1]?.message_thread_id).toBeUndefined();
    expect(JSON.stringify(payloads[1]?.rich_message)).toContain("Topic 42");

    streamer.update({ thinkingMd: "thinking", answerMd: "answer two" });
    await vi.runOnlyPendingTimersAsync();
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

function testT(key: string, params?: Record<string, string | number>): string {
  if (key === "thinking-summary") return `🧠 Thinking (${params?.steps} steps)`;
  return key;
}
