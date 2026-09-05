import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { asRecord } from "../util/records.js";

interface CurrentTurnAssistantResult {
  text: string;
  error?: string;
  stopReason?: string;
  completed?: boolean;
}

export function currentTurnAssistantResult(messages: readonly AgentMessage[]): CurrentTurnAssistantResult {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolName === "finish_response" && !message.isError) {
      const result = asRecord(message.details);
      if (result?.completed === true && typeof result.text === "string") return { text: result.text, completed: true, stopReason: "stop" };
    }
    if (message?.role !== "assistant") continue;
    return {
      text: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim(),
      error: message.errorMessage,
      stopReason: message.stopReason,
    };
  }
  return { text: "" };
}
