import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { embedForRetrieval } from "../pi/retrievalExtension.js";

export interface TextEmbedder {
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  model?: string;
}

export function createOpenRouterTextEmbedder(config: AppConfig, logger?: Logger): TextEmbedder {
  return {
    model: config.OPENROUTER_EMBEDDING_MODEL,
    embed: (texts, signal) => embedForRetrieval(texts, config, logger, signal),
  };
}
