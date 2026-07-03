import fs from "node:fs/promises";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow } from "../db/types.js";
import type { ImageCaptioner } from "../ai/provider.js";
import type { Logger } from "../logger.js";
import { imageMediaTypeFromName } from "../files/mediaType.js";
import { persistEmbedding, type TextEmbedder } from "./embeddings.js";
import { estimateTokens } from "./tokens.js";

const DEFAULT_RECENT_WINDOW = 20;
const MIN_COMPACTABLE_MESSAGES = 10;
const GROUP_TOKEN_BUDGET = 3500;
const FALLBACK_MESSAGE_CHAR_CAP = 500;
const FALLBACK_SEGMENT_CHAR_CAP = 1800;
const META_SUMMARY_CHAR_CAP = 2400;
const IMAGE_DESCRIPTION_CHAR_CAP = 300;

type CaptionOptions = { imageCaptioner?: ImageCaptioner; logger?: Logger };

export interface ConversationSummarizer {
  summarizeSegment(input: { messages: CompactableMessage[] }): Promise<string>;
  mergeMeta(input: { previous: string | null; summaries: string[] }): Promise<string>;
}

export function formatMessageLine(message: { id: number; role: string; text_plain: string }, maxChars: number): string {
  const text = message.text_plain.replace(/\s+/g, " ").slice(0, maxChars);
  return `[#${message.id} ${message.role}] ${text}`;
}

export async function compactThread(
  repos: Repos,
  thread: ThreadRow,
  options: {
    recentWindowMessages?: number;
    embedder?: TextEmbedder;
    summarizer?: ConversationSummarizer;
    imageCaptioner?: ImageCaptioner;
    logger?: Logger;
  } = {},
): Promise<{ count: number; summary: string }> {
  options.logger?.info("thread compaction starting", { threadId: thread.id, title: thread.title });
  const chain = await repos.threads.chain(thread);
  const messages = await repos.messages.listForThreadChain(chain);
  const keep = options.recentWindowMessages ?? DEFAULT_RECENT_WINDOW;
  const rawCompactable = messages.slice(0, Math.max(0, messages.length - keep));
  options.logger?.debug("thread compaction scope loaded", {
    threadId: thread.id,
    chain: chain.length,
    messages: messages.length,
    keep,
    compactable: rawCompactable.length,
  });
  if (rawCompactable.length < MIN_COMPACTABLE_MESSAGES) {
    options.logger?.info("thread compaction skipped; not enough old messages", {
      threadId: thread.id,
      compactable: rawCompactable.length,
    });
    return { count: 0, summary: thread.meta_summary ?? "" };
  }
  const compactable = await prepareMessagesForCompaction(repos, rawCompactable, options);

  const groups = groupByTokenBudget(compactable, GROUP_TOKEN_BUDGET);
  options.logger?.debug("thread compaction groups prepared", {
    threadId: thread.id,
    groups: groups.length,
    compactable: compactable.length,
  });
  const l0Summaries = [];
  for (const group of groups) {
    options.logger?.debug("thread compaction summarizing group", {
      threadId: thread.id,
      messages: group.length,
      fromMessageId: group[0]!.id,
      toMessageId: group.at(-1)!.id,
    });
    const summary = await summarizeGroup(group, options.summarizer, options.logger);
    const inserted = await repos.summaries.insert({
      threadId: thread.id,
      level: 0,
      fromMessageId: group[0]!.id,
      toMessageId: group.at(-1)!.id,
      content: summary,
    });
    await persistEmbedding({
      repos,
      kind: "summary",
      refId: inserted.id,
      text: inserted.content,
      embedder: options.embedder,
      embeddingModel: options.embedder?.model,
      logger: options.logger,
    });
    l0Summaries.push(inserted);
  }
  const summary = await mergeMeta(thread.meta_summary, l0Summaries.map((row) => row.content), options.summarizer, options.logger);
  await repos.threads.setCompacted(thread.id, compactable.at(-1)!.id, summary);
  options.logger?.info("thread compaction complete", {
    threadId: thread.id,
    compactedMessages: compactable.length,
    summaries: l0Summaries.length,
    summaryChars: summary.length,
  });
  return { count: compactable.length, summary };
}

type CompactableMessage = Awaited<ReturnType<Repos["messages"]["listThread"]>>[number];

async function prepareMessagesForCompaction(
  repos: Repos,
  messages: CompactableMessage[],
  options: CaptionOptions,
): Promise<CompactableMessage[]> {
  const prepared: CompactableMessage[] = [];
  for (const message of messages) {
    if (message.kind !== "image") {
      prepared.push(message);
      continue;
    }
    prepared.push(await prepareImageMessageForCompaction(repos, message, options));
  }
  return prepared;
}

