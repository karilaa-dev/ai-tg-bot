import { describe, expect, it } from "vitest";
import { chunkCsv, chunkMarkdown } from "../../src/files/chunker.js";

describe("chunker", () => {
  it("tracks markdown heading paths", () => {
    const chunks = chunkMarkdown("# A\ntext\n## B\nmore", 20);
    expect(chunks.some((chunk) => chunk.headingPath === "A > B")).toBe(true);
  });

  it("splits csv by row ranges", () => {
    const chunks = chunkCsv("a,b\n1,2\n3,4\n5,6", 2);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(["rows 1-2", "rows 3-3"]);
  });
});
