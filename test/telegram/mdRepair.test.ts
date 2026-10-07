import { describe, expect, it } from "vitest";
import { closeOpenStructures, sanitize } from "../../src/telegram/mdRepair.js";

describe("mdRepair", () => {
  it("closes open code fences", () => {
    expect(closeOpenStructures("```ts\nconst x = 1;")).toBe("```ts\nconst x = 1;\n```");
  });

  it("escapes unknown tags without dropping content", () => {
    expect(sanitize("<script>alert(1)</script><details><summary>x</summary>ok</details>"))
      .toBe("&lt;script&gt;alert(1)&lt;/script&gt;<details><summary>x</summary>ok</details>");
  });

  it("pads ragged table rows to match their headers", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 |";
    expect(sanitize(md)).toBe("| a | b |\n| --- | --- |\n| 1 |  |");
  });

  it("escapes orphan footnote refs while preserving defined footnotes", () => {
    expect(sanitize("Missing ref [^lost].")).toBe("Missing ref \\[\\^lost\\].");
    const defined = "Defined ref [^ok].\n\n[^ok]: source";
    expect(sanitize(defined)).toBe("Defined ref [^ok].\n\n[^ok]: source");
  });
});
