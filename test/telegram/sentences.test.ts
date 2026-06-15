import { describe, expect, it } from "vitest";
import { SentenceAssembler } from "../../src/telegram/sentences.js";

describe("SentenceAssembler", () => {
  it("keeps decimal numbers, abbreviations, and URLs inside a sentence", () => {
    const s = new SentenceAssembler();
    s.push("Version 3.14 is at https://example.com/a.b. e.g. it works. Next one!");
    expect(s.completed).toEqual(["Version 3.14 is at https://example.com/a.b. e.g. it works.", " Next one!"]);
  });

  it("treats blank lines and closed fences as boundaries", () => {
    const s = new SentenceAssembler();
    s.push("Intro\n\n```ts\nconst x = 1;\n```");
    expect(s.completed).toEqual(["Intro\n\n", "```ts\nconst x = 1;\n```"]);
  });
});
