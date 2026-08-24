import { describe, expect, it } from "vitest";
import { resolveTurnAnswer } from "../../src/ai/turnOutput.js";

describe("resolveTurnAnswer", () => {
  it("accepts an intentional created file as the final turn output", () => {
    const result = resolveTurnAnswer({
      answer: "",
      attachmentCount: 1,
      emptyAnswer: "missing answer",
    });

    expect(result).toEqual({ answer: "", usedEmptyFallback: false });
  });

  it("uses the localized fallback only when the turn produced no text or files", () => {
    expect(resolveTurnAnswer({
      answer: "",
      attachmentCount: 0,
      emptyAnswer: "missing answer",
    })).toEqual({ answer: "missing answer", usedEmptyFallback: true });
  });
});
