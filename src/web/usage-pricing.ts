import type { InferenceUsageCall } from "../pi/usage.js";

export const PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const MAX_PRICING_BYTES = 16 * 1024 * 1024;
export type PricingCatalog = Record<string, Record<string, unknown>>;

/** ccusage's token calculation method. Rates are USD per token, not per million.
 * https://ccusage.com/guide/cost-modes
 * Pi input excludes cache reads/writes; reasoning is already part of output.
 */
export function estimateCallCost(call: InferenceUsageCall, catalog: PricingCatalog, perCall = true): number | null {
  const model = call.model.replace(/^openrouter\//, "").replace(/^openai-codex\//, "");
  const provider = call.provider === "openai-codex" ? "openai" : call.provider;
  const bare = model.replace(/^(openai|anthropic|google)\//, "");
  const keys = [`${provider}/${model}`, model];
  if (["openai", "openrouter", "anthropic", "google"].includes(provider)) keys.push(bare, bare.replace(/(\d)\.(\d)/g, "$1-$2"));
  const rates = keys.map(key => Object.hasOwn(catalog, key) ? catalog[key] : undefined).find(Boolean);
  if (rates) {
    const prompt = call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens;
    // Old records are turn aggregates, so their sum is not a context-window size.
    const thresholds = perCall ? Object.keys(rates).flatMap(key => {
      const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
      return match && prompt > Number(match[1]) * 1000 ? [Number(match[1])] : [];
    }) : [];
    const suffix = thresholds.length ? `_above_${Math.max(...thresholds)}k_tokens` : "";
    const rate = (key: string) => finiteRate(rates[`${key}${suffix}`]) ?? finiteRate(rates[key]);
    const longWrite = call.cacheWrite1hTokens ?? 0;
    const anthropic = provider === "anthropic" || model.startsWith("anthropic/") || bare.startsWith("claude-");
    const longWriteKey = "cache_creation_input_token_cost_above_1hr";
    const longRate = finiteRate(rates[`${longWriteKey}${suffix}`])
      // A base one-hour rate must not override the active long-context tier.
      ?? (anthropic ? multiply(rate("input_cost_per_token"), 2) : finiteRate(rates[longWriteKey]));
    const parts = [
      charge(call.inputTokens, rate("input_cost_per_token")),
      charge(call.outputTokens, rate("output_cost_per_token")),
      charge(call.cacheReadTokens, rate("cache_read_input_token_cost")),
      charge(call.cacheWriteTokens - longWrite, rate("cache_creation_input_token_cost")),
      charge(longWrite, longRate),
    ];
    if (parts.every((part): part is number => part !== null)) return parts.reduce((sum, part) => sum + part, 0);
  }
  // Router placeholders use zero rates. Never mistake those for free inference.
  const recorded = call.cost;
  if (recorded && [recorded.input, recorded.output, recorded.cacheRead, recorded.cacheWrite, recorded.total]
    .every(value => finiteRate(value) !== null) && recorded.total > 0) return recorded.total;
  return call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheWriteTokens === 0 ? 0 : null;
}

function finiteRate(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function charge(tokens: number, rate: number | null): number | null { return tokens === 0 ? 0 : rate === null ? null : tokens * rate; }
function multiply(rate: number | null, factor: number): number | null { return rate === null ? null : rate * factor; }

/** One shared daily fetch, retaining the last good catalog during outages. */
export class UsagePricing {
  private catalog: PricingCatalog = {};
  private fetchedAt: number | null = null;
  private retryAt = 0;
  private pending?: Promise<void>;
  constructor(private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch, private readonly now: () => number = Date.now) {}

  async load() {
    if (this.now() >= this.retryAt) {
      this.pending ??= this.refresh().finally(() => { this.pending = undefined; });
      await this.pending;
    }
    return { catalog: this.catalog, source: "LiteLLM" as const, fetchedAt: this.fetchedAt,
      stale: this.fetchedAt === null || this.now() - this.fetchedAt >= 86_400_000 };
  }

  private async refresh() {
    try {
      const response = await this.fetcher(PRICING_URL, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("Pricing download failed");
      const value: unknown = await readPricingJson(response);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pricing catalog");
      const catalog: PricingCatalog = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => {
        const rates = entry[1];
        return rates !== null && typeof rates === "object" && !Array.isArray(rates)
          && finiteRate(rates.input_cost_per_token) !== null && finiteRate(rates.output_cost_per_token) !== null;
      }));
      if (!Object.keys(catalog).length) throw new Error("Empty pricing catalog");
      this.catalog = catalog;
      this.fetchedAt = this.now();
      this.retryAt = this.fetchedAt + 86_400_000;
    } catch {
      this.retryAt = this.now() + 300_000;
    }
  }
}

export const usagePricing = new UsagePricing();

async function readPricingJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_PRICING_BYTES) {
    await response.body?.cancel();
    throw new Error("Pricing catalog exceeds size limit");
  }
  if (!response.body) throw new Error("Empty pricing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PRICING_BYTES) throw new Error("Pricing catalog exceeds size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}
