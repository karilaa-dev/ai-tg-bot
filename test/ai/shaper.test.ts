import { describe, expect, it } from "vitest";
import { handleStreamPart, normalizeStreamPart } from "../../src/ai/run.js";
import { StreamShaper } from "../../src/ai/shaper.js";

describe("StreamShaper", () => {
  it("keeps short final answers intact", () => {
    const s = new StreamShaper();
    s.onTextDelta("One sentence.");
    expect(s.visibleAnswer()).toBe("One sentence.");
    expect(s.finalAnswer()).toBe("One sentence.");
    expect(s.thinkingMd()).toBe("");
  });

  it("streams visible answer as raw partial text", () => {
    const s = new StreamShaper();
    s.onTextDelta("One. Two. Three. Four");
    expect(s.visibleAnswer()).toBe("One. Two. Three. Four");
    expect(s.finalAnswer()).toBe("One. Two. Three. Four");
  });

  it("demotes all text before a tool call", () => {
    const s = new StreamShaper();
    s.onTextDelta("One. Two. Three. Four. Five.");
    expect(s.visibleAnswer()).toBe("One. Two. Three. Four. Five.");
    s.onToolCall("search_thread", { query: "alpha" });
    expect(s.visibleAnswer()).toBe("");
    expect(s.thinkingMd()).toContain("> One. Two. Three. Four. Five.");
    expect(s.thinkingMd()).toContain("💬 Searching chat <code>alpha</code>");
  });

  it("reports stream event kinds used by the draft keepalive loop", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "text-delta", text: "One." })).toBe("content");
    expect(handleStreamPart(s, { type: "tool-call", toolName: "web_search", input: { query: "x" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "web_search", output: { results: [{}, {}, {}, {}, {}] } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🔎 Searching web <code>x</code> (5 results)");
    expect(s.thinkingMd()).not.toContain("↳");
    expect(s.thinkingMd()).not.toContain("5 websites");
    expect(s.thinkingMd()).not.toContain("web_search");
  });

  it("updates repeated tool calls for the same subject without x-count suffixes", () => {
    const s = new StreamShaper();
    s.onToolCall("web_search", { query: "alpha" });
    s.onToolResult("web_search", "5 results");
    s.onToolCall("web_search", { query: "alpha" });
    expect(s.toolStatusMd()).toBe("🔎 Searching web <code>alpha</code>");
    s.onToolResult("web_search", "2 results");
    expect(s.toolStatusMd()).toBe("🔎 Searching web <code>alpha</code> (2 results)");
    expect(s.thinkingMd()).toBe("🔎 Searching web <code>alpha</code> (2 results)");
    expect(s.thinkingMd()).not.toContain("x2");
  });

  it("keeps separate status lines for different tool subjects", () => {
    const s = new StreamShaper();
    s.onToolCall("web_search", { query: "alpha" });
    s.onToolResult("web_search", "5 results");
    s.onToolCall("web_search", { query: "beta" });
    s.onToolResult("web_search", "2 results");

    expect(s.toolStatusMd()).toBe([
      "🔎 Searching web <code>alpha</code> (5 results)",
      "🔎 Searching web <code>beta</code> (2 results)",
    ].join("\n"));
  });

  it("uses friendly labels for all known tools", () => {
    const s = new StreamShaper();
    s.onToolCall("web_search", { query: "current info" });
    s.onToolCall("web_extract", { urls: ["https://example.com/article"] });
    s.onToolCall("search_thread", { query: "chat detail" });
    s.onToolCall("load_message", { message_id: 42 });
    s.onToolCall("search_in_file", { file_id: 7 }, { fileName: "book.pdf" });
    s.onToolCall("read_file_section", { file_id: 7 }, { fileName: "book.pdf" });
    const status = s.toolStatusMd();

    expect(status).toContain("🔎 Searching web <code>current info</code>");
    expect(status).toContain("🌐 Reading page <code>https://example.com/article</code>");
    expect(status).toContain("💬 Searching chat <code>chat detail</code>");
    expect(status).toContain("📨 Loading message <code>#42</code>");
    expect(status).toContain("📄 Searching file <code>book.pdf</code>");
    expect(status).toContain("📖 Reading file <code>book.pdf</code>");
    expect(status).not.toContain("web_search");
    expect(status).not.toContain("web_extract");
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
