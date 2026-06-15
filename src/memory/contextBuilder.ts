import fs from "node:fs/promises";
import type { ModelMessage } from "ai";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { TextSearch } from "../db/search.js";
import type { MessageRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { renderSystemPrompt } from "../ai/prompt.js";
import { embed, getContextBudget } from "../ai/provider.js";
import { hybridSearch, threadChainScope } from "./retrieval.js";
import { estimateTokens } from "./tokens.js";

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  tokensEst: number;
  overBudget: boolean;
}

export async function buildContext(input: {
  config: AppConfig;
  repos: Repos;
  search: TextSearch;
  user: UserRow;
  thread: ThreadRow;
  newUserText: string;
  logger?: Logger;
}): Promise<BuiltContext> {
  const threadChain = await input.repos.threads.chain(input.thread);
  const scope = await threadChainScope(input.repos, input.thread);
  const filesOverview = await buildFilesOverview(input.repos, scope.threadIds, scope.fileIds);
  const memoryBlocks = await buildMemoryBlocks(input, threadChain, scope);
  const systemBase = await renderSystemPrompt({
    user: input.user,
    thread: input.thread,
    filesOverview,
  });
  const system = [systemBase, ...memoryBlocks].filter(Boolean).join("\n\n");
  const rows = await input.repos.messages.listForThreadChain(threadChain);
  const messages: ModelMessage[] = [];
  for (const row of rows) {
    messages.push(await toModelMessage(input.repos, row, input.logger));
  }
  const latest = rows.at(-1);
  if (!(latest?.role === "user" && latest.text_plain === input.newUserText)) {
    messages.push({ role: "user", content: input.newUserText });
  }
  const estimate = estimateMessageTokens(system, messages);
  const tokensEst = estimate.tokens + estimate.images * 1100;
  const budget = await getContextBudget(input.config, input.logger);
  const usable = (budget - input.config.RESERVE_OUTPUT_TOKENS) * input.config.CONTEXT_WARN_RATIO;
  return { system, messages, tokensEst, overBudget: tokensEst > usable };
}

async function toModelMessage(repos: Repos, row: MessageRow, logger?: Logger): Promise<ModelMessage> {
  const role = row.role === "assistant" ? "assistant" : row.role === "system" ? "system" : "user";
  if (role !== "user" || row.kind !== "image") {
    return { role, content: row.text_plain } as ModelMessage;
  }
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string }> = [
    { type: "text", text: row.text_plain },
  ];
  for (const file of await repos.files.listForMessage(row.id)) {
    if (file.type !== "image") continue;
    try {
      parts.push({ type: "image", image: await fs.readFile(file.path), mediaType: imageMediaType(file.name) });
    } catch (err) {
      logger?.warn("failed to attach image to model context", { err: String(err), fileId: file.id, path: file.path });
    }
  }
  return { role: "user", content: parts } as ModelMessage;
}

function imageMediaType(name: string): string | undefined {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return undefined;
}

function estimateMessageTokens(system: string, messages: ModelMessage[]): { tokens: number; images: number } {
  const textParts = [system];
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      textParts.push(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") textParts.push(part.text);
        if (part.type === "image") images += 1;
      }
    }
  }
  return { tokens: estimateTokens(textParts.join("\n\n")), images };
}

async function buildFilesOverview(repos: Repos, threadIds: number[], fileIds: number[]): Promise<string> {
  const allowed = new Set(fileIds);
  const files = (await repos.files.listByIds(fileIds)).filter((file) => allowed.has(file.id));
  if (!files.length) return "- none";
  return files
    .map((file) => {
      const mode = file.is_inline ? "inline" : "searchable";
      const summary = file.summary?.split("\n")[0] ?? "";
      return `- #${file.id} ${file.name} ${file.type} · ${mode}${summary ? ` · ${summary}` : ""}`;
    })
    .join("\n");
}

async function buildMemoryBlocks(input: {
  config: AppConfig;
  repos: Repos;
  search: TextSearch;
  thread: ThreadRow;
  newUserText: string;
  logger?: Logger;
}, threadChain: ThreadRow[], scope: Awaited<ReturnType<typeof threadChainScope>>): Promise<string[]> {
  const threadIds = scope.threadIds;
  const scopeSummaryIds = new Set(scope.summaryIds);
  const summaries = (await input.repos.summaries.listForThreads(threadIds, 0)).filter((summary) => scopeSummaryIds.has(summary.id));
  const blocks: string[] = [];
  const meta = threadChain
    .filter((thread) => thread.meta_summary?.trim())
    .map((thread) => `Conversation memory for "${thread.title}":\n${thread.meta_summary}`)
    .join("\n\n");
  if (meta || summaries.length) {
    const index = summaries
      .map((summary) => `[msgs ${summary.from_message_id}-${summary.to_message_id}] ${firstSentence(summary.content)}`)
      .join("\n");
    blocks.push(`Conversation memory (compacted):\n${meta || "No rolling summary yet."}${index ? `\n\nSection index:\n${index}` : ""}`);
  }

  const hasCompaction = threadChain.some((thread) => thread.compacted_upto_message_id !== null);
  const scopedFileIds = new Set(scope.fileIds);
  const files = (await input.repos.files.listByIds(scope.fileIds)).filter((file) => scopedFileIds.has(file.id));
  const hasSearchableFiles = files.some((file) => !file.is_inline);
  if (hasCompaction || hasSearchableFiles) {
    try {
      const hits = await hybridSearch({
        search: input.search,
        repos: input.repos,
        threadIds: scope.threadIds,
        messageIds: scope.messageIds,
        summaryIds: scope.summaryIds,
        fileIds: scope.fileIds,
        query: input.newUserText,
        k: 6,
        embedder: { embed: (texts) => embed(texts, input.config) },
        embeddingModel: input.config.OPENROUTER_EMBEDDING_MODEL,
      });
      if (hits.length) {
        blocks.push(
          `Recalled context (verify with load_message/read_file_section):\n${hits
            .map((hit) => `- [${hit.kind} #${hit.ref_id}] ${hit.snippet}`)
            .join("\n")}`,
        );
      }
    } catch (err) {
      input.logger?.warn("auto-rag failed", { err: String(err) });
    }
  }
  return blocks;
}

function firstSentence(text: string): string {
  const match = text.match(/^(.{1,240}?[.!?…])(\s|$)/u);
  return (match?.[1] ?? text.slice(0, 180)).replace(/\s+/g, " ");
}
