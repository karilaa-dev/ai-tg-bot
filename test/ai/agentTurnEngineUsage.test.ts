import { expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import type { TurnInput } from "../../src/ai/types.js";
import { loadTestConfig } from "../../src/config.js";
import { recordInferenceUsage, type UsageSource } from "../../src/pi/usage.js";

it("saves usage from dropped attempts without double-counting the persisted reply on cancellation", async () => {
  const entries: SessionEntry[] = [];
  const onInferenceUsage = vi.fn(async () => undefined);
  const source = (cacheRead: number): UsageSource => ({ provider: "openai-codex", model: "test",
    usage: { input: 100, output: 20, cacheRead, cacheWrite: 40, totalTokens: 160 + cacheRead,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await runTurn({
    api: { raw: { sendRichMessage: async () => ({ message_id: 1 }), editMessageText: async () => true } },
    chatId: 1, config: loadTestConfig(),
    repos: { messages: { insert: async () => ({ id: 1 }) }, files: { listForMessage: async () => [] } },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    user: { tg_id: 1, stream_mode: false, lang: "en" }, thread: { id: 1 },
    text: "test", t: (key: string) => key, onInferenceUsage,
    pi: { runtime: async () => ({
      bridge: { beginTurn: async () => undefined, endTurn: async () => undefined,
        currentTurnBudget: () => undefined, attachments: [], publishedWebsites: [] },
      session: {
        sessionManager: { getEntries: () => entries },
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        subscribe: () => () => undefined,
        prompt: async () => {
          recordInferenceUsage(source(900), { fastMode: true, source: "compaction" });
          const message = { ...source(300), role: "assistant", content: [], stopReason: "aborted" };
          recordInferenceUsage(message, { fastMode: false, source: "chat" });
          entries.push({ id: "reply", type: "message", message } as unknown as SessionEntry);
        },
      },
    }) },
  } as unknown as TurnInput);
  expect(onInferenceUsage).toHaveBeenCalledOnce();
  expect(onInferenceUsage.mock.calls[0]).toEqual([expect.objectContaining({
    usage: expect.objectContaining({ cacheReadTokens: 1200, cacheWriteTokens: 80,
      calls: [expect.objectContaining({ fastMode: true }), expect.objectContaining({ fastMode: false })] }),
  })]);
});
