import { describe, expect, it } from "vitest";
import { handleStreamPart, normalizeStreamPart, toolErrorText } from "../../src/ai/agentTurnEngine.js";
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

  it("keeps full run summaries while preserving the compact title view", () => {
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
    s.onReasoningDelta("\n\n<!-- -->");
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
      reasoningSummaries: [
        "Comparing runtimes effectively\nFor comparing runtimes, I will inspect the available data.",
        "Creating files and verification\nI need to create output files and verify them.",
      ],
      toolCallCount: 1,
      toolCounts: [{ label: "🔎 Searching web", count: 1 }],
    });
  });

  it("normalizes streamed reasoning comment separators before rendering and persistence", () => {
    const s = new StreamShaper();
    s.onReasoningDelta("**Planning file reading**<!");
    expect(s.streamingThinkingMd()).toBe("**Planning file reading**");

    s.onReasoningDelta("-- -->**Searching the chapter**<!-- -->**Summarizing results**");

    const expected = [
      "**Planning file reading**",
      "**Searching the chapter**",
      "**Summarizing results**",
    ].join("\n\n");
    expect(s.streamingThinkingMd()).toBe(expected);
    expect(s.streamingThinkingMd()).not.toContain("<!--");
    expect(s.runSummary()).toEqual({
      reasoningSummaries: [expected],
      toolCallCount: 0,
      toolCounts: [],
    });
  });

  it("keeps consecutive protocol reasoning blocks separate without an intervening tool call", () => {
    const s = new StreamShaper();
    s.onReasoningStart();
    s.onReasoningDelta("**Planning image ");
    s.onReasoningDelta("sourcing**");
    s.onReasoningEnd();
    s.onReasoningStart();
    s.onReasoningDelta("**Evaluating image placement and slide restructuring**");
    s.onReasoningEnd();

    expect(s.streamingThinkingMd()).toBe([
      "**Planning image sourcing**",
      "**Evaluating image placement and slide restructuring**",
    ].join("\n\n"));
    expect(s.streamingThinkingMd()).not.toContain("****");
    expect(s.runSummary()).toEqual({
      reasoningSummaries: [
        "**Planning image sourcing**",
        "**Evaluating image placement and slide restructuring**",
      ],
      toolCallCount: 0,
      toolCounts: [],
    });
  });

  it("separates provider-concatenated titled reasoning sections", () => {
    const s = new StreamShaper();
    s.onReasoningStart();
    s.onReasoningDelta([
      "**Planning the deck**",
      "",
      "I will use a simple visual system.**Designing the slides**",
      "",
      "I will create the layouts next.",
    ].join("\n"));
    s.onReasoningEnd();

    expect(s.streamingThinkingMd()).toBe([
      "**Planning the deck**",
      "",
      "I will use a simple visual system.",
      "",
      "**Designing the slides**",
      "",
      "I will create the layouts next.",
    ].join("\n"));
    expect(s.runSummary().reasoningSummaries).toEqual([s.streamingThinkingMd()]);
  });

  it("keeps ordinary end-of-line bold text inline", () => {
    const s = new StreamShaper();
    s.onReasoningStart();
    s.onReasoningDelta("The answer is **yes**");
    s.onReasoningEnd();

    expect(s.streamingThinkingMd()).toBe("The answer is **yes**");
    expect(s.runSummary().reasoningSummaries).toEqual(["The answer is **yes**"]);
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
      reasoningSummaries: [],
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
      reasoningSummaries: [],
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
    s.onToolCall("browser_open", { url: "https://example.com" });
    s.onToolCall("browser_snapshot", { tab_id: "tab-1" });
    s.onToolCall("browser_close_session", {});
    s.onToolCall("render_office_preview", { path: "/deck.pptx", page: 1 });
    s.onToolCall("inspect_workspace_images", { paths: ["/collage.jpg", "/detail.png"] });
    const status = s.toolStatusMd();

    expect(status).toContain("🔎 Searching web <code>current info</code>");
    expect(status).toContain("🌐 Reading page <code>https://example.com/article</code>");
    expect(status).toContain("💬 Searching chat <code>chat detail</code>");
    expect(status).toContain("📨 Loading message <code>#42</code>");
    expect(status).toContain("📄 Searching file <code>book.pdf</code>");
    expect(status).toContain("📖 Reading file <code>book.pdf</code>");
    expect(status).toContain("🖼️ Generating image <code>small red square +1 ref</code>");
    expect(status).toContain("📎 Attaching file <code>report.txt</code>");
    expect(status).toContain("🐚 Running bash <code>printf hello</code>");
    expect(status).toContain("🌍 Browsing web <code>https://example.com</code>");
    expect(status).toContain("🧭 Reading browser <code>tab-1</code>");
    expect(status).toContain("🧹 Closing browser session");
    expect(status).toContain("🖼️ Previewing Office file <code>/deck.pptx</code>");
    expect(status).toContain("👁️ Inspecting images <code>/collage.jpg +1</code>");
    expect(status).not.toContain("web_search");
    expect(status).not.toContain("web_extract");
    expect(status).not.toContain("search_thread");
    expect(status).not.toContain("load_message");
    expect(status).not.toContain("search_in_file");
    expect(status).not.toContain("read_file_section");
    expect(status).not.toContain("generate_image");
    expect(status).not.toContain("create_file");
  });

  it("names loaded skills in live status, final thinking, and tool counts", () => {
    const s = new StreamShaper();
    s.onToolCall("read", { path: "/app/skills/pptxgenjs/SKILL.md" });
    expect(s.toolStatusMd()).toBe("📚 Loading skill <code>pptxgenjs</code>");
    s.onToolResult("read", "loaded");
    s.onToolCall("read", { path: "skills/xlsx/SKILL.md" });
    expect(s.thinkingMd()).toContain("📚 Loading skill <code>pptxgenjs</code> (loaded)");
    expect(s.streamingThinkingMd()).toContain("📚 Loading skill <code>xlsx</code>");
    expect(s.runSummary().toolCounts).toEqual([
      { label: "📚 Loading skill <code>pptxgenjs</code>", count: 1 },
      { label: "📚 Loading skill <code>xlsx</code>", count: 1 },
    ]);
  });

  it("escapes skill names and treats supporting files as file reads", () => {
    const s = new StreamShaper();
    s.onToolCall("read", { path: "skills/<example>/SKILL.md" });
    expect(s.toolStatusMd()).toContain("<code>&lt;example&gt;</code>");
    s.onToolCall("read", { path: "skills/xlsx/references/formulas.md" });
    expect(s.toolStatusMd()).toContain("📖 Reading file <code>skills/xlsx/references/formulas.md</code>");
  });

  it("summarizes created file outputs as files", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "tool-call", toolName: "create_file", input: { path: "/report.txt" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "create_file", output: { file_id: 12, name: "report.txt" } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("📎 Attaching file <code>/report.txt</code> (1 file)");
  });

  it("summarizes generated image outputs as images", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, { type: "tool-call", toolName: "generate_image", input: { prompt: "red square" } })).toBe("tool-call");
    expect(handleStreamPart(s, { type: "tool-result", toolName: "generate_image", output: { generated_image: true, path: "/assets/generated-image.png" } })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("🖼️ Generating image <code>red square</code> (image saved)");
    expect(s.runSummary()).toEqual({
      reasoningSummaries: [],
      toolCallCount: 1,
      toolCounts: [{ label: "🖼️ Generating image", count: 1 }],
    });
  });

  it("summarizes workspace image inspection outputs as images", () => {
    const s = new StreamShaper();
    expect(handleStreamPart(s, {
      type: "tool-call",
      toolName: "inspect_workspace_images",
      input: { paths: ["/collage.jpg", "/detail.png"] },
    })).toBe("tool-call");
    expect(handleStreamPart(s, {
      type: "tool-result",
      toolName: "inspect_workspace_images",
      output: { inspected: true, images: [{ path: "/collage.jpg" }, { path: "/detail.png" }] },
    })).toBe("tool-result");
    expect(s.thinkingMd()).toContain("👁️ Inspecting images <code>/collage.jpg +1</code> (2 images)");
  });

  it("summarizes browser session closure without exposing tab URLs", () => {
    const s = new StreamShaper();
    handleStreamPart(s, { type: "tool-call", toolName: "browser_close_session", input: {} });
    handleStreamPart(s, {
      type: "tool-result",
      toolName: "browser_close_session",
      output: { closed: true, tabs_closed: 4, profile_preserved: true },
    });

    expect(s.thinkingMd()).toContain("🧹 Closing browser session (4 tabs)");
    expect(s.thinkingMd()).not.toContain("http");
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

describe("toolErrorText", () => {
  it("extracts direct Pi tool-result text when details are empty", () => {
    expect(toolErrorText({
      content: [{ type: "text", text: "Image request failed: Billing hard limit has been reached." }],
      details: {},
      isError: true,
    }, true)).toBe("Image request failed: Billing hard limit has been reached.");
  });

  it("does not treat successful Pi tool-result text as an error", () => {
    expect(toolErrorText({
      content: [{ type: "text", text: JSON.stringify({ image_url: "data:image/png;base64,ok" }) }],
      details: { image_url: "data:image/png;base64,ok" },
    })).toBeUndefined();
  });
});
