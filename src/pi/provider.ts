import {
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type TranscriptContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenRouter } from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CodexCircuitBreaker, resetAtFromHeaders, retryableCodexError } from "./circuit.js";
import { withModelIdentity } from "./modelIdentity.js";
import { projectCodexCheckpoint } from "./codexCheckpoint.js";
import { ProviderUsageCapture } from "./providerUsage.js";

const TELEGRAM_AUTO_PROVIDER = "telegram-auto";
const TELEGRAM_MAIN_MODEL = "main";
const TELEGRAM_HELPER_MODEL = "helper";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface PiProviderRouter {
  circuit: CodexCircuitBreaker;
  mainModel: Model<Api>;
  helperModel: Model<Api>;
  codexModel(kind: "main" | "helper"): Model<"openai-codex-responses">;
  openRouterModel(kind: "main" | "helper"): Model<"openai-completions">;
  codexConfigured(kind?: "main" | "helper"): boolean;
}

export interface PiProviderStreamOverrides {
  codex?: typeof streamCodex;
  openRouter?: typeof streamOpenRouter;
}

export function registerPiProviderRouter(input: {
  config: AppConfig;
  modelRegistry: ModelRegistry;
  logger?: Logger;
  circuit?: CodexCircuitBreaker;
  streams?: PiProviderStreamOverrides;
}): PiProviderRouter {
  const circuit = input.circuit ?? new CodexCircuitBreaker();
  const mainModel = autoModel(TELEGRAM_MAIN_MODEL, "Telegram main", input.config.MODEL_CONTEXT_TOKENS);
  const helperModel = autoModel(TELEGRAM_HELPER_MODEL, "Telegram helper", input.config.MODEL_CONTEXT_TOKENS);
  const codexModels = {
    main: backendCodexModel(input.modelRegistry, input.config.CODEX_MODEL, input.config.MODEL_CONTEXT_TOKENS),
    helper: backendCodexModel(input.modelRegistry, input.config.CODEX_HELPER_MODEL, input.config.MODEL_CONTEXT_TOKENS),
  };
  const openRouterModels = {
    main: backendOpenRouterModel(input.modelRegistry, input.config.OPENROUTER_MAIN_MODEL, input.config.MODEL_CONTEXT_TOKENS),
    helper: backendOpenRouterModel(input.modelRegistry, input.config.OPENROUTER_HELPER_MODEL, input.config.MODEL_CONTEXT_TOKENS),
  };

  const streamSimple = (
    selected: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => lazyStream(selected, async () => {
    const kind = selected.id === TELEGRAM_HELPER_MODEL || selected.id === "routed-helper" ? "helper" : "main";
    return routeStream({
      config: input.config,
      registry: input.modelRegistry,
      logger: input.logger,
      circuit,
      codex: codexModels[kind],
      openRouter: openRouterModels[kind],
      context,
      options,
      source: kind === "helper" ? "helper" : "assistant",
      streamCodex: input.streams?.codex ?? streamCodex,
      streamOpenRouter: input.streams?.openRouter ?? streamOpenRouter,
    });
  });

  // Pi's automatic compaction uses the physical response model's limits. Keep
  // those catalog entries aligned with the models actually sent by this router.
  for (const models of [codexModels, openRouterModels]) {
    const provider = input.modelRegistry.getProvider(models.main.provider);
    if (!provider) continue;
    const configured = new Map([models.main, models.helper].map(model => [model.id, model]));
    input.modelRegistry.registerProvider({ ...provider, getModels: () => {
      const all = new Map(provider.getModels().map(model => [model.id, model]));
      for (const [id, model] of configured) all.set(id, model);
      return [...all.values()];
    } });
  }

  input.modelRegistry.registerProvider(TELEGRAM_AUTO_PROVIDER, {
    name: "Telegram automatic Codex/OpenRouter",
    api: "telegram-auto",
    baseUrl: "internal://telegram-auto",
    apiKey: input.config.OPENROUTER_API_KEY,
    streamSimple,
    models: [mainModel, helperModel].map((model) => ({
      id: `routed-${model.id}`,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: [...model.input],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });

  // Keep the existing selection ids in saved sessions. A virtual selection lets
  // Pi recognize Codex/OpenRouter errors and run its normal overflow recovery.
  for (const model of [mainModel, helperModel]) {
    input.modelRegistry.registerVirtualModel({
      provider: TELEGRAM_AUTO_PROVIDER, id: model.id, name: model.name,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      route: request => ({ model: input.modelRegistry.find(TELEGRAM_AUTO_PROVIDER, `routed-${model.id}`)!, thinkingLevel: request.thinkingLevel }),
    });
  }

  return {
    circuit,
    mainModel: input.modelRegistry.find(TELEGRAM_AUTO_PROVIDER, TELEGRAM_MAIN_MODEL) ?? mainModel,
    helperModel: input.modelRegistry.find(TELEGRAM_AUTO_PROVIDER, TELEGRAM_HELPER_MODEL) ?? helperModel,
    codexModel: (kind) => codexModels[kind],
    openRouterModel: (kind) => openRouterModels[kind],
    codexConfigured: (kind = "main") => input.modelRegistry.hasConfiguredAuth(codexModels[kind]),
  };
}

async function* routeStream(input: {
  config: AppConfig;
  registry: ModelRegistry;
  logger?: Logger;
  circuit: CodexCircuitBreaker;
  codex: Model<"openai-codex-responses">;
  openRouter: Model<"openai-completions">;
  context: TranscriptContext;
  options?: SimpleStreamOptions;
  source: "assistant" | "helper";
  streamCodex: typeof streamCodex;
  streamOpenRouter: typeof streamOpenRouter;
}): AsyncGenerator<AssistantMessageEvent> {
  if (!input.registry.hasConfiguredAuth(input.codex)) {
    input.logger?.debug("Pi provider routing directly to OpenRouter; Codex is not configured", {
      model: input.openRouter.id,
    });
    yield* openRouterEvents(input);
    return;
  }

  const attempt = input.circuit.acquire();
  if (!attempt.allowed) {
    input.logger?.debug("Pi provider routing to OpenRouter; Codex circuit is open", {
      model: input.openRouter.id,
      retryAt: attempt.retryAt,
    });
    yield* openRouterEvents(input);
    return;
  }

  let status: number | undefined;
  let resetAt: number | undefined;
  let emitted = false;
  const usage = new ProviderUsageCapture(input.codex.provider, input.codex.id, {
    fastMode: input.config.CODEX_FAST_MODE,
    ...(input.config.CODEX_FAST_MODE ? { requestedServiceTier: "priority" } : {}),
    source: input.source,
  });
  const buffered: AssistantMessageEvent[] = [];
  try {
    const auth = await input.registry.getApiKeyAndHeaders(input.codex);
    if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Missing openai-codex OAuth token" : auth.error);
    const projected = projectCodexCheckpoint(input.context, input.codex.id);
    const stream = requestEvents({
      timeoutMs: input.config.PI_REQUEST_TIMEOUT_MS,
      signal: input.options?.signal,
      start: (signal) => input.streamCodex(input.codex, withModelIdentity(projected.context, input.codex), {
        ...input.options,
        signal,
        apiKey: auth.apiKey,
        headers: { ...auth.headers, ...input.options?.headers },
        timeoutMs: input.config.PI_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        onProviderStreamEvent: async (event, model) => {
          usage.observe(event);
          await input.options?.onProviderStreamEvent?.(event, model);
        },
        // Pi's simple stream options do not forward the Codex serviceTier option.
        onPayload: async (payload, model) => {
          const replacement = await input.options?.onPayload?.(payload, model);
          const body = projected.replay(replacement === undefined ? payload : replacement);
          return input.config.CODEX_FAST_MODE && body !== null && typeof body === "object"
            ? { ...body, service_tier: "priority" } : body;
        },
        onResponse: async (response, model) => {
          status = response.status;
          resetAt = resetAtFromHeaders(response.headers);
          await input.options?.onResponse?.(response, model);
        },
      }),
    });
    for await (const event of stream) {
      if (event.type === "done") usage.record(event.message);
      else if (event.type === "error") usage.record(event.error);
      if (!emitted && event.type === "error") {
        const message = event.error.errorMessage;
        if (retryableCodexError({ status, message })) {
          attempt.recordFailure(resetAt);
          input.logger?.warn("Codex provider failed before output; falling back to OpenRouter", {
            status,
            error: message,
            openRouterModel: input.openRouter.id,
          });
          yield* openRouterEvents(input);
          return;
        }
        attempt.recordSuccess();
        emitted = true;
        for (const pending of buffered) yield pending;
        yield event;
        continue;
      }
      if (emitted && event.type === "error") {
        const message = event.error.errorMessage;
        if (retryableCodexError({ status, message })) attempt.recordFailure(resetAt);
        else attempt.recordSuccess();
      }
      if (!emitted && !isMeaningful(event)) {
        buffered.push(event);
        continue;
      }
      if (!emitted) {
        emitted = true;
        for (const pending of buffered) yield pending;
      }
      yield event;
      if (event.type === "done") attempt.recordSuccess();
    }
    if (!emitted) {
      for (const pending of buffered) yield pending;
    }
    attempt.recordSuccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = retryableCodexError({ status, message });
    if (retryable) attempt.recordFailure(resetAt);
    else attempt.recordSuccess();
    if (!emitted && retryable) {
      input.logger?.warn("Codex provider setup failed; falling back to OpenRouter", {
        status,
        error: message,
        openRouterModel: input.openRouter.id,
      });
      yield* openRouterEvents(input);
      return;
    }
    yield { type: "error", reason: "error", error: providerErrorMessage(input.codex, message) };
    return;
  } finally {
    usage.record();
    attempt.release();
  }
}

function providerErrorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { ...ZERO_COST, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

async function* openRouterEvents(input: {
  config: AppConfig;
  openRouter: Model<"openai-completions">;
  context: TranscriptContext;
  options?: SimpleStreamOptions;
  source: "assistant" | "helper";
  streamOpenRouter: typeof streamOpenRouter;
}): AsyncGenerator<AssistantMessageEvent> {
  const usage = new ProviderUsageCapture(input.openRouter.provider, input.openRouter.id, { fastMode: false, source: input.source });
  const stream = requestEvents({
    timeoutMs: input.config.PI_REQUEST_TIMEOUT_MS,
    signal: input.options?.signal,
    start: (signal) => input.streamOpenRouter(input.openRouter, withModelIdentity(input.context, input.openRouter), {
      ...input.options,
      signal,
      apiKey: input.config.OPENROUTER_API_KEY,
      timeoutMs: input.config.PI_REQUEST_TIMEOUT_MS,
      maxRetries: 2,
      onProviderStreamEvent: async (event, model) => {
        usage.observe(event);
        await input.options?.onProviderStreamEvent?.(event, model);
      },
    }),
  });
  try {
    for await (const event of stream) {
      if (event.type === "done") usage.record(event.message);
      else if (event.type === "error") usage.record(event.error);
      yield event;
    }
  } finally {
    usage.record();
  }
}

// Provider SDK timeouts may cover only connection setup. Bound the complete
// streamed request and abort its transport, independently of the turn budget.
async function* requestEvents(input: {
  timeoutMs: number;
  signal?: AbortSignal;
  start: (signal: AbortSignal) => AssistantMessageEventStream;
}): AsyncGenerator<AssistantMessageEvent> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const error = new Error("Request was aborted");
      reject(error);
      controller.abort(error);
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`Provider request timed out after ${input.timeoutMs} ms.`);
      reject(error);
      controller.abort(error);
    }, input.timeoutMs);
  });
  try {
    // Attach the rejection handler before starting a transport that could throw.
    void deadline.catch(() => undefined);
    controller.signal.throwIfAborted();
    iterator = input.start(controller.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    controller.abort();
    // A stalled iterator may take time to react to cancellation. Do not hold the
    // thread queue while waiting for its cleanup.
    if (iterator?.return) void iterator.return().catch(() => undefined);
  }
}

