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
import { zstdDecompressSync } from "node:zlib";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenRouter } from "@earendil-works/pi-ai/api/openai-completions";
import { loadTestConfig, type AppConfig } from "../../src/config.js";
import {
  registerPiProviderRouter,
  type PiProviderStreamOverrides,
} from "../fixtures/pi-v2/provider.js";
import { CodexCircuitBreaker } from "../fixtures/pi-v2/circuit.js";

describe("Pi automatic provider", () => {
  it.each([false, true])("sends the configured fast-mode tier through the real Codex SDK when enabled=%s", async (enabled) => {
    const transport = interceptedSdkTransport();
    const harness = providerHarness({
      config: { CODEX_FAST_MODE: enabled },
      streams: { codex: streamCodex, openRouter: streamOpenRouter },
      apiKey: testCodexToken(),
      options: { transport: "sse", fetch: transport.fetch },
    });
    expect((await harness.run("main")).at(-1)?.type).toBe("done");
    expect((await harness.run("helper")).at(-1)?.type).toBe("done");
    expect(transport.requests.map(request => request.body.model)).toEqual([
      harness.router.codexModel("main").id, harness.router.codexModel("helper").id,
    ]);
    for (const request of transport.requests) {
      expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      if (enabled) expect(request.body).toHaveProperty("service_tier", "priority");
      else expect(request.body).not.toHaveProperty("service_tier");
    }
  });

  it("omits fast mode from real OpenRouter SDK requests after Codex fails and while its circuit is open", async () => {
    const transport = interceptedSdkTransport({ codexFailure: true });
    const harness = providerHarness({
      config: { CODEX_FAST_MODE: true },
      streams: { codex: streamCodex, openRouter: streamOpenRouter },
      apiKey: testCodexToken(),
      options: { transport: "sse", fetch: transport.fetch },
    });
    expect(textDeltas(await harness.run("main"))).toBe("openrouter answer");
    expect(textDeltas(await harness.run("helper"))).toBe("openrouter answer");
    expect(transport.requests.map(request => request.url)).toEqual([
      "https://chatgpt.com/backend-api/codex/responses",
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    expect(transport.requests[0]!.body).toHaveProperty("service_tier", "priority");
    expect(transport.requests[1]!.body).not.toHaveProperty("service_tier");
    expect(transport.requests[2]!.body).not.toHaveProperty("service_tier");
    expect(transport.requests.slice(1).map(request => request.body.model)).toEqual([
      harness.router.openRouterModel("main").id, harness.router.openRouterModel("helper").id,
    ]);
    expect(harness.router.circuit.state().open).toBe(true);
  });

  it("does not carry fast mode into fallback or subsequent requests while the circuit is open", async () => {
    const harness = providerHarness({ codexError: "quota exhausted", config: { CODEX_FAST_MODE: true } });
    await harness.run();
    await harness.run("helper");
    expect(harness.calls).toEqual(["codex", "openrouter", "openrouter"]);
    expect(harness.requestOptions[0]!.onPayload).toBeTypeOf("function");
    expect(harness.requestOptions[1]!.onPayload).toBeUndefined();
    expect(harness.requestOptions[2]!.onPayload).toBeUndefined();
  });

  it.each([{ codexConfigured: false }, { authError: "OAuth refresh token failed" }])(
    "omits fast mode when routing directly to OpenRouter: %j", async (input) => {
      const harness = providerHarness({ ...input, config: { CODEX_FAST_MODE: true } });
      await harness.run();
      expect(harness.calls).toEqual(["openrouter"]);
      expect(harness.requestOptions[0]!.onPayload).toBeUndefined();
    },
  );

  it.each([false, true])("preserves caller payload hooks through fallback, replacement=%s", async (replace) => {
    const onPayload = vi.fn(async (payload: unknown) => {
      if (replace) return { custom: "kept" };
      Object.assign(payload as object, { custom: "kept" });
      return undefined;
    });
    const harness = providerHarness({ codexError: "quota exhausted", config: { CODEX_FAST_MODE: true } });
    await harness.run("main", undefined, onPayload);
    const payload = { model: "test-model" };
    const codexBody = await harness.requestOptions[0]!.onPayload!(payload, harness.router.codexModel("main"));
    expect(codexBody).toEqual({ ...(replace ? {} : { model: "test-model" }), custom: "kept", service_tier: "priority" });
    expect(payload).not.toHaveProperty("service_tier");
    expect(harness.requestOptions[1]!.onPayload).toBe(onPayload);
    const fallbackBody = await harness.requestOptions[1]!.onPayload!(payload, harness.router.openRouterModel("main")) ?? payload;
    expect(fallbackBody).toHaveProperty("custom", "kept");
    expect(fallbackBody).not.toHaveProperty("service_tier");
    expect(onPayload).toHaveBeenCalledTimes(2);
  });

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
  streams?: PiProviderStreamOverrides;
  apiKey?: string;
  options?: SimpleStreamOptions;
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
  const requestOptions: SimpleStreamOptions[] = [];
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
      : { ok: true as const, apiKey: input.apiKey ?? "codex-token", headers: {} },
  };
  const streams: PiProviderStreamOverrides = {
    codex: ((model, context, options) => {
      contexts.push(context);
      calls.push("codex");
      streamOptions.push({ provider: "codex", sessionId: options?.sessionId });
      requestOptions.push(options ?? {});
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
      requestOptions.push(options ?? {});
      if (input.openRouterStall) return stalledStream(model, "partial");
      return eventStream(model, "openrouter answer");
    }) as PiProviderStreamOverrides["openRouter"],
  };
  const router = registerPiProviderRouter({
    config: loadTestConfig({ ...input.models, ...input.config }),
    modelRegistry: registry as never,
    circuit: input.circuit,
    streams: input.streams ?? streams,
  });
  return {
    calls,
    context,
    contexts,
    streamOptions,
    requestOptions,
    router,
    run: async (kind: "main" | "helper" = "main", signal?: AbortSignal, onPayload?: SimpleStreamOptions["onPayload"]) => {
      if (!registered) throw new Error("provider was not registered");
      const events: AssistantMessageEvent[] = [];
      const model = kind === "helper" ? router.helperModel : router.mainModel;
      for await (const event of registered.streamSimple(
        model,
        context,
        { sessionId: "opaque-pi-session", ...input.options, signal, onPayload },
      )) events.push(event);
      return events;
    },
  };
}

function testCodexToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })}.signature`;
}

function interceptedSdkTransport(input: { codexFailure?: boolean } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch: NonNullable<SimpleStreamOptions["fetch"]> = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    requests.push({ url: request.url, body: JSON.parse(decoded.toString("utf8")) });
    if (request.url === "https://chatgpt.com/backend-api/codex/responses") {
      if (input.codexFailure) return Response.json({ error: { message: "quota exhausted" } }, { status: 429 });
      return new Response(`data: ${JSON.stringify({
        type: "response.completed", response: { id: "test-response", status: "completed", output: [] },
      })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (request.url === "https://openrouter.ai/api/v1/chat/completions") {
      return new Response(`data: ${JSON.stringify({
        id: "test-completion", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "openrouter answer" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected SDK request: ${request.url}`);
  }, { preconnect: vi.fn() });
  return { requests, fetch };
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
