import type { InputRichMessage } from "./richApi.js";
import {
  RICH_MESSAGE_BLOCK_LIMIT,
  RICH_MESSAGE_CHARACTER_LIMIT,
  RICH_MESSAGE_MEDIA_LIMIT,
  repairLadder,
  sanitize,
} from "./mdRepair.js";

const FINAL_THINKING_WRAPPER_RESERVE_CHARACTERS = 1024;
const FINAL_THINKING_WRAPPER_RESERVE_BLOCKS = 4;
const THINKING_TRUNCATION_MARKER = "…";

export type RenderT = (key: string, params?: Record<string, string | number>) => string;

export interface RenderFinalInput {
  thinkingLog?: string;
  answerMd: string;
  elapsedMs: number;
  t: RenderT;
}

export interface RenderDraftInput {
  thinkingMd: string;
  answerMd: string;
  elapsedMs: number;
  t: RenderT;
}

export function renderFinal(input: RenderFinalInput): InputRichMessage[] {
  return [
    ...renderFinalThinking(input),
    ...renderFinalAnswer(input),
  ];
}

export function renderFinalThinking(input: Pick<RenderFinalInput, "thinkingLog" | "elapsedMs" | "t">): InputRichMessage[] {
  const thinkingLog = capFinalThinking(input.thinkingLog);
  const thinking = renderThinkingDetails(thinkingLog, thinkingTitle(input.t, "final", input.elapsedMs));
  return thinking ? splitRich(thinking.trimEnd()).map((markdown) => ({ markdown: sanitize(markdown) })) : [];
}

export function renderFinalAnswer(input: Pick<RenderFinalInput, "answerMd">): InputRichMessage[] {
  const answer = sanitize(input.answerMd, { enforceLimit: false });
  return answer.trim() ? splitRich(answer).map((markdown) => ({ markdown: sanitize(markdown) })) : [];
}

export function renderAnswerDraft(answerMd: string): InputRichMessage {
  const answer = sanitize(answerMd, { enforceLimit: false });
  return { markdown: sanitize(splitRich(answer).at(-1) ?? "") };
}

export function renderDraft(input: RenderDraftInput): InputRichMessage {
  if (!input.thinkingMd.trim() && !input.answerMd.trim()) {
    return { markdown: sanitize(input.t("thinking-placeholder")) };
  }
  const title = draftThinkingTitle(input.t, input.thinkingMd, input.elapsedMs);
  const thinking = renderThinkingDetails(input.thinkingMd, title);
  const answer = input.answerMd.trim() ? `${thinking ? "" : "\n\n"}${input.answerMd}` : "";
  return { markdown: sanitize(`${thinking || title}${answer}`) };
}

export function variantsForRichRetry(markdown: string): InputRichMessage[] {
  return repairLadder(markdown).map((variant) => ({ markdown: variant }));
}

function renderThinkingDetails(thinkingLog: string | undefined, title: string): string {
  const trimmed = thinkingLog?.trim();
  if (!trimmed) return "";
  return `<details>\n<summary>${title}</summary>\n\n${trimmed}\n\n</details>\n\n`;
}

function capFinalThinking(thinkingLog: string | undefined): string | undefined {
  const sanitized = thinkingLog ? sanitize(thinkingLog, { enforceLimit: false }).trim() : "";
  if (!sanitized) return undefined;
  const maxCharacters = RICH_MESSAGE_CHARACTER_LIMIT - FINAL_THINKING_WRAPPER_RESERVE_CHARACTERS;
  const maxBlocks = RICH_MESSAGE_BLOCK_LIMIT - FINAL_THINKING_WRAPPER_RESERVE_BLOCKS;
  if (richCharacterLength(sanitized) <= maxCharacters && estimateRichBlocks(sanitized) <= maxBlocks) return sanitized;

  const marker = `\n\n${THINKING_TRUNCATION_MARKER}`;
  const blocks = sanitized.split(/\n{2,}/);
  let capped = "";
  for (const block of blocks) {
    const candidate = capped ? `${capped}\n\n${block}` : block;
    if (
      richCharacterLength(`${candidate}${marker}`) > maxCharacters
      || estimateRichBlocks(`${candidate}${marker}`) > maxBlocks
    ) break;
    capped = candidate;
  }
  return capped ? `${capped}${marker}` : THINKING_TRUNCATION_MARKER;
}

