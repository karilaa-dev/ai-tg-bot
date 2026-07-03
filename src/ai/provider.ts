import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

const DEFAULT_CODEX_CONTEXT_TOKENS = 128000;

export const EMBEDDING_BATCH_SIZE = 96;

export interface ImageCaptioner {
  caption(input: { bytes: Buffer; name: string; mime?: string }): Promise<string>;
}

export async function embed(texts: string[], config: AppConfig, logger?: Logger): Promise<Float32Array[]> {
  const batches: Float32Array[] = [];
  logger?.debug("embedding request starting", {
    texts: texts.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    model: config.OPENROUTER_EMBEDDING_MODEL,
  });
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const input = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const res = await retryFetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.OPENROUTER_EMBEDDING_MODEL, input }),
    }, 3, logger, "openrouter embeddings");
    if (!res.ok) {
      logger?.warn("openrouter embeddings non-ok response", {
        status: res.status,
        body: await res.clone().text().catch(() => ""),
      });
    }
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    if ((json.data?.length ?? 0) < input.length) {
      logger?.warn("openrouter embeddings returned fewer vectors than inputs", {
        expected: input.length,
        received: json.data?.length ?? 0,
      });
    }
    for (const row of json.data ?? []) batches.push(new Float32Array(row.embedding));
  }
  logger?.debug("embedding request complete", {
    texts: texts.length,
    vectors: batches.length,
    model: config.OPENROUTER_EMBEDDING_MODEL,
  });
  return batches;
}

export async function getContextBudget(config: AppConfig, logger?: Logger): Promise<number> {
  logger?.debug("context budget using Codex default", {
    model: config.CODEX_MODEL,
    tokens: DEFAULT_CODEX_CONTEXT_TOKENS,
  });
  return DEFAULT_CODEX_CONTEXT_TOKENS;
}

async function retryFetch(
  url: string,
  init: RequestInit,
  attempts = 3,
  logger?: Logger,
  label = "http request",
): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
      if (i < attempts - 1) {
        logger?.warn("http request will retry", { label, status: res.status, attempt: i + 1, attempts });
      }
    } catch (err) {
      last = err;
      if (i < attempts - 1) {
        logger?.warn("http request failed; retrying", { label, err: String(err), attempt: i + 1, attempts });
      }
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** i));
    }
  }
  throw last;
}
