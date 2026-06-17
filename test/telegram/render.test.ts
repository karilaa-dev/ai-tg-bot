import { describe, expect, it } from "vitest";
import { renderDraft, renderFinal } from "../../src/telegram/render.js";

describe("renderFinal", () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    if (key === "thinking-placeholder") return "Thinking...";
    if (key === "thinking-summary-running") return `Thinking for ${params?.time}`;
    if (key === "thinking-summary-final") return `Thought for ${params?.time}`;
    return key;
  };

  it("splits long rich messages instead of truncating before split", () => {
    const answer = `${"long paragraph\n\n".repeat(2600)}tail-marker`;
    const parts = renderFinal({
      answerMd: answer,
      elapsedMs: 0,
      t,
    });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.markdown ?? "").join("")).toContain("tail-marker");
    expect(parts.map((part) => part.markdown ?? "").join("")).not.toContain("[truncated]");
  });

  it("places Show More after a closing code fence when the threshold falls inside the fence", () => {
    const answer = `Intro\n\n\`\`\`ts\n${"const value = 1;\n".repeat(300)}\`\`\`\n\nTail`;
    const [part] = renderFinal({
      answerMd: answer,
      elapsedMs: 0,
      t,
    });
    const markdown = part?.markdown ?? "";

    expect(markdown.indexOf("```", markdown.indexOf("```") + 1)).toBeLessThan(markdown.indexOf("<details>"));
  });

  it("closes and reopens oversized code fences across split rich messages", () => {
    const answer = `\`\`\`ts\n${"const value = 1;\n".repeat(4000)}\`\`\``;
    const parts = renderFinal({
      answerMd: answer,
      elapsedMs: 0,
      t,
    });

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const markdown = part.markdown ?? "";
      expect(markdown.match(/^```/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect((markdown.match(/^```/gm)?.length ?? 0) % 2).toBe(0);
      expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(32768);
    }
    expect(parts.slice(1).some((part) => (part.markdown ?? "").startsWith("```ts\n"))).toBe(true);
  });

  it("renders an empty draft as the plain thinking placeholder without a details block", () => {
    const payload = renderDraft({
      thinkingMd: "",
      answerMd: "",
      elapsedMs: 0,
      t,
    });
    const markdown = payload.markdown ?? "";

    expect(markdown).toBe("Thinking...");
    expect(markdown).not.toContain("<details>");
  });

  it("renders draft thinking in a closed elapsed details block once content exists", () => {
    const payload = renderDraft({
      thinkingMd: "🔎 Searching web <code>alpha</code> (5 results)",
      answerMd: "Answer.",
      elapsedMs: 27_000,
      t,
    });
    const markdown = payload.markdown ?? "";

    expect(markdown).toContain("<details>\n<summary>Thinking for 27s</summary>");
    expect(markdown).toContain("🔎 Searching web <code>alpha</code> (5 results)");
    expect(markdown).toContain("</details>");
    expect(markdown).toContain("Answer.");
    expect(markdown).not.toContain("<tg-thinking>");
  });

  it("renders provided long draft thinking without character-tail slicing", () => {
    const payload = renderDraft({
      thinkingMd: `Opening title\n${"reasoning detail ".repeat(260)}`,
      answerMd: "",
      elapsedMs: 8_000,
      t,
    });
    const markdown = payload.markdown ?? "";

    expect(markdown).toContain("<details>\n<summary>Thinking for 8s</summary>");
    expect(markdown).toContain("Opening title");
    expect(markdown).toContain("reasoning detail");
    expect(markdown).not.toContain("\n\n...");
  });

  it("renders final thinking with a final elapsed title instead of step counts", () => {
    const [payload] = renderFinal({
      thinkingLog: "First thought\nSecond thought",
      answerMd: "Answer.",
      elapsedMs: 65_000,
      t,
    });
    const markdown = payload?.markdown ?? "";

    expect(markdown).toContain("<details>\n<summary>Thought for 1m 05s</summary>");
    expect(markdown).not.toContain("steps");
  });

  it("preserves rich Markdown media blocks", () => {
    const [payload] = renderFinal({
      answerMd: "![Generated image](https://cdn.example.test/generated-image.png)",
      elapsedMs: 0,
      t,
    });

    expect(payload?.markdown).toContain("![Generated image](https://cdn.example.test/generated-image.png)");
  });
});
