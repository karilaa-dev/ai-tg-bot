import {
  createAssistantMessageEventStream,
  type Api,
  normalizeContext,
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { loadTestConfig, type AppConfig } from "../../src/config.js";
import {
  registerPiProviderRouter,
  type PiProviderStreamOverrides,
} from "../../src/pi/provider.js";
import { CodexCircuitBreaker } from "../../src/pi/circuit.js";

describe("Pi automatic provider", () => {
  it("keeps provider deadlines independent of the overall turn limit", async () => {
    const harness = providerHarness({ codexError: "quota exhausted", config: { PI_TURN_TIMEOUT_MS: 0, PI_REQUEST_TIMEOUT_MS: 42_000 } });
    await harness.run();
    expect(harness.requestOptions.map((options) => options.timeoutMs)).toEqual([42_000, 42_000]);
  });

  it("aborts a stalled Codex request and falls back within an unlimited turn", async () => {
    vi.useFakeTimers();
    try {
      const harness = providerHarness({ codexStall: true, config: { PI_REQUEST_TIMEOUT_MS: 1000 } });
      const execution = harness.run();
      await vi.advanceTimersByTimeAsync(1000);
      expect(textDeltas(await execution)).toBe("openrouter answer");
      expect(harness.calls).toEqual(["codex", "openrouter"]);
      expect(harness.requestOptions[0]!.signal!.aborted).toBe(true);
      expect(harness.router.circuit.state().open).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["codex", "openrouter"] as const)("bounds a stalled %s response body after partial output", async (provider) => {
    vi.useFakeTimers();
    try {
      const harness = providerHarness({
        codexConfigured: provider === "codex", codexStall: true, codexPartial: "partial", openRouterStall: true,
        config: { PI_REQUEST_TIMEOUT_MS: 1000 },
      });
      const execution = harness.run();
      await vi.advanceTimersByTimeAsync(1000);
      const events = await execution;
      expect(harness.calls).toEqual([provider]);
      expect(textDeltas(events)).toBe("partial");
      expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringContaining("timed out") } });
      expect(harness.requestOptions[0]!.signal!.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled request promptly without starting fallback", async () => {
    const harness = providerHarness({ codexStall: true });
    const controller = new AbortController();
    const execution = harness.run("main", controller.signal);
    await vi.waitFor(() => expect(harness.calls).toEqual(["codex"]));
    controller.abort();
    expect((await execution).at(-1)).toMatchObject({ type: "error", error: { errorMessage: "Request was aborted" } });
    expect(harness.calls).toEqual(["codex"]);
    expect(harness.requestOptions[0]!.signal!.aborted).toBe(true);
  });

  it("injects the selected full model name on every request without changing history", async () => {
    const harness = providerHarness({ codexConfigured: true });
    await harness.run("main");
    await harness.run("main");
    await harness.run("helper");
    expect(harness.contexts.map((context) => getCurrentSystemPrompt(context.messages))).toEqual([
      "Core\n\nModel: GPT-6.1 Sol", "Core\n\nModel: GPT-6.1 Sol", "Core\n\nModel: GPT-6 Luna",
    ]);
    expect(harness.context).toEqual(normalizeContext({ systemPrompt: "Core", messages: [] }));
  });

  it("uses the actual configured fallback identity after a primary failure and for helper requests", async () => {
    const harness = providerHarness({ codexError: "quota exhausted", models: {
      CODEX_MODEL: "gpt-6-astra-custom", OPENROUTER_MAIN_MODEL: "vendor/other-model-v2",
      OPENROUTER_HELPER_MODEL: "openai/gpt-5.6-terra",
    } });
    await harness.run();
    await harness.run("helper");
    expect(harness.contexts.map((context) => getCurrentSystemPrompt(context.messages))).toEqual([
      "Core\n\nModel: GPT-6 Astra Custom", "Core\n\nModel: other-model-v2", "Core\n\nModel: GPT-5.6 Terra",
    ]);
    expect(harness.contexts.every((context) => !/provider:|Model: (main|helper)/u.test(getCurrentSystemPrompt(context.messages)!))).toBe(true);
    expect(getCurrentSystemPrompt(harness.context.messages)).toBe("Core");
  });

  it("preserves transcript prompt updates and tool changes across fallback", async () => {
    const initialTool = { name: "old_tool", description: "Original tool", parameters: { type: "object" } };
    const currentTool = { name: "current_tool", description: "Current tool", parameters: { type: "object" } };
    const context = normalizeContext({ messages: [
      { role: "system", content: [{ type: "text", text: "Core" }], sections: { policy: "Initial policy" }, toolsAdded: [initialTool], timestamp: 0 },
      { role: "user", content: "First turn", timestamp: 1 },
      { role: "system", content: "Updated instructions", sections: { policy: "Current policy" }, toolsRemoved: [{ name: "old_tool" }], toolsAdded: [currentTool], timestamp: 2 },
      { role: "user", content: "Next turn", timestamp: 3 },
    ] });
    const original = structuredClone(context);
    const harness = providerHarness({ codexError: "quota exhausted", context });

    await harness.run();

    expect(harness.contexts).toHaveLength(2);
    for (const request of harness.contexts) {
      expect(getCurrentSystemPrompt(request.messages)).toBe("Core\n\nModel: GPT-6.1 Sol\n\nUpdated instructions\n\nCurrent policy");
      expect(getCurrentTools(request.messages)).toEqual([currentTool]);
      expect(request.messages.slice(1)).toEqual(original.messages.slice(1));
    }
    expect(context).toEqual(original);
  });

  it("uses Codex exclusively while its OAuth and provider are available", async () => {
    const harness = providerHarness({ codexConfigured: true });
    const mainEvents = await harness.run("main");
    const helperEvents = await harness.run("helper");

    expect(harness.calls).toEqual(["codex", "codex"]);
    expect(textDeltas(mainEvents)).toBe("codex answer");
    expect(textDeltas(helperEvents)).toBe("codex answer");
    expect(harness.streamOptions).toEqual([
      { provider: "codex", sessionId: "opaque-pi-session" },
      { provider: "codex", sessionId: "opaque-pi-session" },
    ]);
    expect(harness.router.circuit.state().open).toBe(false);
  });

  it("uses OpenRouter only when Codex OAuth is not configured", async () => {
    const harness = providerHarness({ codexConfigured: false });
    const events = await harness.run();

    expect(harness.calls).toEqual(["openrouter"]);
    expect(textDeltas(events)).toBe("openrouter answer");
    expect(harness.router.mainModel.contextWindow).toBe(128_000);
    expect(harness.router.openRouterModel("main").compat).toMatchObject({
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
    expect(harness.streamOptions).toEqual([
      { provider: "openrouter", sessionId: "opaque-pi-session" },
    ]);
  });

  it("falls back before output for quota and OAuth refresh failures", async () => {
    const quota = providerHarness({ codexError: "quota exhausted" });
    expect(textDeltas(await quota.run())).toBe("openrouter answer");
    expect(quota.calls).toEqual(["codex", "openrouter"]);
    expect(quota.streamOptions).toEqual([
      { provider: "codex", sessionId: "opaque-pi-session" },
      { provider: "openrouter", sessionId: "opaque-pi-session" },
    ]);
    expect(quota.router.circuit.state().open).toBe(true);

    const auth = providerHarness({ authError: "OAuth refresh token failed" });
    expect(textDeltas(await auth.run())).toBe("openrouter answer");
    expect(auth.calls).toEqual(["openrouter"]);
  });

  it("does not fall back for context errors, aborts, or failures after partial output", async () => {
    const context = providerHarness({ codexError: "context window maximum tokens exceeded" });
    await context.run();
    expect(context.calls).toEqual(["codex"]);
    expect(context.router.circuit.state().open).toBe(false);

    const aborted = providerHarness({ codexError: "AbortError: operation aborted" });
    await aborted.run();
    expect(aborted.calls).toEqual(["codex"]);

    const partial = providerHarness({ codexError: "quota exhausted", codexPartial: "partial" });
    const events = await partial.run();
    expect(partial.calls).toEqual(["codex"]);
    expect(textDeltas(events)).toBe("partial");
    expect(partial.router.circuit.state().open).toBe(true);
  });

  it("closes a half-open circuit after a definitive non-retryable response", async () => {
    let now = 10_000;
    const circuit = new CodexCircuitBreaker(() => now);
    circuit.recordFailure();
    now += 30 * 60_000;
    const harness = providerHarness({
      codexError: "invalid request",
      circuit,
    });

    await harness.run();
    expect(harness.calls).toEqual(["codex"]);
    expect(circuit.state().open).toBe(false);
  });

  it("preserves discovered OpenRouter compatibility while enabling opaque affinity", () => {
    const harness = providerHarness({
      discoveredOpenRouterCompat: {
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
      },
    });

    expect(harness.router.openRouterModel("main").compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
  });
});

function providerHarness(input: {
  config?: Partial<AppConfig>;
  context?: TranscriptContext;
  models?: Record<string, string>;
  codexConfigured?: boolean;
  codexError?: string;
  codexPartial?: string;
  codexStall?: boolean;
  openRouterStall?: boolean;
  authError?: string;
  circuit?: CodexCircuitBreaker;
  discoveredOpenRouterCompat?: Model<"openai-completions">["compat"];
}) {
  const calls: string[] = [];
  const contexts: TranscriptContext[] = [];
  const context = input.context ?? normalizeContext({ systemPrompt: "Core", messages: [] });
  const streamOptions: Array<{ provider: string; sessionId: string | undefined }> = [];
  const requestOptions: Array<{ timeoutMs?: number; signal?: AbortSignal }> = [];
  let registered: {
    streamSimple: (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) => AsyncIterable<AssistantMessageEvent>;
  } | undefined;
  const registry = {
    find: (provider: string, id: string) => provider === "openrouter" && input.discoveredOpenRouterCompat
      ? {
          id,
          name: id,
          api: "openai-completions",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64_000,
          maxTokens: 8_000,
          compat: input.discoveredOpenRouterCompat,
        }
      : undefined,
    registerProvider: (_name: string, provider: typeof registered) => { registered = provider; },
    hasConfiguredAuth: () => input.codexConfigured ?? true,
    getApiKeyAndHeaders: async () => input.authError
      ? { ok: false as const, error: input.authError }
      : { ok: true as const, apiKey: "codex-token", headers: {} },
  };
  const streams: PiProviderStreamOverrides = {
    codex: ((model, context, options) => {
      contexts.push(context);
      calls.push("codex");
      streamOptions.push({ provider: "codex", sessionId: options?.sessionId });
      requestOptions.push({ timeoutMs: options?.timeoutMs, signal: options?.signal });
      if (input.codexStall) return stalledStream(model, input.codexPartial);
      if (input.codexPartial) {
        return eventStream(model, input.codexPartial, input.codexError);
      }
      return input.codexError ? errorStream(model, input.codexError) : eventStream(model, "codex answer");
    }) as PiProviderStreamOverrides["codex"],
    openRouter: ((model, context, options) => {
      contexts.push(context);
      calls.push("openrouter");
      streamOptions.push({ provider: "openrouter", sessionId: options?.sessionId });
      requestOptions.push({ timeoutMs: options?.timeoutMs, signal: options?.signal });
      if (input.openRouterStall) return stalledStream(model, "partial");
      return eventStream(model, "openrouter answer");
    }) as PiProviderStreamOverrides["openRouter"],
  };
  const router = registerPiProviderRouter({
    config: loadTestConfig({ ...input.models, ...input.config }),
    modelRegistry: registry as never,
    circuit: input.circuit,
    streams,
  });
  return {
    calls,
    context,
    contexts,
    streamOptions,
    requestOptions,
    router,
    run: async (kind: "main" | "helper" = "main", signal?: AbortSignal) => {
      if (!registered) throw new Error("provider was not registered");
      const events: AssistantMessageEvent[] = [];
      const model = kind === "helper" ? router.helperModel : router.mainModel;
      for await (const event of registered.streamSimple(
        model,
        context,
        { sessionId: "opaque-pi-session", signal },
      )) events.push(event);
      return events;
    },
  };
}

function stalledStream(model: Model<Api>, text?: string) {
  // Deliberately ignores cancellation to verify the router releases the queue.
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: assistant(model, "", "stop") });
  if (text) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant(model, text, "stop") });
  return stream;
}

function eventStream(model: Model<Api>, text: string, trailingError?: string) {
  const stream = createAssistantMessageEventStream();
  const partial = assistant(model, "", "stop");
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant(model, text, "stop") });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant(model, text, "stop") });
  if (trailingError) stream.push({ type: "error", reason: "error", error: assistant(model, text, "error", trailingError) });
  else stream.push({ type: "done", reason: "stop", message: assistant(model, text, "stop") });
  return stream;
}

function errorStream(model: Model<Api>, error: string) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: assistant(model, "", "error", error) });
  return stream;
}

function assistant(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function textDeltas(events: AssistantMessageEvent[]): string {
  return events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []).join("");
}
