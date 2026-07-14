import type { Repos } from "../db/repos/index.js";
import { cosine, type EmbeddingKind } from "../db/repos/embeddings.js";
import type { TextSearch } from "../db/search.js";
import type { FileRow, ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { TextEmbedder } from "./embeddings.js";

const vectorCacheMax = 10_000;
const vectorCache = new Map<string, Float32Array>();

const RRF_K = 60;
const SCOPED_LEXICAL_FETCH_LIMIT = 1000;
const VECTOR_TOP_K = 20;

export type RetrievalHit =
  | { kind: "message"; ref_id: number; snippet: string; score: number }
  | { kind: "chunk"; ref_id: number; snippet: string; score: number };

export async function hybridSearch(input: {
  search: TextSearch;
  repos?: Repos;
  threadIds: number[];
  messageIds?: number[];
  fileIds?: number[];
  query: string;
  k: number;
  embedder?: TextEmbedder;
  embeddingModel?: string;
  logger?: Logger;
}): Promise<RetrievalHit[]> {
  input.logger?.debug("hybrid search starting", {
    threadIds: input.threadIds.length,
    messageScope: input.messageIds?.length ?? null,
    fileScope: input.fileIds?.length ?? null,
    queryChars: input.query.length,
    limit: input.k,
    hasEmbedder: Boolean(input.embedder && input.repos),
  });
  const ranked = new Map<string, RetrievalHit>();
  const allowedMessages = input.messageIds ? new Set(input.messageIds) : undefined;
  const add = (kind: RetrievalHit["kind"], refId: number, snippet: string, rank: number) => {
    const key = `${kind}:${refId}`;
    const existing = ranked.get(key);
    const score = (existing?.score ?? 0) + 1 / (RRF_K + rank);
    ranked.set(key, { kind, ref_id: refId, snippet: existing?.snippet ?? snippet, score } as RetrievalHit);
  };

  const scopedLimit = Math.max(input.k, SCOPED_LEXICAL_FETCH_LIMIT);
  const [messages, chunks] = await Promise.all([
    input.search.searchMessages(input.threadIds, input.query, allowedMessages ? scopedLimit : input.k),
    input.fileIds?.length ? input.search.searchChunks(input.fileIds, input.query, input.k) : Promise.resolve([]),
  ]);
  input.logger?.debug("hybrid lexical search complete", {
    messages: messages.length,
    chunks: chunks.length,
  });
  messages
    .filter((hit) => !allowedMessages || allowedMessages.has(hit.id))
    .slice(0, input.k)
    .forEach((hit, idx) => add("message", hit.id, hit.snippet, idx));
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

export async function threadChainScope(repos: Repos, thread: ThreadRow): Promise<{
  threadIds: number[];
  messageIds: number[];
  fileIds: number[];
}> {
  const chain = await repos.threads.chain(thread);
  const threadIds = chain.map((row) => row.id);
  const messages = await repos.messages.listForThreadChainSearchScope(chain);
  const messageIds = messages.map((row) => row.id);
  const messageIdSet = new Set(messageIds);
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
  return { threadIds, messageIds, fileIds };
}

async function addEmbeddingHits(input: {
  repos: Repos;
  threadIds: number[];
  messageIds?: number[];
  fileIds?: number[];
  queryVector: Float32Array;
  embeddingModel?: string;
  add: (kind: RetrievalHit["kind"], refId: number, snippet: string, rank: number) => void;
}): Promise<void> {
  const [messageIds, fileRows] = await Promise.all([
    input.messageIds ? Promise.resolve(input.messageIds) : input.repos.messages.idsForThreads(input.threadIds),
    input.fileIds !== undefined ? Promise.resolve([] as FileRow[]) : input.repos.files.listForThreads(input.threadIds),
  ]);
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
      .slice(0, VECTOR_TOP_K)
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
