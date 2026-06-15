import type { Repos } from "../db/repos/index.js";
import type { ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { persistEmbedding, type TextEmbedder } from "./embeddings.js";
import { estimateTokens } from "./tokens.js";

export interface ConversationSummarizer {
  summarizeSegment(input: { messages: CompactableMessage[] }): Promise<string>;
  mergeMeta(input: { previous: string | null; summaries: string[] }): Promise<string>;
}

export async function compactThread(
  repos: Repos,
  thread: ThreadRow,
  options: { recentWindowMessages?: number; embedder?: TextEmbedder; summarizer?: ConversationSummarizer; logger?: Logger } = {},
): Promise<{ count: number; summary: string }> {
  const chain = await repos.threads.chain(thread);
  const messages = await repos.messages.listForThreadChain(chain);
  const keep = options.recentWindowMessages ?? 20;
  const compactable = messages.slice(0, Math.max(0, messages.length - keep));
  if (compactable.length < 10) return { count: 0, summary: thread.meta_summary ?? "" };

  const groups = groupByTokenBudget(compactable, 3500);
  const l0Summaries = [];
  for (const group of groups) {
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
  return { count: compactable.length, summary };
}

type CompactableMessage = Awaited<ReturnType<Repos["messages"]["listThread"]>>[number];

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
    .map((message) => {
      const imageCaption = message.kind === "image" ? `[image #${message.id}: ${message.text_plain.replace(/^\[image:\s*|\]$/g, "")}]` : "";
      const text = imageCaption || message.text_plain.replace(/\s+/g, " ").slice(0, 500);
      return `[#${message.id} ${message.role}] ${text}`;
    })
    .join("\n");
  return body.length > 1800 ? `${body.slice(0, 1800)}...` : body;
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
  return merged.length > 2400 ? merged.slice(0, 2400) : merged;
}