async function prepareImageMessageForCompaction(
  repos: Repos,
  message: CompactableMessage,
  options: CaptionOptions,
): Promise<CompactableMessage> {
  const images = (await repos.files.listForMessage(message.id)).filter((file) => file.type === "image");
  if (!images.length) return message;
  const descriptions: string[] = [];
  for (const image of images) {
    const description = await ensureImageDescription(repos, image, options);
    descriptions.push(`[image #${message.id}: ${description}]`);
  }
  const text = stripImageCards(message.text_plain);
  return {
    ...message,
    text_plain: [text, ...descriptions].filter(Boolean).join("\n"),
  };
}

async function ensureImageDescription(
  repos: Repos,
  image: FileRow,
  options: CaptionOptions,
): Promise<string> {
  const existing = usableImageSummary(image);
  if (existing) {
    options.logger?.debug("image compaction using existing description", { fileId: image.id });
    return existing;
  }
  if (!options.imageCaptioner) {
    options.logger?.debug("image compaction skipped; no captioner", { fileId: image.id });
    return image.name;
  }
  try {
    options.logger?.debug("image compaction description starting", { fileId: image.id, path: image.path });
    const bytes = await fs.readFile(image.path);
    const caption = await options.imageCaptioner.caption({
      bytes,
      name: image.name,
      mime: imageMediaTypeFromName(image.name),
    });
    const generated = usableImageDescription(shortImageDescription(caption), image.name);
    if (!generated) return image.name;
    const description = generated;
    await repos.files.updateSummary(image.id, description);
    options.logger?.info("image compaction description stored", { fileId: image.id, chars: description.length });
    return description;
  } catch (err) {
    options.logger?.warn("image description during compaction failed", { err: String(err), fileId: image.id, path: image.path });
    return image.name;
  }
}

function usableImageSummary(image: FileRow): string | undefined {
  return usableImageDescription(image.summary, image.name);
}

function usableImageDescription(text: string | null | undefined, imageName: string): string | undefined {
  const summary = text?.replace(/\s+/g, " ").trim();
  if (!summary) return undefined;
  if (/^\[image,\s*no vision model:/i.test(summary)) return undefined;
  const wrapped = summary.match(/^\[image:\s*(.+)]$/i)?.[1]?.trim();
  if (wrapped && wrapped === imageName) return undefined;
  return wrapped || summary;
}

function shortImageDescription(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "image";
  return oneLine.length > IMAGE_DESCRIPTION_CHAR_CAP
    ? `${oneLine.slice(0, IMAGE_DESCRIPTION_CHAR_CAP - 3)}...`
    : oneLine;
}

function stripImageCards(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[image #\d+:.+\]$/i.test(line))
    .join("\n");
}

function groupByTokenBudget(messages: CompactableMessage[], tokenBudget: number): CompactableMessage[][] {
  const groups: CompactableMessage[][] = [];
  let current: CompactableMessage[] = [];
  let tokens = 0;
  for (const message of messages) {
    const nextTokens = estimateTokens(message.text_plain);
    if (current.length && tokens + nextTokens > tokenBudget) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(message);
    tokens += nextTokens;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function summarizeGroup(messages: CompactableMessage[], summarizer?: ConversationSummarizer, logger?: Logger): Promise<string> {
  if (summarizer) {
    try {
      return await summarizer.summarizeSegment({ messages });
    } catch (err) {
      logger?.warn("segment summarizer failed; using fallback", { err: String(err) });
    }
  }
  return fallbackSummarizeGroup(messages);
}

function fallbackSummarizeGroup(messages: CompactableMessage[]): string {
  const body = messages
    .map((message) => formatMessageLine(message, FALLBACK_MESSAGE_CHAR_CAP))
    .join("\n");
  return body.length > FALLBACK_SEGMENT_CHAR_CAP ? `${body.slice(0, FALLBACK_SEGMENT_CHAR_CAP)}...` : body;
}

async function mergeMeta(
  previous: string | null,
  additions: string[],
  summarizer?: ConversationSummarizer,
  logger?: Logger,
): Promise<string> {
  if (summarizer) {
    try {
      return await summarizer.mergeMeta({ previous, summaries: additions });
    } catch (err) {
      logger?.warn("meta summarizer failed; using fallback", { err: String(err) });
    }
  }
  return fallbackMergeMeta(previous, additions);
}

function fallbackMergeMeta(previous: string | null, additions: string[]): string {
  const merged = [additions.join("\n\n"), previous ?? ""].filter((part) => part.trim()).join("\n\nPrevious memory:\n");
  return merged.length > META_SUMMARY_CHAR_CAP ? merged.slice(0, META_SUMMARY_CHAR_CAP) : merged;
}
