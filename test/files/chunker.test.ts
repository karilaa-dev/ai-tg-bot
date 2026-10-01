import { describe, expect, it } from "vitest";
import { chunkCsv, chunkMarkdown } from "../../src/files/chunker.js";

describe("chunker", () => {
  it("tracks markdown heading paths", () => {
    const chunks = chunkMarkdown("# A\ntext\n## B\nmore", 20);
    expect(chunks.some((chunk) => chunk.headingPath === "A > B")).toBe(true);
  });

  it("splits csv by record ranges while preserving headers and multiline fields", () => {
    const chunks = chunkCsv('a,b\n1,"two\nlines"\n3,4\n5,6\n\n', 2);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(["rows 1-2", "rows 3-3"]);
    expect(chunks.map((chunk) => chunk.content)).toEqual(['a,b\n1,"two\nlines"\n3,4', "a,b\n5,6"]);
  });
});
