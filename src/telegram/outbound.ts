import telegramifyMarkdown from 'telegramify-markdown';

import { TelegramApiClient, TelegramApiError, type TelegramMessageResult, type TelegramParseMode } from './api.js';

const TELEGRAM_LIMIT = 4096;
const MARKDOWN_PARSE_MODE: TelegramParseMode = 'MarkdownV2';
const MAX_MONOTONIC_SCAN = 1024;

export interface TelegramFormattedChunk {
  rawText: string;
  text: string;
  parseMode: TelegramParseMode;
}

interface TelegramCallOptions {
  chatId: number;
  messageThreadId?: number;
}

function rewriteMarkdownTablesToCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let index = 0;
  let inFence = false;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      output.push(line);
      index += 1;
      continue;
    }

    if (!inFence && isMarkdownTableStart(lines, index)) {
      const { rendered, nextIndex } = renderMarkdownTableBlock(lines, index);
      output.push(rendered);
      index = nextIndex;
      continue;
    }

    output.push(line);
    index += 1;
  }

  return output.join('\n');
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];

  return Boolean(header && separator && isTableHeaderLine(header) && isTableSeparatorLine(separator));
}

function isTableHeaderLine(line: string): boolean {
  if (!line.includes('|')) {
    return false;
  }

  const cells = parseTableRow(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

function isTableRowLine(line: string): boolean {
  return line.includes('|') && parseTableRow(line).length >= 2;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutOuterPipes = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutOuterPipes.split('|').map((cell) => cell.trim());
}

function renderMarkdownTableBlock(lines: string[], startIndex: number): { rendered: string; nextIndex: number } {
  const rows: string[][] = [];
  const headerCells = parseTableRow(lines[startIndex] ?? '');
  rows.push(headerCells);

  let index = startIndex + 2;
  while (index < lines.length && isTableRowLine(lines[index] ?? '')) {
    rows.push(parseTableRow(lines[index] ?? ''));
    index += 1;
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedRows = rows.map((row) => {
    return Array.from({ length: columnCount }, (_, columnIndex) => row[columnIndex] ?? '');
  });
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    return normalizedRows.reduce((max, row) => Math.max(max, row[columnIndex]?.length ?? 0), 0);
  });

  const renderedRows = normalizedRows.map((row) => {
    return row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex] ?? cell.length, ' '))
      .join(' | ');
  });

  return {
    rendered: `\`\`\`text\n${renderedRows.join('\n')}\n\`\`\``,
    nextIndex: index,
  };
}

function normalizeRawText(text: string): string {
  return text.length > 0 ? text : ' ';
}

function formatMarkdown(text: string): string {
  const formatted = telegramifyMarkdown(rewriteMarkdownTablesToCodeBlocks(normalizeRawText(text)), 'escape');
  return formatted.length > 0 ? formatted : ' ';
}

function renderChunk(rawText: string): TelegramFormattedChunk {
  const normalized = normalizeRawText(rawText);
  return {
    rawText: normalized,
    text: formatMarkdown(normalized),
    parseMode: MARKDOWN_PARSE_MODE,
  };
}

function formattedLength(text: string): number {
  return formatMarkdown(text).length;
}

function findLeadingFenceInfo(text: string): { info: string; bodyStart: number } | null {
  if (!text.startsWith('```')) {
    return null;
  }

  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) {
    return null;
  }

  return {
    info: text.slice(3, firstNewline),
    bodyStart: firstNewline + 1,
  };
}

