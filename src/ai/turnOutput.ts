import type { TurnInput } from "./types.js";

interface ResolvedTurnAnswer {
  answer: string;
  usedEmptyFallback: boolean;
}

export function resolveTurnAnswer(input: {
  answer: string;
  attachmentCount: number;
  emptyAnswer: string;
}): ResolvedTurnAnswer {
  if (!input.answer.trim() && input.attachmentCount === 0) {
    return { answer: input.emptyAnswer, usedEmptyFallback: true };
  }
  return { answer: input.answer, usedEmptyFallback: false };
}

export function formatMarkdownListItem(text: string): string {
  const [firstLine = "", ...continuation] = text.trim().split("\n");
  return [`- ${firstLine}`, ...continuation.map((line) => line ? `  ${line}` : "")].join("\n");
}

export function draftAnswerWhileGeneratingImage(answer: string, hasGenerateImageCall: boolean): string {
  return hasGenerateImageCall ? "" : answer;
}

type GeneratedImageFinalText = {
  answer: string;
  demotedReasoning?: string;
};

export function normalizeGeneratedImageFinalText(answer: string, hasGeneratedImage: boolean): GeneratedImageFinalText {
  if (!hasGeneratedImage) return { answer };
  const trimmed = answer.trim();
  if (isGeneratedImageToolUsageAnswer(trimmed)) {
    return {
      answer: "",
      demotedReasoning: trimmed,
    };
  }
  return { answer: "" };
}

function compactAnswerText(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

const IMAGE_TOOL_NAME_SOURCE = "(?:imagegen|generate_image|image generation tool|image generator tool|image tool)";

function isGeneratedImageToolUsageAnswer(answer: string): boolean {
  const compact = compactAnswerText(answer);
  if (!compact) return false;
  const mentionsImageTool = new RegExp(`\\b${IMAGE_TOOL_NAME_SOURCE}\\b`).test(compact);
  if (!mentionsImageTool) return false;
  return /^(?:i(?:'m| am)?\s+)?(?:using|calling|invoking|running|used|called|invoked|ran)\b/.test(compact)
    || new RegExp(`\\b(?:using|calling|invoking|running|used|called|invoked|ran)\\b.{0,40}\\b${IMAGE_TOOL_NAME_SOURCE}\\b`).test(compact)
    || new RegExp(`\\b${IMAGE_TOOL_NAME_SOURCE}\\b.{0,40}\\b(?:tool|to edit|to generate|to create|to draw|to render)\\b`).test(compact);
}

export function appendGeneratedImageDemotedThinking(
  t: TurnInput["t"],
  thinking: string,
  demotedReasoning: string | undefined,
): string {
  const note = demotedReasoning?.trim();
  if (!note) return thinking;
  const section = `${t("thinking-final-reasoning", { count: 1 })}\n\n${formatMarkdownListItem(note)}`;
  return thinking.trim() ? `${thinking.trimEnd()}\n\n${section}` : section;
}
