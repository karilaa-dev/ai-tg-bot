import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { currentTurnAssistantResult } from "../../src/ai/currentTurnResult.js";

describe("currentTurnAssistantResult", () => {
  it("returns no answer when the current turn created no assistant message", () => {
    const current = [userMessage("new request")];
    expect(currentTurnAssistantResult(current)).toEqual({ text: "" });
  });

  it("derives text, error, and stop reason only from the supplied current-turn slice", () => {
    const previous = assistantMessage("old answer", "stop", "old error");
    const current = [userMessage("new request"), assistantMessage("new partial", "aborted", "new error")];

    expect(currentTurnAssistantResult([previous])).toMatchObject({ text: "old answer" });
    expect(currentTurnAssistantResult(current)).toEqual({
      text: "new partial",
      error: "new error",
      stopReason: "aborted",
    });
  });
});

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantMessage(text: string, stopReason: string, errorMessage: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    errorMessage,
    timestamp: 1,
  } as AgentMessage;
}