function splitOversizedLeadingFence(text: string): { chunk: string; remainder: string } | null {
  const fence = findLeadingFenceInfo(text);
  if (!fence) {
    return null;
  }

  const closingFenceIndex = text.indexOf('\n```', fence.bodyStart);
  const hasClosingFence = closingFenceIndex !== -1;
  const bodyEnd = hasClosingFence ? closingFenceIndex : text.length;
  const body = text.slice(fence.bodyStart, bodyEnd);
  const suffix = hasClosingFence ? text.slice(closingFenceIndex + 4) : '';
  const lines = body.split('\n');

  let bestBody = '';
  let consumedCharacters = 0;
  let partialFirstLine = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const candidateBody = index === 0 ? line : `${bestBody}\n${line}`;
    const candidateChunk = wrapFenceChunk(fence.info, candidateBody);
    if (formattedLength(candidateChunk) <= TELEGRAM_LIMIT) {
      bestBody = candidateBody;
      consumedCharacters += index === 0 ? line.length : line.length + 1;
      continue;
    }

    if (index === 0) {
      const prefixLength = findLongestInlinePrefix(line, (prefix) => {
        return formattedLength(wrapFenceChunk(fence.info, prefix)) <= TELEGRAM_LIMIT;
      });

      if (prefixLength > 0) {
        bestBody = line.slice(0, prefixLength);
        consumedCharacters = prefixLength;
        partialFirstLine = prefixLength < line.length;
      }
    }

    break;
  }

  if (bestBody.length === 0) {
    return null;
  }

  const remainingBody = body.slice(consumedCharacters);
  const chunk = wrapFenceChunk(fence.info, bestBody);
  let remainder = '';

  if (remainingBody.length > 0) {
    remainder = `\`\`\`${fence.info}\n${remainingBody}`;
    if (hasClosingFence) {
      if (!remainingBody.endsWith('\n')) {
        remainder += '\n';
      }
      remainder += '```';
    }
    remainder += suffix;
  } else if (hasClosingFence) {
    remainder = suffix;
  }

  if (!partialFirstLine && remainder.startsWith('\n')) {
    remainder = remainder.slice(1);
  }

  return {
    chunk,
    remainder,
  };
}

function wrapFenceChunk(info: string, body: string): string {
  const normalizedBody = body.endsWith('\n') || body.length === 0 ? body : `${body}\n`;
  return `\`\`\`${info}\n${normalizedBody}\`\`\``;
}

