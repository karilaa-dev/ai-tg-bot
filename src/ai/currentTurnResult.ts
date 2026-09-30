import { asRecord } from "../util/records.js";

interface CurrentTurnAssistantResult {
  text: string;
  error?: string;
  stopReason?: string;
  completed?: boolean;
}

export function currentTurnAssistantResult(messages: readonly unknown[]): CurrentTurnAssistantResult {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role === "toolResult" && message.toolName === "finish_response" && !message.isError) {
      const result = asRecord(message.details);
      if (result?.completed === true && typeof result.text === "string") return { text: result.text, completed: true, stopReason: "stop" };
    }
    if (message?.role !== "assistant") continue;
    return {
      text: (Array.isArray(message.content) ? message.content : []).flatMap((part) => asRecord(part)?.type === "text" ? [String(asRecord(part)?.text ?? "")] : []).join("").trim(),
      error: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    };
  }
  return { text: "" };
}
