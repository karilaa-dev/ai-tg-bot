import type { Repos } from "../db/repos/index.js";
import { cosine, type EmbeddingKind } from "../db/repos/embeddings.js";
import type { TextSearch } from "../db/search.js";
import type { FileRow, ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";

const vectorCacheMax = 10_000;
const vectorCache = new Map<string, Float32Array>();

export type RetrievalHit =
  | { kind: "message"; ref_id: number; snippet: string; score: number }
  | { kind: "summary"; ref_id: number; snippet: string; score: number }
  | { kind: "chunk"; ref_id: number; snippet: string; score: number };

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  model?: string;
}

export async function hybridSearch(input: {
  search: TextSearch;
  repos?: Repos;
  threadIds: number[];
  messageIds?: number[];
  summaryIds?: number[];
  fileIds?: number[];
  query: string;
  k: number;
  embedder?: Embedder;
  embeddingModel?: string;
  logger?: Logger;
}): Promise<RetrievalHit[]> {
  input.logger?.debug("hybrid search starting", {
    threadIds: input.threadIds.length,
    messageScope: input.messageIds?.length ?? null,
    summaryScope: input.summaryIds?.length ?? null,
    fileScope: input.fileIds?.length ?? null,
    queryChars: input.query.length,
    limit: input.k,
    hasEmbedder: Boolean(input.embedder && input.repos),
  });
  const ranked = new Map<string, RetrievalHit>();
  const allowedMessages = input.messageIds ? new Set(input.messageIds) : undefined;
  const allowedSummaries = input.summaryIds ? new Set(input.summaryIds) : undefined;
  const add = (kind: RetrievalHit["kind"], refId: number, snippet: string, rank: number) => {
    const key = `${kind}:${refId}`;
    const existing = ranked.get(key);
    const score = (existing?.score ?? 0) + 1 / (60 + rank);
    ranked.set(key, { kind, ref_id: refId, snippet: existing?.snippet ?? snippet, score } as RetrievalHit);
  };

  const scopedLimit = Math.max(input.k, 1000);
  const [messages, summaries, chunks] = await Promise.all([
    input.search.searchMessages(input.threadIds, input.query, allowedMessages ? scopedLimit : input.k),
    input.search.searchSummaries(input.threadIds, input.query, allowedSummaries ? scopedLimit : input.k),
    input.fileIds?.length ? input.search.searchChunks(input.fileIds, input.query, input.k) : Promise.resolve([]),
  ]);
  input.logger?.debug("hybrid lexical search complete", {
    messages: messages.length,
    summaries: summaries.length,
    chunks: chunks.length,
  });
  messages
    .filter((hit) => !allowedMessages || allowedMessages.has(hit.id))
    .slice(0, input.k)
    .forEach((hit, idx) => add("message", hit.id, hit.snippet, idx));
  summaries
    .filter((hit) => !allowedSummaries || allowedSummaries.has(hit.id))
    .slice(0, input.k)
    .forEach((hit, idx) => add("summary", hit.id, hit.snippet, idx));
  chunks.forEach((hit, idx) => add("chunk", hit.id, hit.snippet, idx));

  if (input.embedder && input.repos) {
    input.logger?.debug("hybrid vector search starting", {
      model: input.embeddingModel ?? input.embedder.model ?? null,
    });
    const [queryVector] = await input.embedder.embed([input.query]);
    if (queryVector) {
      await addEmbeddingHits({
        repos: input.repos,
        threadIds: input.threadIds,
        messageIds: input.messageIds,
        summaryIds: input.summaryIds,
        fileIds: input.fileIds,
        queryVector,
        embeddingModel: input.embeddingModel ?? input.embedder.model,
        add,
      });
    } else {
      input.logger?.warn("hybrid vector search skipped; embedder returned no query vector");
    }
  }

  const results = [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, input.k);
  input.logger?.debug("hybrid search complete", { results: results.length });
  return results;
}

export async function threadChainIds(repos: Repos, thread: ThreadRow): Promise<number[]> {
  return (await repos.threads.chain(thread)).map((row) => row.id);
}

export async function threadChainScope(repos: Repos, thread: ThreadRow): Promise<{
  threadIds: number[];
  messageIds: number[];
  summaryIds: number[];
  fileIds: number[];
}> {
  const chain = await repos.threads.chain(thread);
  const threadIds = chain.map((row) => row.id);
  const messages = await repos.messages.listForThreadChainSearchScope(chain);
  const messageIds = messages.map((row) => row.id);
  const messageIdSet = new Set(messageIds);
  const summaries = await repos.summaries.listForThreads(threadIds);
  const summaryIds = summaries.filter((summary) => summaryWithinChain(summary.thread_id, summary.to_message_id, chain)).map((row) => row.id);
  const attachedFiles = await repos.files.listForMessages(messageIds);
  const legacyFiles = await repos.files.listForThreads(threadIds);
  const fileIds = [
    ...new Set([
      ...attachedFiles.map((file) => file.id),
      ...legacyFiles
        .filter((file) => file.message_id === null || messageIdSet.has(file.message_id))
        .map((file) => file.id),
    ]),
  ];
  return { threadIds, messageIds, summaryIds, fileIds };
}

