import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CurrentTurnAssistantResult {
  text: string;
  error?: string;
  stopReason?: string;
}

export function currentTurnAssistantResult(messages: readonly AgentMessage[]): CurrentTurnAssistantResult {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return {
      text: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim(),
      error: message.errorMessage,
      stopReason: message.stopReason,
    };
  }
  return { text: "" };
}