function findLongestInlinePrefix(text: string, predicate: (candidate: string) => boolean): number {
  let low = 0;
  let high = text.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (predicate(text.slice(0, middle))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let best = low;
  const upperBound = Math.min(text.length, low + MAX_MONOTONIC_SCAN);
  for (let index = low + 1; index <= upperBound; index += 1) {
    if (predicate(text.slice(0, index))) {
      best = index;
    }
  }

  return best;
}

function findMaxSafePrefixLength(text: string): number {
  if (formattedLength(text) <= TELEGRAM_LIMIT) {
    return text.length;
  }

  return findLongestInlinePrefix(text, (candidate) => formattedLength(candidate) <= TELEGRAM_LIMIT);
}

function collectBoundaryCandidates(text: string, maxSafePrefixLength: number): number[] {
  const candidates = new Set<number>();

  const pushMatches = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      const matched = match[0];
      const index = match.index;
      if (index === undefined) {
        continue;
      }

      const end = index + matched.length;
      if (end <= maxSafePrefixLength) {
        candidates.add(end);
      }
    }
  };

  pushMatches(/```[^\n`]*\n[\s\S]*?\n```(?:\n|$)?/g);
  pushMatches(/\n\s*\n+/g);
  pushMatches(/\n/g);
  pushMatches(/[ \t]+/g);

  return [...candidates].sort((left, right) => right - left);
}

function splitPlainChunk(text: string): { chunk: string; remainder: string } {
  const maxSafePrefixLength = findMaxSafePrefixLength(text);
  const boundaryCandidates = collectBoundaryCandidates(text, maxSafePrefixLength);

  for (const candidate of boundaryCandidates) {
    const rawChunk = text.slice(0, candidate);
    if (formattedLength(rawChunk) <= TELEGRAM_LIMIT) {
      return {
        chunk: rawChunk.trimEnd(),
        remainder: text.slice(candidate).trimStart(),
      };
    }
  }

  const fallbackChunk = text.slice(0, maxSafePrefixLength);
  return {
    chunk: fallbackChunk.trimEnd(),
    remainder: text.slice(maxSafePrefixLength).trimStart(),
  };
}

function splitNextChunk(text: string): { chunk: string; remainder: string } {
  if (formattedLength(text) <= TELEGRAM_LIMIT) {
    return {
      chunk: text,
      remainder: '',
    };
  }

  const fenceSplit = splitOversizedLeadingFence(text);
  if (fenceSplit && formattedLength(fenceSplit.chunk) <= TELEGRAM_LIMIT) {
    return fenceSplit;
  }

  return splitPlainChunk(text);
}

export function splitTelegramMarkdown(text: string): TelegramFormattedChunk[] {
  const normalized = normalizeRawText(text);
  const chunks: TelegramFormattedChunk[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    const { chunk, remainder } = splitNextChunk(remaining);
    chunks.push(renderChunk(chunk));
    remaining = remainder;
  }

  return chunks;
}

export function createTelegramMarkdownPreview(text: string): TelegramFormattedChunk {
  return splitTelegramMarkdown(text)[0] ?? renderChunk(' ');
}

function shouldFallbackToPlainText(error: unknown): boolean {
  return error instanceof TelegramApiError && error.errorCode === 400;
}

export async function sendTelegramMarkdownMessage(
  telegram: TelegramApiClient,
  input: TelegramCallOptions & { text: string },
): Promise<TelegramMessageResult> {
  const chunk = renderChunk(input.text);
  const baseInput = input.messageThreadId === undefined
    ? {
        chatId: input.chatId,
        text: chunk.text,
      }
    : {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        text: chunk.text,
      };

  try {
    return await telegram.sendMessage({
      ...baseInput,
      parseMode: chunk.parseMode,
    });
  } catch (error) {
    if (!shouldFallbackToPlainText(error)) {
      throw error;
    }

    console.warn('Telegram rejected formatted sendMessage payload; retrying as plain text');

    return telegram.sendMessage({
      ...(input.messageThreadId === undefined
        ? {
            chatId: input.chatId,
            text: chunk.rawText,
          }
        : {
            chatId: input.chatId,
            messageThreadId: input.messageThreadId,
            text: chunk.rawText,
          }),
    });
  }
}

export async function sendTelegramMarkdownDraft(
  telegram: TelegramApiClient,
  input: TelegramCallOptions & { draftId: number; text: string },
): Promise<boolean> {
  const chunk = createTelegramMarkdownPreview(input.text);
  const baseInput = input.messageThreadId === undefined
    ? {
        chatId: input.chatId,
        draftId: input.draftId,
        text: chunk.text,
      }
    : {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        draftId: input.draftId,
        text: chunk.text,
      };

  try {
    return await telegram.sendMessageDraft({
      ...baseInput,
      parseMode: chunk.parseMode,
    });
  } catch (error) {
    if (!shouldFallbackToPlainText(error)) {
      throw error;
    }

    console.warn('Telegram rejected formatted sendMessageDraft payload; retrying as plain text');

    return telegram.sendMessageDraft({
      ...(input.messageThreadId === undefined
        ? {
            chatId: input.chatId,
            draftId: input.draftId,
            text: chunk.rawText,
          }
        : {
            chatId: input.chatId,
            messageThreadId: input.messageThreadId,
            draftId: input.draftId,
            text: chunk.rawText,
          }),
    });
  }
}

export async function editTelegramMarkdownMessage(
  telegram: TelegramApiClient,
  input: { chatId: number; messageId: number; text: string },
): Promise<TelegramMessageResult> {
  const chunk = createTelegramMarkdownPreview(input.text);

  try {
    return await telegram.editMessageText({
      chatId: input.chatId,
      messageId: input.messageId,
      text: chunk.text,
      parseMode: chunk.parseMode,
    });
  } catch (error) {
    if (!shouldFallbackToPlainText(error)) {
      throw error;
    }

    console.warn('Telegram rejected formatted editMessageText payload; retrying as plain text');

    return telegram.editMessageText({
      chatId: input.chatId,
      messageId: input.messageId,
      text: chunk.rawText,
    });
  }
}
