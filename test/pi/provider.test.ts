import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import {
  registerPiProviderRouter,
  type PiProviderStreamOverrides,
} from "../../src/pi/provider.js";
import { CodexCircuitBreaker } from "../../src/pi/circuit.js";

describe("Pi automatic provider", () => {
  it("uses Codex exclusively while its OAuth and provider are available", async () => {
    const harness = providerHarness({ codexConfigured: true });
    const mainEvents = await harness.run("main");
    const helperEvents = await harness.run("helper");

    expect(harness.calls).toEqual(["codex", "codex"]);
    expect(textDeltas(mainEvents)).toBe("codex answer");
    expect(textDeltas(helperEvents)).toBe("codex answer");
    expect(harness.router.circuit.state().open).toBe(false);
  });

  it("uses OpenRouter only when Codex OAuth is not configured", async () => {
    const harness = providerHarness({ codexConfigured: false });
    const events = await harness.run();

    expect(harness.calls).toEqual(["openrouter"]);
    expect(textDeltas(events)).toBe("openrouter answer");
    expect(harness.router.mainModel.contextWindow).toBe(128_000);
  });

  it("falls back before output for quota and OAuth refresh failures", async () => {
    const quota = providerHarness({ codexError: "quota exhausted" });
    expect(textDeltas(await quota.run())).toBe("openrouter answer");
    expect(quota.calls).toEqual(["codex", "openrouter"]);
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
});

function providerHarness(input: {
  codexConfigured?: boolean;
  codexError?: string;
  codexPartial?: string;
  authError?: string;
  circuit?: CodexCircuitBreaker;
}) {
  const calls: string[] = [];
  let registered: { streamSimple: (model: Model<Api>, context: { systemPrompt: string; messages: [] }) => AsyncIterable<AssistantMessageEvent> } | undefined;
  const registry = {
    find: () => undefined,
    registerProvider: (_name: string, provider: typeof registered) => { registered = provider; },
    hasConfiguredAuth: () => input.codexConfigured ?? true,
    getApiKeyAndHeaders: async () => input.authError
      ? { ok: false as const, error: input.authError }
      : { ok: true as const, apiKey: "codex-token", headers: {} },
  };
  const streams: PiProviderStreamOverrides = {
    codex: ((model) => {
      calls.push("codex");
      if (input.codexPartial) {
        return eventStream(model, input.codexPartial, input.codexError);
      }
      return input.codexError ? errorStream(model, input.codexError) : eventStream(model, "codex answer");
    }) as PiProviderStreamOverrides["codex"],
    openRouter: ((model) => {
      calls.push("openrouter");
      return eventStream(model, "openrouter answer");
    }) as PiProviderStreamOverrides["openRouter"],
  };
  const router = registerPiProviderRouter({
    config: loadTestConfig(),
    modelRegistry: registry as never,
    circuit: input.circuit,
    streams,
  });
  return {
    calls,
    router,
    run: async (kind: "main" | "helper" = "main") => {
      if (!registered) throw new Error("provider was not registered");
      const events: AssistantMessageEvent[] = [];
      const model = kind === "helper" ? router.helperModel : router.mainModel;
      for await (const event of registered.streamSimple(model, { systemPrompt: "", messages: [] })) events.push(event);
      return events;
    },
  };
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