function summaryWithinChain(threadId: number, toMessageId: number, chain: ThreadRow[]): boolean {
  const index = chain.findIndex((thread) => thread.id === threadId);
  if (index === -1) return false;
  const child = chain[index + 1];
  return !(child?.parent_thread_id === threadId && child.fork_point_message_id !== null && toMessageId > child.fork_point_message_id);
}

async function addEmbeddingHits(input: {
  repos: Repos;
  threadIds: number[];
  messageIds?: number[];
  summaryIds?: number[];
  fileIds?: number[];
  queryVector: Float32Array;
  embeddingModel?: string;
  add: (kind: RetrievalHit["kind"], refId: number, snippet: string, rank: number) => void;
}): Promise<void> {
  const [messageIds, summaryRows, fileRows] = await Promise.all([
    input.messageIds ? Promise.resolve(input.messageIds) : input.repos.messages.idsForThreads(input.threadIds),
    input.repos.summaries.listForThreads(input.threadIds),
    input.fileIds?.length ? Promise.resolve([] as FileRow[]) : input.repos.files.listForThreads(input.threadIds),
  ]);
  const summaries = input.summaryIds ? summaryRows.filter((row) => input.summaryIds!.includes(row.id)) : summaryRows;
  const fileIds = input.fileIds ?? fileRows.map((file) => file.id);
  const chunkRows = fileIds.length ? await input.repos.files.chunksForFiles(fileIds) : [];
  const candidates: Array<{
    kind: EmbeddingKind;
    hitKind: RetrievalHit["kind"];
    refIds: number[];
    snippetById: Map<number, string>;
  }> = [
    { kind: "message", hitKind: "message", refIds: messageIds, snippetById: await input.repos.messages.snippets(messageIds) },
    {
      kind: "summary",
      hitKind: "summary",
      refIds: summaries.map((row) => row.id),
      snippetById: new Map(summaries.map((row) => [row.id, row.content.slice(0, 240)])),
    },
    {
      kind: "chunk",
      hitKind: "chunk",
      refIds: chunkRows.map((row) => row.id),
      snippetById: new Map(chunkRows.map((row) => [row.id, row.content.slice(0, 240)])),
    },
  ];
  for (const candidate of candidates) {
    const vectors = await cachedVectors(input.repos, candidate.kind, candidate.refIds, input.embeddingModel);
    vectors
      .map((row) => ({
        refId: row.ref_id,
        score: cosine(input.queryVector, row.decoded),
        snippet: candidate.snippetById.get(row.ref_id) ?? "",
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .forEach((hit, idx) => {
        if (hit.score > 0) input.add(candidate.hitKind, hit.refId, hit.snippet, idx);
      });
  }
}

async function cachedVectors(
  repos: Repos,
  kind: EmbeddingKind,
  refIds: number[],
  embeddingModel?: string,
): Promise<Array<{ ref_id: number; decoded: Float32Array }>> {
  if (!refIds.length) return [];
  const result: Array<{ ref_id: number; decoded: Float32Array }> = [];
  const missing: number[] = [];
  for (const refId of refIds) {
    const key = vectorCacheKey(kind, refId, embeddingModel);
    const cached = vectorCache.get(key);
    if (cached) {
      vectorCache.delete(key);
      vectorCache.set(key, cached);
      result.push({ ref_id: refId, decoded: cached });
    } else {
      missing.push(refId);
    }
  }
  if (missing.length) {
    const loaded = await repos.embeddings.list(kind, missing, embeddingModel);
    for (const row of loaded) {
      rememberVector(kind, row.ref_id, row.decoded, embeddingModel);
      result.push({ ref_id: row.ref_id, decoded: row.decoded });
    }
  }
  return result;
}

function rememberVector(kind: EmbeddingKind, refId: number, vector: Float32Array, embeddingModel?: string): void {
  const key = vectorCacheKey(kind, refId, embeddingModel);
  if (vectorCache.has(key)) vectorCache.delete(key);
  vectorCache.set(key, vector);
  while (vectorCache.size > vectorCacheMax) {
    const oldest = vectorCache.keys().next().value;
    if (oldest === undefined) break;
    vectorCache.delete(oldest);
  }
}

function vectorCacheKey(kind: EmbeddingKind, refId: number, embeddingModel?: string): string {
  return `${embeddingModel ?? "*"}:${kind}:${refId}`;
}

export function clearRetrievalVectorCacheForTests(): void {
  vectorCache.clear();
}
