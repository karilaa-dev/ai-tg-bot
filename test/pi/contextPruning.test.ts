import { buildSessionProjection, SessionManager, type InlineExtension, type SessionMessageEntry, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createContextPruningExtension, pruneOldToolResults } from "../../src/pi/contextPruning.js";
import { inferenceUsageFromEntries } from "../../src/pi/usage.js";

describe("Pi context pruning", () => {
  it("shortens old successful results while retaining sources, artifacts and validation", () => {
    const manager = SessionManager.inMemory();
    const sourceUrl = "https://example.com/important-source";
    const oldText = `${"head ".repeat(1800)}${sourceUrl}${" tail".repeat(1800)}`;
    const research = appendResult(manager, { toolName: "web_extract", content: [{ type: "text", text: oldText }], details: { results: [{ url: sourceUrl }] } });
    const vision = appendResult(manager, { toolName: "inspect_workspace_images", content: [
      { type: "text", text: "final_png=/model.final.png\nstl=/model.stl" },
      { type: "image", data: "large-image-data", mimeType: "image/png" },
    ], details: { path: "/model.final.png" } });
    const failure = appendResult(manager, { isError: true, content: [{ type: "text", text: oldText }] });
    const validation = appendResult(manager, { toolName: "validate_office_file", content: [{ type: "text", text: oldText }], details: { status: "passed", path: "/final.pptx" } });
    const terminal = appendResult(manager, { toolName: "finish_response", content: [{ type: "text", text: oldText }] });
    const memory = appendResult(manager, { toolName: "memo", content: [{ type: "text", text: oldText }] });
    const small = appendResult(manager, { content: [{ type: "text", text: "Still useful small result" }] });
    const recent = Array.from({ length: 6 }, () => appendResult(manager, { content: [{ type: "image", data: "recent-image", mimeType: "image/png" }] }));
    const originals = structuredClone(manager.getEntries());
    const usage = inferenceUsageFromEntries(originals);
    const originalLeaf = manager.getLeafId()!;

    const edits = pruneOldToolResults(buildSessionProjection(manager.getBranch()).entries);
    expect(edits.map((edit) => edit.targetId)).toEqual([research, vision]);
    for (const edit of edits) manager.appendContextEdit(edit.targetId, edit.replacement);
    const projected = buildSessionProjection(manager.getBranch()).entries;
    const text = projected.find((entry) => entry.sourceEntry.id === research)!.messages[0]!;
    expect(JSON.stringify(text)).toContain(sourceUrl);
    expect(JSON.stringify(text).length).toBeLessThan(oldText.length / 2);
    const inspected = projected.find((entry) => entry.sourceEntry.id === vision)!.messages[0]!;
    expect(JSON.stringify(inspected)).toContain("/model.final.png");
    expect(JSON.stringify(inspected)).toContain("/model.stl");
    if (inspected.role !== "toolResult") throw new Error("Expected tool result");
    expect(inspected.content.every((part) => part.type === "text")).toBe(true);
    for (const id of [failure, validation, terminal, memory, small, ...recent]) {
      expect(projected.find((entry) => entry.sourceEntry.id === id)!.messages[0])
        .toEqual(originals.find((entry): entry is SessionMessageEntry => entry.id === id && entry.type === "message")!.message);
    }
    expect(manager.getEntries().slice(0, originals.length)).toEqual(originals);
    expect(inferenceUsageFromEntries(manager.getEntries())).toEqual(usage);
    expect(pruneOldToolResults(projected)).toEqual([]);

    manager.branch(originalLeaf);
    expect(buildSessionProjection(manager.getBranch()).entries.find((entry) => entry.sourceEntry.id === vision)!.messages[0])
      .toEqual(originals.find((entry): entry is SessionMessageEntry => entry.id === vision && entry.type === "message")!.message);
  });

  it("keeps structured failures even when an older tool did not set isError", () => {
    const manager = SessionManager.inMemory();
    appendResult(manager, { content: [{ type: "text", text: "failure".repeat(1200) }], details: { exit_code: 7 } });
    for (let index = 0; index < 6; index++) appendResult(manager, {});
    expect(pruneOldToolResults(buildSessionProjection(manager.getBranch()).entries)).toEqual([]);
  });

  it("keeps partially failed research and scripts with failed or incomplete nested calls", () => {
    const manager = SessionManager.inMemory();
    const content = [{ type: "text" as const, text: "research output ".repeat(600) }];
    appendResult(manager, { content, toolName: "web_extract", details: { failed_results: [{ url: "https://example.com/missing", error: "not found" }] } });
    appendResult(manager, { content, toolName: "codemode", nestedCalls: { complete: true, calls: [{ id: "nested-1", name: "web_search", status: "error", error: "failed" }] } });
    appendResult(manager, { content, toolName: "codemode", nestedCalls: { complete: false, calls: [] } });
    for (let index = 0; index < 6; index++) appendResult(manager, {});

    expect(pruneOldToolResults(buildSessionProjection(manager.getBranch()).entries)).toEqual([]);
  });

  it("appends edits at the turn boundary without requesting another inference cycle", async () => {
    const manager = SessionManager.inMemory();
    appendResult(manager, { content: [{ type: "image", data: "old", mimeType: "image/png" }] });
    for (let index = 0; index < 6; index++) appendResult(manager, {});
    let handler!: (event: TurnEndEvent) => unknown;
    const extension = createContextPruningExtension() as Exclude<InlineExtension, Function>;
    await extension.factory({ on: (name: string, fn: typeof handler) => { if (name === "turn_end") handler = fn; } } as never);
    const previous = { type: "custom" as const, customType: "other-extension", data: {} };
    const event = { outcome: "completed", entries: [previous], context: { contextEntries: buildSessionProjection(manager.getBranch()).entries } } as TurnEndEvent;

    expect(handler(event)).toMatchObject({ entries: [previous, { type: "context_edit" }] });
    expect(handler(event)).not.toHaveProperty("continue");
    expect(handler({ ...event, outcome: "aborted" })).toBeUndefined();
  });
});

function appendResult(manager: SessionManager, overrides: Partial<ToolResultMessage>): string {
  const toolName = overrides.toolName ?? "web_search";
  const toolCallId = `call-${manager.getEntries().length}`;
  manager.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
    api: "openai-completions", provider: "openrouter", model: "openai/gpt-6.1-sol", stopReason: "toolUse", timestamp: 0,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } satisfies AssistantMessage);
  return manager.appendMessage({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "result" }], isError: false, timestamp: 0, ...overrides });
}
