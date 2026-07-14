import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

export const EMBEDDING_BATCH_SIZE = 96;
export const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

/** OpenRouter vector backend owned by the Pi retrieval extension. */
export async function embedForRetrieval(
  texts: string[],
  config: AppConfig,
  logger?: Logger,
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  logger?.debug("embedding request starting", {
    texts: texts.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    model: config.OPENROUTER_EMBEDDING_MODEL,
  });
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const input = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const response = await retryFetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.OPENROUTER_EMBEDDING_MODEL, input }),
    }, 3, logger, "OpenRouter embeddings");
    if (!response.ok) {
      const body = await response.clone().text().catch(() => "");
      logger?.warn("OpenRouter embeddings non-ok response", {
        status: response.status,
        body,
      });
      throw new Error(`OpenRouter embeddings failed with HTTP ${response.status}.`);
    }
    const json = await response.json() as { data?: Array<{ embedding: number[] }> };
    const rows = json.data ?? [];
    if (rows.length !== input.length) {
      throw new Error(`OpenRouter embeddings returned ${rows.length} vectors for ${input.length} inputs.`);
    }
    for (const row of rows) vectors.push(new Float32Array(row.embedding));
  }
  logger?.debug("embedding request complete", {
    texts: texts.length,
    vectors: vectors.length,
    model: config.OPENROUTER_EMBEDDING_MODEL,
  });
  return vectors;
}

async function retryFetch(
  url: string,
  init: RequestInit,
  attempts: number,
  logger?: Logger,
  label = "HTTP request",
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Embedding request aborted", "AbortError");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(new DOMException(`${label} timed out after ${EMBEDDING_REQUEST_TIMEOUT_MS} ms`, "TimeoutError"));
    }, EMBEDDING_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status !== 429 && response.status < 500) return response;
      const body = attempt === attempts - 1 ? await response.text().catch(() => "") : "";
      lastError = new Error(`${label} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
      if (attempt < attempts - 1) {
        logger?.warn("HTTP request will retry", { label, status: response.status, attempt: attempt + 1, attempts });
      }
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      lastError = error;
      if (attempt < attempts - 1) {
        logger?.warn("HTTP request failed; retrying", { label, error: String(error), attempt: attempt + 1, attempts });
      }
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", forwardAbort);
    }
    if (attempt < attempts - 1) {
      await abortableDelay(250 * 2 ** attempt, init.signal);
    }
  }
  throw lastError;
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Embedding request aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Embedding request aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
