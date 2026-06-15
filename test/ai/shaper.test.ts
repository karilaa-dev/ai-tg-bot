import { describe, expect, it } from "vitest";
import { handleStreamPart, normalizeStreamPart } from "../../src/ai/run.js";
import { StreamShaper } from "../../src/ai/shaper.js";

describe("StreamShaper", () => {
  it("keeps short final answers intact", () => {
    const s = new StreamShaper();
    s.onTextDelta("One sentence.");
    expect(s.visibleAnswer()).toBe("");
    expect(s.finalAnswer()).toBe("One sentence.");
    expect(s.thinkingMd()).toBe("");
  });

  it("lags visible answer by exactly two completed sentences", () => {
    const s = new StreamShaper();
    s.onTextDelta("One. Two. Three. Four.");
    expect(s.visibleAnswer()).toBe("One. Two.");
    expect(s.finalAnswer()).toBe("One. Two. Three. Four.");
  });

  it("demotes all text before a tool call", () => {
    const s = new StreamShaper();
    s.onTextDelta("One. Two. Three. Four. Five.");
    expect(s.visibleAnswer()).toBe("One. Two. Three.");
    s.onToolCall("search_thread");
    expect(s.visibleAnswer()).toBe("");
    expect(s.thinkingMd()).toContain("> One. Two. Three. Four. Five.");
    expect(s.thinkingMd()).toContain("💬Searching chat");
  });

  it("reports stream event kinds used by the draft keepalive loop", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "text-delta", text: "One." })).toBe("content");
    expect(handleStreamPart(s, { type: "tool-call", toolName: "web_search", input: { query: "x" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "web_search", output: { results: [{}, {}, {}, {}, {}] } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🔎Searching web(5)");
    expect(s.thinkingMd()).not.toContain("↳");
    expect(s.thinkingMd()).not.toContain("5 websites");
    expect(s.thinkingMd()).not.toContain("web_search");
  });

  it("aggregates repeated tool calls for status messages", () => {
    const s = new StreamShaper();
    s.onToolCall("web_search");
    s.onToolResult("web_search", "5 websites");
    s.onToolCall("web_search");
    expect(s.toolStatusMd()).toBe("🔎Searching web x2(5)");
    s.onToolResult("web_search", "2 websites");
    expect(s.toolStatusMd()).toBe("🔎Searching web x2(2)");
    expect(s.thinkingMd()).toBe("🔎Searching web(5)\n\n🔎Searching web x2(2)");
  });

  it("uses friendly labels for all known tools", () => {
    const s = new StreamShaper();
    s.onToolCall("web_search");
    s.onToolCall("search_thread");
    s.onToolCall("load_message");
    s.onToolCall("search_in_file");
    s.onToolCall("read_file_section");
    const status = s.toolStatusMd();

    expect(status).toContain("🔎Searching web");
    expect(status).toContain("💬Searching chat");
    expect(status).toContain("📨Loading message");
    expect(status).toContain("📄Searching file");
    expect(status).toContain("📖Reading file");
    expect(status).not.toContain("web_search");
    expect(status).not.toContain("search_thread");
    expect(status).not.toContain("load_message");
    expect(status).not.toContain("search_in_file");
    expect(status).not.toContain("read_file_section");
  });

  it("normalizes installed AI SDK v6 fullStream tool part names", () => {
    expect(normalizeStreamPart({ type: "tool-input-available", toolName: "search_thread", input: { query: "x" } })).toEqual({
      kind: "tool-call",
      toolName: "search_thread",
      input: { query: "x" },
    });
    expect(normalizeStreamPart({ type: "tool-output-available", toolName: "search_thread", output: { results: [] } })).toEqual({
      kind: "tool-result",
      toolName: "search_thread",
      output: { results: [] },
    });
  });
});
