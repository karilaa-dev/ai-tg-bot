import { describe, expect, it } from "vitest";
import { renderDraft, renderFinal } from "../../src/telegram/render.js";

describe("renderFinal", () => {
  const t = (key: string, params?: Record<string, string | number>) => key === "thinking-summary" ? `Thinking (${params?.steps} steps)` : key;

  it("splits long rich messages instead of truncating before split", () => {
    const answer = `${"long paragraph\n\n".repeat(2600)}tail-marker`;
    const parts = renderFinal({
      answerMd: answer,
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
      t,
    });
    const markdown = part?.markdown ?? "";

    expect(markdown.indexOf("```", markdown.indexOf("```") + 1)).toBeLessThan(markdown.indexOf("<details>"));
  });

  it("closes and reopens oversized code fences across split rich messages", () => {
    const answer = `\`\`\`ts\n${"const value = 1;\n".repeat(4000)}\`\`\``;
    const parts = renderFinal({
      answerMd: answer,
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

  it("renders draft thinking in the same closed details block as final answers", () => {
    const payload = renderDraft({
      thinkingMd: "🔎 Searching web <code>alpha</code> (5 results)",
      answerMd: "Answer.",
      t,
    });
    const markdown = payload.markdown ?? "";

    expect(markdown).toContain("<details>\n<summary>Thinking (1 steps)</summary>");
    expect(markdown).toContain("🔎 Searching web <code>alpha</code> (5 results)");
    expect(markdown).toContain("</details>");
    expect(markdown).toContain("Answer.");
    expect(markdown).not.toContain("<tg-thinking>");
  });
});