function linesWithEndings(text: string): string[] {
  return text.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function splitRich(md: string): string[] {
  if (withinRichLimits(md)) return [md];
  const parts: string[] = [];
  let current = "";
  let inFence = false;
  let fenceOpener = "```";
  for (const line of linesWithEndings(md)) {
    let remainder = line;
    while (remainder) {
      const closingFence = inFence ? "\n```" : "";
      if (withinRichLimits(`${current}${remainder}${closingFence}`)) {
        current += remainder;
        remainder = "";
        break;
      }

      const reopenedFence = inFence ? `${fenceOpener}\n` : "";
      if (current && current !== reopenedFence) {
        parts.push(finalizeRichPart(current, inFence));
        current = reopenedFence;
        continue;
      }

      const split = takeFittingPrefix(remainder, current, closingFence);
      current += split.head;
      remainder = split.tail;
      parts.push(finalizeRichPart(current, inFence));
      current = reopenedFence;
    }

    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      if (inFence) {
        inFence = false;
        fenceOpener = "```";
      } else {
        inFence = true;
        fenceOpener = trimmed.match(/^```[^\r\n]*/)?.[0] ?? "```";
      }
    }
  }
  if (current.trim()) parts.push(finalizeRichPart(current, inFence));
  return parts;
}

function finalizeRichPart(current: string, inFence: boolean): string {
  const trimmed = current.trimEnd();
  return inFence ? `${trimmed}\n\`\`\`` : trimmed;
}

function takeFittingPrefix(text: string, prefix: string, suffix: string): { head: string; tail: string } {
  const characters = Array.from(text);
  let low = 1;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${prefix}${characters.slice(0, middle).join("")}${suffix}`;
    if (withinRichLimits(candidate)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const length = Math.max(1, best);
  return {
    head: characters.slice(0, length).join(""),
    tail: characters.slice(length).join(""),
  };
}

function withinRichLimits(md: string): boolean {
  return richCharacterLength(md) <= RICH_MESSAGE_CHARACTER_LIMIT
    && estimateRichBlocks(md) <= RICH_MESSAGE_BLOCK_LIMIT
    && estimateRichMedia(md) <= RICH_MESSAGE_MEDIA_LIMIT;
}

function richCharacterLength(text: string): number {
  return Array.from(text).length;
}

function estimateRichBlocks(md: string): number {
  const nonEmptyLines = md.split("\n").filter((line) => line.trim()).length;
  const explicitBlocks = md.match(
    /<(?:details|p|footer|hr|ul|ol|li|table|tr|blockquote|aside|figure|pre|h[1-6]|tg-(?:math-block|map|collage|slideshow|thinking))\b/gi,
  )?.length ?? 0;
  return nonEmptyLines + explicitBlocks;
}

function estimateRichMedia(md: string): number {
  const markdownMedia = md.match(/!\[[^\]]*\]\([^)\n]+\)/g)?.length ?? 0;
  const htmlMedia = md.match(/<(?:img|video|audio)\b/gi)?.length ?? 0;
  return markdownMedia + htmlMedia;
}

function thinkingTitle(t: RenderT, state: "running" | "final", elapsedMs: number): string {
  return t(state === "running" ? "thinking-summary-running" : "thinking-summary-final", {
    time: formatElapsed(elapsedMs),
  });
}

function draftThinkingTitle(t: RenderT, thinkingMd: string, elapsedMs: number): string {
  const key = isGeneratingImageThinking(thinkingMd) ? "thinking-summary-generating-image" : "thinking-summary-running";
  return t(key, { time: formatElapsed(elapsedMs) });
}

function isGeneratingImageThinking(thinkingMd: string): boolean {
  return /(?:^|\n)\s*🖼️ Generating image\b/.test(thinkingMd);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
