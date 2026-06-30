import type { InputRichMessage } from "./richApi.js";
import { repairLadder, sanitize } from "./mdRepair.js";

const SHOW_MORE_THRESHOLD = 3500;

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
  const thinking = renderThinkingDetails(input.thinkingLog, thinkingTitle(input.t, "final", input.elapsedMs));
  const answer = withShowMore(sanitize(input.answerMd, { enforceLimit: false }), SHOW_MORE_THRESHOLD, input.t);
  return splitRich(`${thinking}${answer}`).map((markdown) => ({ markdown: sanitize(markdown) }));
}

export function renderDraft(input: RenderDraftInput): InputRichMessage {
  if (!input.thinkingMd.trim() && !input.answerMd.trim()) {
    return { markdown: sanitize(input.t("thinking-placeholder")) };
  }
  const title = draftThinkingTitle(input.t, input.thinkingMd, input.elapsedMs);
  const thinking = renderDraftThinking(input.thinkingMd, title);
  const answer = input.answerMd.trim() ? `${thinking ? "" : "\n\n"}${input.answerMd}` : "";
  return { markdown: sanitize(`${thinking || title}${answer}`) };
}

export function variantsForRichRetry(markdown: string): InputRichMessage[] {
  return repairLadder(markdown).map((variant) => ({ markdown: variant }));
}

function withShowMore(md: string, threshold: number, t: (key: string) => string): string {
  if (md.length <= threshold) return md;
  const cut = findBlockBoundary(md, threshold);
  const head = md.slice(0, cut).trimEnd();
  const tailText = md.slice(cut).trimStart();
  return `${head}\n\n<details><summary>${t("show-more")}</summary>\n\n${tailText}\n\n</details>`;
}

function renderDraftThinking(thinkingLog: string | undefined, title: string): string {
  const trimmed = thinkingLog?.trim();
  if (!trimmed) return "";
  return renderThinkingDetails(trimmed, title);
}

function renderThinkingDetails(thinkingLog: string | undefined, title: string): string {
  const trimmed = thinkingLog?.trim();
  if (!trimmed) return "";
  return `<details>\n<summary>${title}</summary>\n\n${trimmed}\n\n</details>\n\n`;
}

function findBlockBoundary(md: string, threshold: number): number {
  const boundaries: number[] = [];
  const min = threshold * 0.5;
  let offset = 0;
  let inFence = false;
  for (const line of linesWithEndings(md)) {
    const start = offset;
    const end = offset + line.length;
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      if (!inFence) boundaries.push(end);
      offset = end;
      continue;
    }
    if (!inFence) {
      if (!trimmed) boundaries.push(start);
      else if (!line.includes("|")) boundaries.push(end);
    }
    offset = end;
  }
  return boundaries.filter((boundary) => boundary <= threshold && boundary > min).at(-1) ?? boundaries.find((boundary) => boundary > threshold) ?? threshold;
}

function linesWithEndings(text: string): string[] {
  return text.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function splitRich(md: string): string[] {
  const max = 32768;
  if (Buffer.byteLength(md, "utf8") <= max) return [md];
  const parts: string[] = [];
  let current = "";
  let inFence = false;
  let fenceOpener = "```";
  for (const line of linesWithEndings(md)) {
    const closingFence = inFence ? "\n```" : "";
    if (current && Buffer.byteLength(current + line + closingFence, "utf8") > max) {
      if (inFence) {
        parts.push(`${current.trimEnd()}\n\`\`\``);
        current = `${fenceOpener}\n`;
      } else {
        parts.push(current.trimEnd());
        current = "";
      }
    }
    current += line;
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
  if (current.trim()) parts.push(current.trimEnd());
  return parts;
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

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
