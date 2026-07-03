import type { AppConfig } from "../config.js";
import type { EmbeddingKind } from "../db/repos/embeddings.js";
import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";
import { embed as openRouterEmbed } from "../ai/provider.js";

export interface TextEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  model?: string;
}

export function createOpenRouterTextEmbedder(config: AppConfig, logger?: Logger): TextEmbedder {
  return {
    model: config.OPENROUTER_EMBEDDING_MODEL,
    embed: (texts) => openRouterEmbed(texts, config, logger),
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
  if (!input.embedder || !input.text.trim()) {
    input.logger?.debug("embedding persistence skipped", {
      kind: input.kind,
      refId: input.refId,
      hasEmbedder: Boolean(input.embedder),
      hasText: Boolean(input.text.trim()),
    });
    return;
  }
  const model = input.embeddingModel ?? input.embedder.model ?? null;
  try {
    input.logger?.debug("embedding persistence starting", {
      kind: input.kind,
      refId: input.refId,
      chars: input.text.length,
      model,
    });
    const [vector] = await input.embedder.embed([input.text]);
    if (vector) {
      await input.repos.embeddings.upsert(input.kind, input.refId, vector, model);
      input.logger?.debug("embedding persistence complete", {
        kind: input.kind,
        refId: input.refId,
        dimensions: vector.length,
      });
    } else {
      input.logger?.warn("embedding provider returned no vector", { kind: input.kind, refId: input.refId });
    }
  } catch (err) {
    input.logger?.warn("embedding persistence failed", {
      kind: input.kind,
      refId: input.refId,
      err: String(err),
    });
  }
}