function isMeaningful(event: AssistantMessageEvent): boolean {
  return event.type === "text_delta"
    || event.type === "thinking_delta"
    || event.type === "toolcall_delta"
    || event.type === "toolcall_end"
    || event.type === "done";
}

function autoModel(id: string, name: string, contextWindow: number): Model<Api> {
  return {
    id,
    name,
    api: "telegram-auto",
    provider: TELEGRAM_AUTO_PROVIDER,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    baseUrl: "internal://telegram-auto",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens: Math.min(32_768, Math.max(4096, Math.floor(contextWindow / 4))),
  };
}

function backendCodexModel(
  registry: ModelRegistry,
  configuredId: string,
  contextWindow: number,
): Model<"openai-codex-responses"> {
  const id = configuredId.replace(/^openai-codex\//, "");
  const found = registry.find("openai-codex", id);
  if (found?.api === "openai-codex-responses") return { ...found, contextWindow } as Model<"openai-codex-responses">;
  return {
    id,
    name: id,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens: Math.min(32_768, Math.max(4096, Math.floor(contextWindow / 4))),
  };
}

function backendOpenRouterModel(
  registry: ModelRegistry,
  configuredId: string,
  contextWindow: number,
): Model<"openai-completions"> {
  const id = configuredId.replace(/^openrouter\//, "");
  const found = registry.find("openrouter", id);
  if (found?.api === "openai-completions") {
    return {
      ...found,
      contextWindow,
      compat: {
        ...found.compat,
        sendSessionAffinityHeaders: true,
        sessionAffinityFormat: "openrouter",
      },
    } as Model<"openai-completions">;
  }
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens: Math.min(32_768, Math.max(4096, Math.floor(contextWindow / 4))),
    compat: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      thinkingFormat: "openrouter",
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    },
  };
}
