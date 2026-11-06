import { fixtureUuid } from "./uuid.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import { type TurnInput } from "../../src/ai/types.js";
import { loadTestConfig } from "../../src/config.js";
import { deferred } from "../helpers/async.js";
import { DraftStreamer } from "../../src/telegram/draftStreamer.js";

describe("turn streaming", () => {
  it("honors Stop for the thinking draft while its final summary is being sent", async () => {
    const controller = new AbortController();
    const summaryStarted = deferred<void>();
    const releaseSummary = deferred<void>();
    let emit: ((event: AgentSessionEvent) => void) | undefined;
    let draftId: number | undefined;
    const sent: string[] = [];
    const api = { raw: {
      sendRichMessageDraft: async (payload: { draft_id: number }) => { draftId ??= payload.draft_id; return true; },
      sendRichMessage: async (payload: { rich_message: { markdown: string } }) => {
        sent.push(payload.rich_message.markdown);
        summaryStarted.resolve();
        await releaseSummary.promise;
        return { message_id: 1 };
      },
    } };
    const execution = runTurn({
      api, chatId: 1, config: loadTestConfig(),
      repos: { messages: { insert: async () => ({ id: 1 }) }, files: { listForMessage: async () => [] } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      user: { tg_id: 1, stream_mode: true, lang: "en" }, thread: { id: fixtureUuid(1), title: "Test" },
      text: "work", t: (key: string) => key, signal: controller.signal,
      onCancel: async () => { controller.abort(); return true; },
      pi: { runtime: async () => ({
        bridge: { beginTurn: async () => undefined, endTurn: async () => undefined,
          currentTurnBudget: () => undefined,
          attachments: [], publishedWebsites: [], outgoingFiles: { verifyOfficeAttachments: async () => undefined, unresolved: [] } },
        session: {
          sessionManager: { getEntries: () => [] },
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
          subscribe: (listener: typeof emit) => { emit = listener; return () => undefined; },
          prompt: async () => {
            for (const [type, delta] of [["thinking_delta", "Preparing the answer"], ["text_delta", "Completed answer"]]) {
              emit?.({ type: "message_update", assistantMessageEvent: {
                type, delta, contentIndex: 0, partial: { content: [] },
              } } as unknown as AgentSessionEvent);
            }
          },
        },
      }) },
    } as unknown as TurnInput);
    try {
      await summaryStarted.promise;
      expect(draftId).toBeDefined();
      expect(await DraftStreamer.stopGeneration(api, {
        chat: { id: 1, type: "private", first_name: "Test" }, draft_id: draftId!,
      })).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    } finally { controller.abort(); releaseSummary.resolve(); await execution; }
    expect(sent).toHaveLength(1);
    expect(sent).not.toContain("Completed answer");
    expect(await DraftStreamer.stopGeneration(api, {
      chat: { id: 1, type: "private", first_name: "Test" }, draft_id: draftId!,
    })).toBe(false);
  });

  it("stops drafts immediately while the cancelled model is still settling", async () => {
    const controller = new AbortController();
    const prompt = deferred<void>();
    const abort = vi.fn(async () => undefined);
    const sendRichMessageDraft = vi.fn(async (_payload: unknown) => true);
    const sendRichMessage = vi.fn(async () => ({ message_id: 1 }));
    const api = { raw: { sendRichMessageDraft, sendRichMessage } };
    const onCancel = vi.fn(async () => { controller.abort(); return true; });
    const execution = runTurn({
      api, chatId: 1, config: loadTestConfig({ DRAFT_UPDATE_MS: 60_000 }),
      repos: { messages: { insert: async () => ({ id: 1 }) }, files: { listForMessage: async () => [] } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      user: { tg_id: 1, stream_mode: true, lang: "en" },
      thread: { id: fixtureUuid(1), title: "Test" }, text: "work", t: (key: string) => key,
      signal: controller.signal, onCancel,
      pi: { runtime: async () => ({
        bridge: { beginTurn: async () => undefined, endTurn: async () => undefined },
        session: {
          sessionManager: { getEntries: () => [] },
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
          subscribe: () => () => undefined, prompt: () => prompt.promise, abort,
        },
      }) },
    } as unknown as TurnInput);
    try {
      await vi.waitFor(() => expect(sendRichMessageDraft).toHaveBeenCalledOnce());
      const payload = sendRichMessageDraft.mock.calls[0]![0] as { draft_id: number; can_stop: boolean };
      expect(payload.can_stop).toBe(true);
      expect(await DraftStreamer.stopGeneration(api, {
        chat: { id: 1, type: "private", first_name: "Test" }, draft_id: payload.draft_id,
      })).toBe(true);
      expect(onCancel).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
      expect(sendRichMessage).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      prompt.resolve();
      await execution;
    }
    expect(sendRichMessageDraft).toHaveBeenCalledOnce();
    expect(sendRichMessage).not.toHaveBeenCalled();
  });

  it("keeps working after provisional text and subsequent tool calls", async () => {
    const prompt = deferred<void>();
    const releaseStarted = deferred<void>();
    const releaseCommandActivity = deferred<void>();
    const onDeliveryConfirmed = vi.fn(async () => undefined);
    const onDraft = vi.fn();
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
      thread: { id: fixtureUuid(2), title: "Adapter" },
      text: "Create an adapter",
      onDeliveryConfirmed,
      onDraft,
      t: (key: string, params?: Record<string, string | number>) => {
        if (key === "thinking-summary-running") return `Thinking for ${params?.time}`;
        if (key === "thinking-summary-final") return `Thought for ${params?.time}`;
        return key;
      },
      pi: { runtime: async () => ({
        bridge: {
          beginTurn: async () => undefined,
          endTurn: async () => undefined,
          releaseCommandActivity: async () => { releaseStarted.resolve(); await releaseCommandActivity.promise; },
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
      expect(onDraft.mock.calls.at(-1)?.[0]?.toolActivity.calls[0]).toMatchObject({ name: "bash", status: "running" });
      emit!({ type: "tool_execution_update", toolCallId: "build", toolName: "bash", args: { command: "build" },
        partialResult: { content: [{ type: "text", text: "Partial precise result: 123.4500" }] } });
      expect(onDraft.mock.calls.at(-1)?.[0]?.toolActivity.calls[0]).toMatchObject({ status: "running", result: { text: "Partial precise result: 123.4500" } });
      emit!({
        type: "tool_execution_end", toolCallId: "build", toolName: "bash",
        result: { content: [{ type: "text", text: "Build complete" }], details: {} }, isError: false,
      });
      const openui = 'root = Stack([Text("Private DSL")])';
      update("toolcall_delta", JSON.stringify({ openui }));
      emit!({ type: "tool_execution_start", toolCallId: "finish", toolName: "finish_response", args: { text: "Fallback", openui } });
      emit!({
        type: "tool_execution_end", toolCallId: "finish", toolName: "finish_response",
        result: { content: [{ type: "text", text: JSON.stringify({ openui }) }], details: { completed: true, text: "Fallback", openui } }, isError: false,
      });
      update("text_delta", "Created and validated the STL.");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect([...sent]).toEqual([]);
      expect(drafts.at(-1)).toContain("Thinking for");
      expect(drafts.at(-1)).toContain("Created and validated the STL.");
      expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Created and validated the STL.", thinking: expect.any(String),
        toolActivity: expect.objectContaining({ calls: [expect.objectContaining({ name: "bash", status: "succeeded" })] }) }));
      expect(JSON.stringify(onDraft.mock.calls)).not.toContain("Private DSL");
      expect(JSON.stringify(drafts)).not.toContain("Private DSL");
    } finally {
      prompt.resolve();
      await releaseStarted.promise;
      expect(onDeliveryConfirmed).not.toHaveBeenCalled();
      releaseCommandActivity.resolve();
      await execution;
    }
    expect(onDeliveryConfirmed).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(sent[0]).toContain("Thought for");
    expect(sent.at(-1)).toBe("Created and validated the STL.");
    expect(JSON.stringify(sent)).not.toContain("Private DSL");
  });
});
