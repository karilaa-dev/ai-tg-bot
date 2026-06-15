import { describe, expect, it } from "vitest";
import { closeOpenStructures, repairLadder, sanitize } from "../../src/telegram/mdRepair.js";

describe("mdRepair", () => {
  it("closes open code fences", () => {
    expect(closeOpenStructures("```ts\nconst x = 1;")).toContain("\n```");
  });

  it("escapes unknown tags without dropping content", () => {
    expect(sanitize("<script>alert(1)</script><details><summary>x</summary>ok</details>")).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("normalizes ragged tables and returns a repair ladder", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 |";
    expect(sanitize(md)).toContain("| 1 |  |");
    expect(repairLadder(md)).toHaveLength(4);
  });

  it("escapes orphan footnote refs while preserving defined footnotes", () => {
    expect(sanitize("Missing ref [^lost].")).toContain("\\[\\^lost\\]");
    const defined = "Defined ref [^ok].\n\n[^ok]: source";
    expect(sanitize(defined)).toContain("[^ok]");
    expect(sanitize(defined)).toContain("[^ok]: source");
  });
});
