import type { Repos } from "../db/repos/index.js";
import type { TextSearch } from "../db/search.js";
import type { ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";

const RRF_K = 60;

export type RetrievalHit =
  | { kind: "message"; ref_id: number; snippet: string; score: number }
  | { kind: "chunk"; ref_id: number; snippet: string; score: number };

export async function hybridSearch(input: {
  search: TextSearch;
  repos: Repos;
  threadIds: number[];
  messageIds?: number[];
  fileIds: number[];
  query: string;
  k: number;
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<RetrievalHit[]> {
  input.logger?.debug("hybrid search starting", {
    threadIds: input.threadIds.length,
    messageScope: input.messageIds?.length ?? null,
    fileScope: input.fileIds.length,
    queryChars: input.query.length,
    limit: input.k,
  });
  const ranked = new Map<string, RetrievalHit>();
  const allowedMessages = input.messageIds ? new Set(input.messageIds) : undefined;
  const add = (kind: RetrievalHit["kind"], refId: number, snippet: string, rank: number) => {
    const key = `${kind}:${refId}`;
    const existing = ranked.get(key);
    const score = (existing?.score ?? 0) + 1 / (RRF_K + rank);
    ranked.set(key, { kind, ref_id: refId, snippet: existing?.snippet ?? snippet, score } as RetrievalHit);
  };

  const [messages, chunks] = await Promise.all([
    input.search.searchMessages(input.threadIds, input.query, input.k, input.messageIds),
    input.fileIds.length ? input.search.searchChunks(input.fileIds, input.query, input.k) : Promise.resolve([]),
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

  const results = [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, input.k);
  input.logger?.debug("hybrid search complete", { results: results.length });
  return results;
}

export async function threadChainScope(repos: Repos, thread: ThreadRow, maxMessageId?: number): Promise<{
  threadIds: number[];
  messageIds: number[];
  fileIds: number[];
}> {
  const chain = await repos.threads.chain(thread);
  const threadIds = chain.map((row) => row.id);
  const messages = await repos.messages.listForThreadChainSearchScope(chain, maxMessageId);
  const messageIds = messages.map((row) => row.id);
  const messageIdSet = new Set(messageIds);
  const attachedFiles = await repos.files.listForMessages(messageIds);
  const threadFiles = await repos.files.listForThreads(threadIds);
  const unattachedInboundIds = new Set(maxMessageId === undefined
    ? []
    : await repos.files.listUnattachedInboundIds(
        threadFiles.filter((file) => file.message_id === null).map((file) => file.id),
      ));
  const candidateFileIds = [
    ...new Set([
      ...attachedFiles.map((file) => file.id),
      ...threadFiles
        .filter((file) => file.message_id === null
          ? !unattachedInboundIds.has(file.id)
          : messageIdSet.has(file.message_id))
        .map((file) => file.id),
    ]),
  ];
  const recoverableIds = new Set(await repos.files.listRecoverableIds(candidateFileIds));
  const fileIds = candidateFileIds.filter((fileId) => recoverableIds.has(fileId));
  return { threadIds, messageIds, fileIds };
}

export function clearRetrievalVectorCacheForTests(): void {
  // Retained as a compatibility no-op for callers that used to reset the vector cache.
}
