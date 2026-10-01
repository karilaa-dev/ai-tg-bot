import { describe, expect, it } from "vitest";
import { StreamShaper } from "../../src/ai/shaper.js";

describe("StreamShaper", () => {
  it("retains reasoning and tool summaries without provisional answers", () => {
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

  it("updates repeated tool calls for the same subject without x-count suffixes", () => {
    const s = new StreamShaper();
    s.onToolCall("web_search", { query: "alpha" });
    s.onToolResult("web_search", "5 results");
    s.onToolCall("web_search", { query: "alpha" });
    expect(s.toolStatusMd()).toBe("🔎 Searching web <code>alpha</code>");
    s.onToolResult("web_search", "2 results");
    expect(s.toolStatusMd()).toBe("🔎 Searching web <code>alpha</code> (2 results)");
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

  it("names loaded skills in live status, final thinking, and tool counts", () => {
    const s = new StreamShaper();
    s.onToolCall("read", { path: "/app/skills/pptxgenjs/SKILL.md" });
    expect(s.toolStatusMd()).toBe("📚 Loading skill <code>pptxgenjs</code>");
    s.onToolResult("read", "loaded");
    s.onToolCall("read", { path: "skills/xlsx/SKILL.md" });
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

});
