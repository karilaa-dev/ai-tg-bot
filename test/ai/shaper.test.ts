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

  it("uses completed agent messages as the final answer replacement", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "text-delta", text: "Partial answer" })).toBe("content");
    expect(s.visibleAnswer()).toBe("Partial answer");
    expect(handleStreamPart(s, { type: "text-final", text: "Complete final answer." })).toBe("content");
    expect(s.visibleAnswer()).toBe("Complete final answer.");
    expect(s.finalAnswer()).toBe("Complete final answer.");
  });

  it("demotes all text before a tool call", () => {
    const s = new StreamShaper();
    s.onTextDelta("One. Two. Three. Four. Five.");
    expect(s.visibleAnswer()).toBe("One. Two. Three. Four. Five.");
    s.onToolCall("search_thread", { query: "alpha" });
    expect(s.visibleAnswer()).toBe("");
    expect(s.thinkingMd()).not.toContain("One. Two. Three. Four. Five.");
    expect(s.thinkingMd()).toContain("💬 Searching chat <code>alpha</code>");
  });

  it("keeps demoted provisional text out of the completed final answer", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "text-delta", text: "I will check this first." })).toBe("content");
    expect(handleStreamPart(s, { type: "tool-call", toolName: "bash", input: { script: "printf ok" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "bash", output: { exit_code: 0, timed_out: false } })).toBe("tool-result");
    expect(handleStreamPart(s, { type: "text-final", text: "Final checked answer." })).toBe("content");
    expect(s.thinkingMd()).not.toContain("I will check this first.");
    expect(s.thinkingMd()).toContain("🐚 Running bash <code>printf ok</code> (exit 0)");
    expect(s.finalAnswer()).toBe("Final checked answer.");
  });

  it("reports stream event kinds used by draft updates", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "text-delta", text: "One." })).toBe("content");
    expect(handleStreamPart(s, { type: "tool-call", toolName: "web_search", input: { query: "x" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "web_search", output: { results: [{}, {}, {}, {}, {}] } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🔎 Searching web <code>x</code> (5 results)");
    expect(s.thinkingMd()).not.toContain("↳");
    expect(s.thinkingMd()).not.toContain("5 websites");
    expect(s.thinkingMd()).not.toContain("web_search");
  });

  it("compacts reasoning to block titles while preserving tool summaries", () => {
    const s = new StreamShaper();
    s.onReasoningDelta([
      "Comparing runtimes effectively",
      "For comparing runtimes, I will inspect the available data.",
    ].join("\n"));
    s.onReasoningDelta([
      "",
      "",
      "Creating files and verification",
      "I need to create output files and verify them.",
    ].join("\n"));
    s.onTextDelta("I will check this first.");
    s.onToolCall("web_search", { query: "alpha" });
    s.onToolResult("web_search", "5 results");

    expect(s.compactThinkingMd()).toBe([
      "Comparing runtimes effectively",
      "Creating files and verification",
      "",
      "🔎 Searching web <code>alpha</code> (5 results)",
    ].join("\n"));
    expect(s.thinkingMd()).toBe(s.compactThinkingMd());
    expect(s.compactThinkingMd()).not.toContain("inspect the available data");
    expect(s.compactThinkingMd()).not.toContain("I will check this first");
    expect(s.compactThinkingMd()).not.toContain("web_search");
    expect(s.streamingThinkingMd()).toContain("For comparing runtimes, I will inspect the available data.");
    expect(s.streamingThinkingMd()).toContain("I need to create output files and verify them.");
    expect(s.streamingThinkingMd()).toContain("🔎 Searching web <code>alpha</code> (5 results)");
    expect(s.streamingThinkingMd()).not.toContain("I will check this first");
    expect(s.runSummary()).toEqual({
      reasoningTitles: ["Comparing runtimes effectively", "Creating files and verification"],
      toolCallCount: 1,
      toolCounts: [{ label: "🔎 Searching web", count: 1 }],
    });
  });

  it("keeps only streamed section titles from verbose reasoning text", () => {
    const s = new StreamShaper();
    s.onReasoningDelta([
      "Evaluating technical options",
      "I need to figure out the best way to perform an explicit internet search.",
      "",
      "Planning file creation for Pi calculation",
      "Since I am responding within Telegram, I will use the available tools.",
    ].join("\n"));
    s.onReasoningDelta([
      "",
      "",
      "Considering pi verification process",
      "I need to use a combined bash command to create source files.",
    ].join("\n"));
    s.onReasoningDelta([
      "",
      "",
      "Evaluating pi digit sources",
      "For an exact machine comparison, I should fetch a reliable reference.",
    ].join("\n"));

    expect(s.compactThinkingMd()).toBe([
      "Evaluating technical options",
      "Considering pi verification process",
      "Evaluating pi digit sources",
    ].join("\n"));
    expect(s.compactThinkingMd()).not.toContain("explicit internet search");
    expect(s.compactThinkingMd()).not.toContain("Planning file creation");
    expect(s.compactThinkingMd()).not.toContain("combined bash command");
    expect(s.compactThinkingMd()).not.toContain("reliable reference");
    expect(s.streamingThinkingMd()).toContain("explicit internet search");
    expect(s.streamingThinkingMd()).toContain("Planning file creation");
    expect(s.streamingThinkingMd()).toContain("combined bash command");
    expect(s.streamingThinkingMd()).toContain("reliable reference");
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
    expect(s.runSummary()).toEqual({
      reasoningTitles: [],
      toolCallCount: 2,
      toolCounts: [{ label: "🔎 Searching web", count: 2 }],
    });
  });

  it("registers a tool result arriving with no prior tool call", () => {
    const s = new StreamShaper();
    s.onToolResult("web_search", "5 results");
    expect(s.toolStatusMd()).toBe("🔎 Searching web (5 results)");
    expect(s.thinkingMd()).toBe("🔎 Searching web (5 results)");
    expect(s.runSummary()).toEqual({
      reasoningTitles: [],
      toolCallCount: 0,
      toolCounts: [],
    });
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
    s.onToolCall("generate_image", { prompt: "small red square", reference_file_ids: [9] });
    s.onToolCall("create_file", { path: "/report.txt", name: "report.txt" });
    s.onToolCall("bash", { script: "printf hello" });
    const status = s.toolStatusMd();

    expect(status).toContain("🔎 Searching web <code>current info</code>");
    expect(status).toContain("🌐 Reading page <code>https://example.com/article</code>");
    expect(status).toContain("💬 Searching chat <code>chat detail</code>");
    expect(status).toContain("📨 Loading message <code>#42</code>");
    expect(status).toContain("📄 Searching file <code>book.pdf</code>");
    expect(status).toContain("📖 Reading file <code>book.pdf</code>");
    expect(status).toContain("🖼️ Generating image <code>small red square +1 ref</code>");
    expect(status).toContain("📎 Creating file <code>report.txt</code>");
    expect(status).toContain("🐚 Running bash <code>printf hello</code>");
    expect(status).not.toContain("web_search");
    expect(status).not.toContain("web_extract");
    expect(status).not.toContain("search_thread");
    expect(status).not.toContain("load_message");
    expect(status).not.toContain("search_in_file");
    expect(status).not.toContain("read_file_section");
    expect(status).not.toContain("generate_image");
    expect(status).not.toContain("create_file");
  });

  it("summarizes created file outputs as files", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "tool-call", toolName: "create_file", input: { path: "/report.txt" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "create_file", output: { file_id: 12, name: "report.txt" } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("📎 Creating file <code>/report.txt</code> (1 file)");
  });

  it("summarizes generated image outputs as images", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "tool-call", toolName: "generate_image", input: { prompt: "red square" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "generate_image", output: { file_id: 12, name: "generated-image.png" } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🖼️ Generating image <code>red square</code> (1 image)");
    expect(s.runSummary()).toEqual({
      reasoningTitles: [],
      toolCallCount: 1,
      toolCounts: [{ label: "🖼️ Generating image", count: 1 }],
    });
  });

  it("summarizes bash results with exit status and timeout", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "tool-call", toolName: "bash", input: { script: "printf hello" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "bash", output: { stdout: "hello", exit_code: 0, timed_out: false } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🐚 Running bash <code>printf hello</code> (exit 0)");

    expect(handleStreamPart(s, { type: "tool-call", toolName: "bash", input: { script: "while true; do sleep 1; done" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "bash", output: { exit_code: null, timed_out: true } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🐚 Running bash <code>while true; do sleep 1; done</code> (timed out)");
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
    expect(normalizeStreamPart({ type: "text-final", text: "done" })).toEqual({
      kind: "text-final",
      text: "done",
    });
  });
});
