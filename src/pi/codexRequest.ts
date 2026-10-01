import { normalizeContext, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { raceWithAbort } from "../files/cancel.js";
import { asRecord } from "../util/records.js";
import type { PiProviderRouter } from "./provider.js";
import { ProviderUsageCapture } from "./providerUsage.js";

export interface CodexRequestRuntime {
  config: AppConfig;
  modelRegistry: ModelRegistry;
  providerRouter: PiProviderRouter;
}

// Use Pi's authenticated transport and message conversion for hosted operations too.
export async function requestCodex(
  runtime: CodexRequestRuntime,
  request: {
    kind: "main" | "helper";
    context: Context;
    signal?: AbortSignal;
    sessionId?: string;
    source?: string;
    headers?: Record<string, string>;
    reasoning?: SimpleStreamOptions["reasoning"];
    onResponse?: SimpleStreamOptions["onResponse"];
    patch: (body: Record<string, unknown>) => Record<string, unknown>;
  },
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(runtime.config.PI_REQUEST_TIMEOUT_MS),
    ...(request.signal ? [request.signal] : []),
  ]);
  signal.throwIfAborted();
  const model = runtime.providerRouter.codexModel(request.kind);
  const auth = await raceWithAbort(Promise.resolve().then(() => runtime.modelRegistry.getApiKeyAndHeaders(model)), signal);
  if (!auth.ok || !auth.apiKey) throw new Error("Codex OAuth is unavailable.");
  const items = new Map<string | number, Record<string, unknown>>();
  let completed = false;
  const usage = new ProviderUsageCapture(model.provider, model.id, {
    fastMode: runtime.config.CODEX_FAST_MODE,
    ...(runtime.config.CODEX_FAST_MODE ? { requestedServiceTier: "priority" } : {}),
    source: request.source ?? "hosted",
  });
  const stream = streamSimple(model, normalizeContext(request.context), {
    apiKey: auth.apiKey,
    headers: { ...auth.headers, ...request.headers },
    signal,
    transport: "sse",
    sessionId: request.sessionId,
    timeoutMs: runtime.config.PI_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    reasoning: request.reasoning ?? "low",
    onResponse: request.onResponse,
    onPayload: payload => request.patch({
      ...asRecord(payload),
      ...(runtime.config.CODEX_FAST_MODE ? { service_tier: "priority" } : {}),
    }),
    onProviderStreamEvent: data => {
      usage.observe(data);
      const event = asRecord(data);
      if (event?.type === "response.output_item.done") {
        const item = asRecord(event.item);
        if (item) items.set(typeof item.id === "string" ? item.id : Number(event.output_index), item);
      }
      if (event?.type === "response.completed") {
        completed = true;
        const output = asRecord(event.response)?.output;
        if (Array.isArray(output) && output.length) {
          items.clear();
          output.forEach((item, index) => { const record = asRecord(item); if (record) items.set(index, record); });
        }
      }
    },
  });
  try {
    const message = await raceWithAbort(stream.result(), signal);
    usage.record(message);
    signal.throwIfAborted();
    if (message.stopReason === "error" || message.stopReason === "aborted" || !completed) {
      throw new Error(message.errorMessage || "Codex response did not complete.");
    }
    return { output: [...items.values()], message };
  } finally {
    usage.record();
  }
}
