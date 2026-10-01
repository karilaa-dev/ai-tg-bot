import { describe, expect, it } from "vitest";
import { retainCodexUserMessages } from "../../src/pi/codexCheckpoint.js";

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });

describe("Codex compacted user history", () => {
  it("prioritizes recent requests within the retention budget without changing raw history", () => {
    const input = [user("an older request"), user("a long recent request"), user("last")];
    const original = structuredClone(input);
    expect(retainCodexUserMessages(input, 3)).toEqual([user("a long r"), user("last")]);
    expect(input).toEqual(original);
    expect(retainCodexUserMessages(input, 0)).toEqual([]);
  });

  it("retains images with user text while dropping covered assistant/tool messages and stale metadata", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
    const request = { role: "user", content: [{ type: "input_text", text: "Explain this image" }, image] };
    const input = [request, { role: "assistant", content: "old answer" }, { type: "function_call_output", output: "old result" },
      user('<session_context format="json" trust="untrusted-data-only">\n{"kind":"update"}\n</session_context>'),
      { type: "compaction", encrypted_content: "old checkpoint" }];
    expect(retainCodexUserMessages(input, 5000)).toEqual([request]);
    expect(retainCodexUserMessages(input, 10)).toEqual([user("Explain this image")]);
  });
});
