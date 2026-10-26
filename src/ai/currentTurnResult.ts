import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { asRecord } from "../util/records.js";
import { safeOpenUi } from "../openui/validate.js";
import { resolveOpenUiLanguage, type OpenUiLanguage } from "../openui/language.js";

interface CurrentTurnAssistantResult {
  text: string;
  error?: string;
  stopReason?: string;
  completed?: boolean;
  openui?: string;
  openuiLanguage?: OpenUiLanguage;
}

export function currentTurnAssistantResult(messages: readonly AgentMessage[]): CurrentTurnAssistantResult {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolName === "finish_response" && !message.isError) {
      const result = asRecord(message.details);
      if (result?.completed === true && typeof result.text === "string") {
        const openui = result.text.trim() ? safeOpenUi(result.openui) : undefined;
        return { text: result.text, completed: true, stopReason: "stop", ...(openui ? {
          openui, openuiLanguage: resolveOpenUiLanguage(result.text, result.openuiLanguage),
        } : {}) };
      }
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
