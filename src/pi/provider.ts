import {
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenRouter } from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CodexCircuitBreaker, resetAtFromHeaders, retryableCodexError } from "./circuit.js";

export const TELEGRAM_AUTO_PROVIDER = "telegram-auto";
export const TELEGRAM_MAIN_MODEL = "main";
export const TELEGRAM_HELPER_MODEL = "helper";

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
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => lazyStream(selected, async () => {
    const kind = selected.id === TELEGRAM_HELPER_MODEL ? "helper" : "main";
    return routeStream({
      config: input.config,
      registry: input.modelRegistry,
      logger: input.logger,
      circuit,
      codex: codexModels[kind],
      openRouter: openRouterModels[kind],
      context,
      options,
      streamCodex: input.streams?.codex ?? streamCodex,
      streamOpenRouter: input.streams?.openRouter ?? streamOpenRouter,
    });
  });

  input.modelRegistry.registerProvider(TELEGRAM_AUTO_PROVIDER, {
    name: "Telegram automatic Codex/OpenRouter",
    api: "telegram-auto",
    baseUrl: "internal://telegram-auto",
    apiKey: input.config.OPENROUTER_API_KEY,
    streamSimple,
    models: [mainModel, helperModel].map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });

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
  context: Context;
  options?: SimpleStreamOptions;
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
  let circuitSettled = false;
  const recordSuccess = () => {
    if (circuitSettled) return;
    circuitSettled = true;
    input.circuit.recordSuccess();
  };
  const recordFailure = () => {
    if (circuitSettled) return;
    circuitSettled = true;
    input.circuit.recordFailure(resetAt);
  };
  const buffered: AssistantMessageEvent[] = [];
  try {
    const auth = await input.registry.getApiKeyAndHeaders(input.codex);
    if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Missing openai-codex OAuth token" : auth.error);
    const stream = input.streamCodex(input.codex, input.context, {
      ...input.options,
      apiKey: auth.apiKey,
      headers: { ...auth.headers, ...input.options?.headers },
      timeoutMs: input.config.PI_TURN_TIMEOUT_MS || undefined,
      maxRetries: 0,
      onResponse: async (response, model) => {
        status = response.status;
        resetAt = resetAtFromHeaders(response.headers);
        await input.options?.onResponse?.(response, model);
      },
    });
    for await (const event of stream) {
      if (!emitted && event.type === "error") {
        const message = event.error.errorMessage;
        if (retryableCodexError({ status, message })) {
          recordFailure();
          input.logger?.warn("Codex provider failed before output; falling back to OpenRouter", {
            status,
            error: message,
            openRouterModel: input.openRouter.id,
          });
          yield* openRouterEvents(input);
          return;
        }
        recordSuccess();
        emitted = true;
        for (const pending of buffered) yield pending;
        yield event;
        continue;
      }
      if (emitted && event.type === "error") {
        const message = event.error.errorMessage;
        if (retryableCodexError({ status, message })) recordFailure();
        else recordSuccess();
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
      if (event.type === "done") recordSuccess();
    }
    if (!emitted) {
      for (const pending of buffered) yield pending;
    }
    recordSuccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = retryableCodexError({ status, message });
    if (retryable) recordFailure();
    else recordSuccess();
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
    if (attempt.probe && input.circuit.state().probeActive) input.circuit.releaseProbe();
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
  context: Context;
  options?: SimpleStreamOptions;
  streamOpenRouter: typeof streamOpenRouter;
}): AsyncGenerator<AssistantMessageEvent> {
  const stream = input.streamOpenRouter(input.openRouter, input.context, {
    ...input.options,
    apiKey: input.config.OPENROUTER_API_KEY,
    timeoutMs: input.config.PI_TURN_TIMEOUT_MS || undefined,
    maxRetries: 2,
  });
  for await (const event of stream) yield event;
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
  if (found?.api === "openai-completions") return { ...found, contextWindow } as Model<"openai-completions">;
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
    },
  };
}
