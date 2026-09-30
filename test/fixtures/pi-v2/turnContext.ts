import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  formatSkillsForPrompt,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

export interface TurnPromptContextSource {
  currentTurnSystemPrompt(): string | undefined;
  currentTurnSessionContext(): string | undefined;
}

export function createTurnPromptContextExtension(
  source: TurnPromptContextSource,
): InlineExtension {
  return {
    name: "turn-prompt-context",
    factory: (pi) => {
      pi.on("before_agent_start", async (event) => {
        const systemPrompt = source.currentTurnSystemPrompt();
        if (systemPrompt === undefined) return undefined;
        return {
          systemPrompt: `${systemPrompt}${formatSkillsForPrompt(event.systemPromptOptions.skills ?? [])}`,
        };
      });
      pi.on("context", async (event) => {
        const sessionContext = source.currentTurnSessionContext();
        if (sessionContext === undefined) return undefined;
        const messages = prependSessionContext(event.messages, sessionContext);
        return messages === event.messages ? undefined : { messages };
      });
    },
  };
}

export function prependSessionContext(
  messages: AgentMessage[],
  sessionContext: string,
): AgentMessage[] {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return messages;

  const message = messages[userIndex]!;
  if (message.role !== "user") return messages;
  const contextPart: TextContent = { type: "text", text: `${sessionContext}\n\n` };
  const content = typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : message.content;
  if (content.length > 1 && content[0]?.type === "text" && content[0].text === contextPart.text) {
    return messages;
  }

  const output = [...messages];
  output[userIndex] = { ...message, content: [contextPart, ...content] };
  return output;
}
