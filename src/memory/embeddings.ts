import type { AppConfig } from "../config.js";
import type { EmbeddingsRepo, EmbeddingKind } from "../db/repos/embeddings.js";
import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";
import { embed as openRouterEmbed } from "../ai/provider.js";

export interface TextEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  model?: string;
}

export function createOpenRouterTextEmbedder(config: AppConfig): TextEmbedder {
  return {
    model: config.OPENROUTER_EMBEDDING_MODEL,
    embed: (texts) => openRouterEmbed(texts, config),
  };
}

export async function persistEmbedding(input: {
  repos: Repos;
  kind: EmbeddingKind;
  refId: number;
  text: string;
  embedder?: TextEmbedder;
  embeddingModel?: string;
  logger?: Logger;
}): Promise<void> {
  await persistEmbeddingWithRepo({
    embeddings: input.repos.embeddings,
    kind: input.kind,
    refId: input.refId,
    text: input.text,
    embedder: input.embedder,
    embeddingModel: input.embeddingModel ?? input.embedder?.model,
    logger: input.logger,
  });
}

export async function persistEmbeddingWithRepo(input: {
  embeddings: EmbeddingsRepo;
  kind: EmbeddingKind;
  refId: number;
  text: string;
  embedder?: TextEmbedder;
  embeddingModel?: string;
  logger?: Logger;
}): Promise<void> {
  if (!input.embedder || !input.text.trim()) return;
  try {
    const [vector] = await input.embedder.embed([input.text]);
    if (vector) await input.embeddings.upsert(input.kind, input.refId, vector, input.embeddingModel ?? input.embedder.model ?? null);
  } catch (err) {
    input.logger?.warn("embedding persistence failed", {
      kind: input.kind,
      refId: input.refId,
      err: String(err),
    });
  }
}
