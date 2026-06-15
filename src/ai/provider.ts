import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type LanguageModel } from "ai";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ConversationSummarizer } from "../memory/compactor.js";

let cachedBudget: { model: string; value: number; at: number } | undefined;

export interface ImageCaptioner {
  caption(input: { bytes: Buffer; name: string; mime?: string }): Promise<string>;
}

export function chatModel(config: AppConfig): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY });
  return openrouter.chat(config.OPENROUTER_MODEL);
}

export function compactionModel(config: AppConfig): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY });
  return openrouter.chat(config.OPENROUTER_COMPACTION_MODEL);
}

export function providerOptions(config: AppConfig): any {
  if (config.OPENROUTER_REASONING_EFFORT === "none") return undefined;
  return {
    openrouter: {
      reasoning: { effort: config.OPENROUTER_REASONING_EFFORT },
    },
  };
}

export async function embed(texts: string[], config: AppConfig, logger?: Logger): Promise<Float32Array[]> {
  const batches: Float32Array[] = [];
  logger?.debug("embedding request starting", {
    texts: texts.length,
    chars: texts.reduce((sum, text) => sum + text.length, 0),
    model: config.OPENROUTER_EMBEDDING_MODEL,
  });
  for (let i = 0; i < texts.length; i += 96) {
    const input = texts.slice(i, i + 96);
    const res = await retryFetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.OPENROUTER_EMBEDDING_MODEL, input }),
    }, 3, logger, "openrouter embeddings");
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    for (const row of json.data ?? []) batches.push(new Float32Array(row.embedding));
  }
  logger?.debug("embedding request complete", {
    texts: texts.length,
    vectors: batches.length,
    model: config.OPENROUTER_EMBEDDING_MODEL,
  });
  return batches;
}

export function createOpenRouterImageCaptioner(config: AppConfig, logger?: Logger): ImageCaptioner {
  return {
    caption: async ({ bytes, name, mime }) => {
      try {
        logger?.debug("image description starting", { name, bytes: bytes.length, mime: mime ?? imageMediaType(name) });
        const result = await generateText({
          model: chatModel(config),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image in 1-2 concise sentences for later recall." },
                { type: "image", image: bytes, mediaType: mime ?? imageMediaType(name) },
              ],
            },
          ],
          providerOptions: { openrouter: { reasoning: { effort: "none" } } },
          abortSignal: AbortSignal.timeout(60_000),
        });
        const text = result.text.trim() || `[image: ${name}]`;
        logger?.debug("image description complete", { name, chars: text.length });
        return text;
      } catch (err) {
        logger?.warn("image description failed", { err: String(err), name });
        return `[image, no vision model: ${name}]`;
      }
    },
  };
}

export function createOpenRouterConversationSummarizer(config: AppConfig, logger?: Logger): ConversationSummarizer {
  return {
    summarizeSegment: async ({ messages }) => {
      logger?.debug("segment summarization starting", {
        messages: messages.length,
        model: config.OPENROUTER_COMPACTION_MODEL,
      });
      const result = await generateText({
        model: compactionModel(config),
        system:
          "Summarize this Telegram conversation segment. Keep decisions, facts, names, numbers, file references (#file-id), open questions, and image descriptions. Cite source message ids like [#123]. Stay under 300 words.",
        prompt: messages.map(formatMessageForSummary).join("\n"),
        providerOptions: { openrouter: { reasoning: { effort: "none" } } },
        abortSignal: AbortSignal.timeout(120_000),
      });
      const text = result.text.trim();
      if (!text) throw new Error("empty segment summary");
      logger?.debug("segment summarization complete", { messages: messages.length, chars: text.length });
      return text;
    },
    mergeMeta: async ({ previous, summaries }) => {
      logger?.debug("meta summary merge starting", {
        summaries: summaries.length,
        previousChars: previous?.length ?? 0,
        model: config.OPENROUTER_COMPACTION_MODEL,
      });
      const result = await generateText({
        model: compactionModel(config),
        system:
          "Merge conversation memory into one rolling summary, most-recent-relevant first. Keep durable facts, decisions, file references, image descriptions, and open questions. Stay under 400 words.",
        prompt: [
          previous ? `Previous memory:\n${previous}` : "Previous memory: none",
          `New segment summaries:\n${summaries.join("\n\n")}`,
        ].join("\n\n"),
        providerOptions: { openrouter: { reasoning: { effort: "none" } } },
        abortSignal: AbortSignal.timeout(120_000),
      });
      const text = result.text.trim();
      if (!text) throw new Error("empty merged summary");
      logger?.info("conversation memory summarized", { summaries: summaries.length, chars: text.length });
      return text;
    },
  };
}

export async function getContextBudget(config: AppConfig, logger?: Logger): Promise<number> {
  if (config.MODEL_CONTEXT_TOKENS_OVERRIDE) {
    logger?.debug("context budget using override", {
      model: config.OPENROUTER_MODEL,
      tokens: config.MODEL_CONTEXT_TOKENS_OVERRIDE,
    });
    return config.MODEL_CONTEXT_TOKENS_OVERRIDE;
  }
  const day = 24 * 60 * 60 * 1000;
  if (cachedBudget && cachedBudget.model === config.OPENROUTER_MODEL && Date.now() - cachedBudget.at < day) {
    logger?.debug("context budget cache hit", { model: config.OPENROUTER_MODEL, tokens: cachedBudget.value });
    return cachedBudget.value;
  }
  try {
    logger?.debug("context budget fetch starting", { model: config.OPENROUTER_MODEL });
    const res = await retryFetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
    }, 3, logger, "openrouter models");
    const json = (await res.json()) as {
      data?: Array<{ id: string; context_length?: number | null; top_provider?: { context_length?: number | null } }>;
    };
    const model = json.data?.find((entry) => entry.id === config.OPENROUTER_MODEL);
    const value = model?.context_length ?? model?.top_provider?.context_length ?? 128000;
    cachedBudget = { model: config.OPENROUTER_MODEL, value, at: Date.now() };
    logger?.debug("context budget fetch complete", { model: config.OPENROUTER_MODEL, tokens: value });
    return value;
  } catch (err) {
    logger?.warn("failed to fetch OpenRouter model context length", { err: String(err) });
    return 128000;
  }
}

function formatMessageForSummary(message: {
  id: number;
  role: string;
  kind: string;
  text_plain: string;
}): string {
  const text = message.text_plain.replace(/\s+/g, " ").slice(0, 1200);
  return `[#${message.id} ${message.role}] ${text}`;
}

function imageMediaType(name: string): string | undefined {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return undefined;
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
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** i));
  }
  throw last;
}
