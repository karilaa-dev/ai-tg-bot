import type { Repos } from "../db/repos/index.js";
import type { TextSearch } from "../db/search.js";
import { messageSearchScopesForChain } from "../db/repos/messages.js";
import type { MessageSearchScope } from "../db/search.js";
import type { ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";

const RRF_K = 60;

type RetrievalHit =
  | { kind: "message"; ref_id: number; snippet: string; score: number }
  | { kind: "chunk"; ref_id: number; snippet: string; score: number };

export async function hybridSearch(input: {
  search: TextSearch;
  repos: Repos;
  threadIds: number[];
  messageScopes?: MessageSearchScope[];
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
    input.search.searchMessages(input.threadIds, input.query, input.k, input.messageScopes),
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

export type ThreadScope = {
  threadIds: number[];
  messageScopes: MessageSearchScope[];
  messageIds: number[];
  fileIds: number[];
};

export async function threadChainScope(repos: Repos, thread: ThreadRow, maxMessageId?: number): Promise<ThreadScope> {
  const scope = await threadVisibilityScope(repos, thread, maxMessageId);
  return { ...scope, fileIds: await repos.files.listRecoverableIds(scope.fileIds) };
}

export async function threadVisibilityScope(repos: Repos, thread: ThreadRow, maxMessageId?: number): Promise<ThreadScope> {
  const chain = await repos.threads.chain(thread);
  const threadIds = chain.map((row) => row.id);
  const messageScopes = messageSearchScopesForChain(chain, maxMessageId);
  const [messageIds, fileIds] = await Promise.all([
    repos.messages.listIdsForScopes(messageScopes),
    repos.files.listVisibleIds(messageScopes, maxMessageId === undefined),
  ]);
  return { threadIds, messageScopes, messageIds, fileIds };
}
