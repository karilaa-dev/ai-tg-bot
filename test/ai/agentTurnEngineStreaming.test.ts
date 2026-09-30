import { emptyModelUsage, type AgentSessionEvent } from "../../src/ai/runtime.js";
import { describe, expect, it, vi } from "vitest";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import { type TurnInput } from "../../src/ai/types.js";
import { loadTestConfig } from "../../src/config.js";
import { deferred } from "../helpers/async.js";
import { OUTDATED_SANDBOX_TOOLS_MESSAGE, outdatedSandboxToolsReply } from "../../src/sandbox/toolPolicy.js";

describe("turn streaming", () => {
  it.each(["en", "ru"] as const)("delivers the recreation request when an old executor aborts a turn in %s", async lang => {
    const sent: string[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await runTurn({
      api: { raw: {
        sendRichMessageDraft: async () => true,
        sendRichMessage: async (payload: { rich_message: { markdown: string } }) => {
          sent.push(payload.rich_message.markdown);
          return { message_id: sent.length };
        },
      } },
      chatId: 123, config: loadTestConfig(), logger,
      repos: { messages: {
        insert: async () => ({ id: 99 }), setDeliveryContent: async () => undefined, setThinking: async () => undefined,
      }, files: { listForMessage: async () => [] } },
      user: { tg_id: 1, stream_mode: true, lang }, thread: { id: 2, title: "Old thread" },
      text: "Create a file", t: (key: string) => key,
      pi: { runtime: async () => { throw new Error(`Remote executor unavailable: ${OUTDATED_SANDBOX_TOOLS_MESSAGE}`); } },
    } as unknown as TurnInput);
    expect(sent).toEqual([outdatedSandboxToolsReply(lang)]);
    expect(sent.join("\n")).not.toContain("error-generic");
  });

  it("keeps working after provisional text and subsequent tool calls", async () => {
    const prompt = deferred<void>();
    let emit: ((event: AgentSessionEvent) => void) | undefined;
    const drafts: string[] = [];
    const sent: string[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const execution = runTurn({
      api: { raw: {
        sendRichMessageDraft: async (payload: { rich_message: { markdown: string } }) => {
          drafts.push(payload.rich_message.markdown);
          return true;
        },
        sendRichMessage: async (payload: { rich_message: { markdown: string } }) => {
          sent.push(payload.rich_message.markdown);
          return { message_id: sent.length };
        },
        editMessageText: async () => true,
      } },
      chatId: 123,
      config: loadTestConfig(),
      repos: {
        messages: {
          insert: async () => ({ id: 99 }),
          setDeliveryContent: async () => undefined,
          setThinking: async () => undefined,
        },
        files: { listForMessage: async () => [] },
      },
      logger,
      user: { tg_id: 1, stream_mode: true, lang: "en" },
      thread: { id: 2, title: "Adapter" },
      text: "Create an adapter",
      t: (key: string, params?: Record<string, string | number>) => {
        if (key === "thinking-summary-running") return `Thinking for ${params?.time}`;
        if (key === "thinking-summary-final") return `Thought for ${params?.time}`;
        return key;
      },
      pi: { runtime: async () => ({
        bridge: {
          beginTurn: async () => undefined,
          endTurn: async () => undefined,
          attachments: [], publishedWebsites: [],
          outgoingFiles: { verifyOfficeAttachments: async () => undefined, unresolved: [] },
          currentTurnBudget: () => undefined,
        },
        session: {
          sessionManager: { getEntries: () => [] },
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
          subscribe: (listener: typeof emit) => { emit = listener; return () => undefined; },
          prompt: () => prompt.promise,
        },
      }) },
    } as unknown as TurnInput);

    try {
      await vi.waitFor(() => expect(emit).toBeDefined());
      const update = (type: string, delta: string) => emit!({
        type: "message_update",
        assistantMessageEvent: { type, delta, contentIndex: 0, partial: { content: [{ type: "text", text: delta }] } },
      } as AgentSessionEvent);
      update("thinking_delta", "**Refining the wall offset**");
      update("text_delta", "I'll use 3");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect([...sent]).toEqual([]);
      expect(drafts.at(-1)).toContain("Thinking for");
      expect(drafts.at(-1)).toContain("I'll use 3");
      expect(drafts.at(-1)?.trim()).toMatch(/<\/details>$/);

      emit!({ type: "tool_execution_start", toolCallId: "build", toolName: "bash", args: { command: "build" } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drafts.at(-1)).toContain("Running bash");
      expect(drafts.at(-1)).toContain("Thinking for");
      expect(drafts.at(-1)).not.toContain("I'll use 3");
      expect(sent).toEqual([]);
      emit!({
        type: "tool_execution_end", toolCallId: "build", toolName: "bash",
        result: { content: [{ type: "text", text: "Build complete" }], details: { durationMs: 300, exitCode: 0, aggregatedOutput: "private command output" } }, isError: false,
      });
      update("text_delta", "Created and validated the STL.");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect([...sent]).toEqual([]);
      expect(drafts.at(-1)).toContain("Thinking for");
      expect(drafts.at(-1)).toContain("Created and validated the STL.");
      emit!({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "Created and validated the STL." }],
        provider: "openai-codex", model: "gpt-6.1-sol", usage: emptyModelUsage(), stopReason: "stop", timestamp: Date.now(),
      } });
    } finally {
      prompt.resolve();
      await execution;
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(sent[0]).toContain("Thought for");
    expect(sent.at(-1)).toBe("Created and validated the STL.");
    // The final answer goes directly to confirmed delivery. A separate answer
    // draft here adds a serial Telegram request after inference has finished.
    expect(drafts).not.toContain("Created and validated the STL.");
    expect(logger.info).toHaveBeenCalledWith("Agent tool call finished", expect.objectContaining({
      latencyMs: 300, notificationSpanMs: expect.any(Number), exitCode: 0,
    }));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private command output");
    expect(logger.info).toHaveBeenCalledWith("Agent response cycle complete", expect.objectContaining({ timingBasis: "response_completion_intervals" }));
    const completed = logger.info.mock.calls.find(call => call[0] === "turn complete")?.[1];
    expect(completed).toMatchObject({ firstModelTextMs: expect.any(Number), firstDraftMs: expect.any(Number), responseCycleMs: expect.any(Number) });
    expect(completed).not.toHaveProperty("modelMs");
  });
});
