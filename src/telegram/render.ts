import type { AppConfig } from "../config.js";
import type { InputRichMessage } from "./richApi.js";
import { repairLadder, sanitize } from "./mdRepair.js";

export type RenderT = (key: string, params?: Record<string, string | number>) => string;

export interface RenderFinalInput {
  thinkingLog?: string;
  answerMd: string;
  t: RenderT;
  config: Pick<AppConfig, "SHOW_MORE_THRESHOLD_CHARS">;
}

export interface RenderDraftInput {
  thinkingMd: string;
  answerMd: string;
  t: RenderT;
}

export function renderFinal(input: RenderFinalInput): InputRichMessage[] {
  const thinking = renderThinkingDetails(input.thinkingLog, input.t, 8000);
  const answer = withShowMore(sanitize(input.answerMd, { enforceLimit: false }), input.config.SHOW_MORE_THRESHOLD_CHARS, input.t);
  return splitRich(`${thinking}${answer}`).map((markdown) => ({ markdown: sanitize(markdown) }));
}

export function renderDraft(input: RenderDraftInput): InputRichMessage {
  const thinking = renderThinkingDetails(input.thinkingMd, input.t, 3000);
  return { markdown: sanitize(`${thinking}${input.answerMd}`) };
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

function renderThinkingDetails(thinkingLog: string | undefined, t: RenderT, chars: number): string {
  const trimmed = thinkingLog?.trim();
  if (!trimmed) return "";
  return `<details><summary>${t("thinking-summary", { steps: countLines(trimmed) })}</summary>\n\n${tail(trimmed, chars)}\n\n</details>\n\n`;
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

function countLines(text: string): number {
  return text.split("\n").filter((line) => line.trim()).length;
}

function tail(text: string, chars: number): string {
  return text.length > chars ? `...${text.slice(-chars)}` : text;
}
