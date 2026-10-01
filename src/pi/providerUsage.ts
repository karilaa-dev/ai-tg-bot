import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { asRecord } from "../util/records.js";
import { recordInferenceUsage, type InferenceUsageMetadata } from "./usage.js";

/** Captures one provider attempt, including usage on responses the SDK rejects. */
export class ProviderUsageCapture {
  private rawUsage?: Usage;
  private rawCostReported = false;
  private metadata: InferenceUsageMetadata;
  private responseModel?: string;
  private recorded = false;

  constructor(private readonly provider: string, private readonly model: string, metadata: InferenceUsageMetadata) {
    this.metadata = { ...metadata };
  }

  observe(data: unknown): void {
    const event = asRecord(data);
    if (!event) return;
    if (typeof event.type === "string" && event.type.startsWith("response.")
      && !["response.completed", "response.done", "response.incomplete", "response.failed"].includes(event.type)) return;
    const response = asRecord(event.response) ?? event;
    const serviceTier = response.service_tier;
    if (typeof serviceTier === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(serviceTier)) this.metadata.serviceTier = serviceTier;
    if (typeof response.model === "string" && response.model.length <= 256) this.responseModel = response.model;
    const parsed = normalizeProviderUsage(response.usage);
    if (parsed) {
      this.rawUsage = parsed.usage;
      this.rawCostReported = parsed.costReported;
      this.metadata.cacheReadReported = parsed.cacheReadReported;
      this.metadata.cacheWriteReported = parsed.cacheWriteReported;
    }
  }

  record(message?: AssistantMessage): Usage | undefined {
    if (this.recorded) return this.rawUsage ?? message?.usage;
    this.recorded = true;
    if (!message && !this.rawUsage) return undefined;
    const sameCounts = message && this.rawUsage && (["input", "output", "cacheRead", "cacheWrite"] as const)
      .every(key => message.usage[key] === this.rawUsage![key]);
    const usage = this.rawUsage
      ? { ...this.rawUsage, ...(sameCounts && !this.rawCostReported ? { cost: message.usage.cost } : {}) }
      : message!.usage;
    if (message) {
      message.usage = usage;
      if (this.responseModel) message.responseModel = this.responseModel;
    }
    recordInferenceUsage(message ?? {
      provider: this.provider,
      model: this.model,
      ...(this.responseModel ? { responseModel: this.responseModel } : {}),
      usage,
    }, this.metadata);
    return usage;
  }
}

export function normalizeProviderUsage(value: unknown): {
  usage: Usage;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
  costReported: boolean;
} | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const inputDetails = asRecord(raw.input_tokens_details) ?? asRecord(raw.prompt_tokens_details);
  const outputDetails = asRecord(raw.output_tokens_details) ?? asRecord(raw.completion_tokens_details);
  const cacheCreation = asRecord(raw.cache_creation);
  const read = tokenCount(inputDetails?.cached_tokens, raw.prompt_cache_hit_tokens, raw.cached_tokens, raw.cache_read_input_tokens);
  const write = tokenCount(inputDetails?.cache_write_tokens, raw.cache_creation_input_tokens);
  const input = tokenCount(raw.input_tokens, raw.prompt_tokens);
  const output = tokenCount(raw.output_tokens, raw.completion_tokens);
  if (input === undefined && output === undefined && read === undefined && write === undefined) return undefined;
  const cacheRead = read ?? 0;
  const cacheWrite = write ?? 0;
  // Anthropic's native counters exclude cached input; OpenAI/OpenRouter's input
  // totals include it. The provider's cache buckets remain disjoint in Pi.
  const nativeAnthropic = "input_tokens" in raw && !("prompt_tokens" in raw) && !("input_tokens_details" in raw)
    && ("cache_read_input_tokens" in raw || "cache_creation_input_tokens" in raw);
  const freshInput = nativeAnthropic
    ? input ?? 0
    : Math.max(0, (input ?? 0) - cacheRead - cacheWrite);
  const reasoning = tokenCount(outputDetails?.reasoning_tokens);
  const cacheWrite1h = tokenCount(cacheCreation?.ephemeral_1h_input_tokens, inputDetails?.cache_write_tokens_1h);
  const reportedCost = typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : undefined;
  return {
    usage: {
      input: freshInput,
      output: output ?? 0,
      cacheRead,
      cacheWrite,
      totalTokens: freshInput + (output ?? 0) + cacheRead + cacheWrite,
      ...(reasoning === undefined ? {} : { reasoning: Math.min(reasoning, output ?? 0) }),
      ...(cacheWrite1h === undefined ? {} : { cacheWrite1h: Math.min(cacheWrite1h, cacheWrite) }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reportedCost ?? 0 },
    },
    cacheReadReported: read !== undefined,
    cacheWriteReported: write !== undefined,
    costReported: reportedCost !== undefined,
  };
}

function tokenCount(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
