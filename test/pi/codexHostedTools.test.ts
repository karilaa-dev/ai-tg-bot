import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadTestConfig } from "../../src/config.js";
import { searchCodexWeb } from "../../src/pi/codexWebSearch.js";
import { requestCodex, type CodexRequestRuntime } from "../../src/pi/codexRequest.js";
import { replayCodexCheckpoint } from "../../src/pi/codexCompaction.js";
import { CodexCircuitBreaker } from "../../src/pi/circuit.js";

afterEach(() => vi.unstubAllGlobals());
const model: Model<"openai-codex-responses"> = {
  id: "test-codex", name: "Test Codex", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"],
  contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function runtime(timeoutMs = 1000): CodexRequestRuntime {
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
  return {
    config: loadTestConfig({ PI_REQUEST_TIMEOUT_MS: timeoutMs }),
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: {} }) } as never,
    providerRouter: { codexModel: () => model, circuit: new CodexCircuitBreaker() } as never,
  };
}
function transport(output: Record<string, unknown>[], completed = true) {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    requests.push({ body: JSON.parse(decoded.toString()), headers: request.headers });
    const events: unknown[] = output.flatMap((item, output_index) => [
      { type: "response.output_item.added", item, output_index },
      { type: "response.output_item.done", item, output_index },
    ]);
    if (completed) events.push({ type: "response.completed", response: { status: "completed", output,
      usage: { input_tokens: 30, output_tokens: 7, total_tokens: 37, input_tokens_details: { cached_tokens: 10 } } } });
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  return requests;
}

describe("Codex hosted search transport", () => {
  it("uses OAuth, forces hosted search and returns only annotated or searched source URLs", async () => {
    const requests = transport([
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", sources: [
        { type: "url", url: "https://example.com/extra", title: "Extra" },
        { type: "url", url: "javascript:bad" },
      ] } },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text",
        text: "Answer with https://invented.test and a citation.", annotations: [
          { type: "url_citation", url: "https://example.com/source", title: "Source", start_index: 0, end_index: 6 },
        ] }] },
    ]);
    const result = await searchCodexWeb(runtime(), "current facts", 2);
    expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("test-account");
    expect(requests[0]!.body).toMatchObject({ store: false, tools: [{ type: "web_search", external_web_access: true }],
      tool_choice: { type: "web_search" }, include: ["web_search_call.action.sources"] });
    expect(result.results).toEqual([
      { title: "Source", url: "https://example.com/source", snippet: "" },
      { title: "Extra", url: "https://example.com/extra", snippet: "" },
    ]);
    expect(result.answer).toContain("Answer");
    expect(result.usage).toMatchObject({ input: 20, cacheRead: 10, output: 7 });
  });

  it("preserves every cited URL when max_results is smaller than the citation count", async () => {
    const cited = ["first", "second", "third"].map(title => ({ title, url: `https://example.com/${title}` }));
    transport([
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", sources: [
        { type: "url", url: "https://example.com/uncited", title: "Extra" },
      ] } },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text",
        text: "An answer citing three sources.", annotations: [...cited, cited[0], { title: "Invalid", url: "javascript:bad" }]
          .map(source => ({ type: "url_citation", ...source, start_index: 0, end_index: 6 })),
      }] },
    ]);
    const result = await searchCodexWeb(runtime(), "facts", 1);
    expect(result.results).toHaveLength(1);
    expect(result.citations).toEqual(cited);
    expect(result.answer).toBe("An answer citing three sources.");
  });

  it("allows cache-only search when explicitly configured", async () => {
    const requests = transport([{ type: "web_search_call", id: "ws_1", status: "completed" }]);
    const input = runtime();
    input.config.CODEX_WEB_SEARCH_MODE = "cached";
    await searchCodexWeb(input, "facts", 1);
    expect(requests[0]!.body.tools).toEqual([{ type: "web_search", external_web_access: false }]);
  });

  it("allows a recovery probe after cooldown and closes the shared circuit on success", async () => {
    let now = Date.now();
    const input = runtime();
    const circuit = new CodexCircuitBreaker(() => now);
    input.providerRouter.circuit = circuit;
    const failure = circuit.acquire();
    if (!failure.allowed) throw new Error("Expected an allowed attempt");
    failure.recordFailure();
    const requests = transport([{ type: "web_search_call", id: "ws_1", status: "completed" }]);
    await expect(searchCodexWeb(input, "facts", 1)).rejects.toThrow("temporarily unavailable");
    expect(requests).toHaveLength(0);
    now = circuit.state().nextProbeAt;
    await searchCodexWeb(input, "facts", 1);
    expect(requests).toHaveLength(1);
    expect(circuit.state()).toMatchObject({ open: false, probeActive: false });
  });

  it("records HTTP quota failures and honors the server retry delay", async () => {
    const input = runtime();
    const before = Date.now();
    const fetch = vi.fn(async () => Response.json({ error: { message: "Capacity exceeded" } }, {
      status: 429, headers: { "retry-after": "120" },
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(searchCodexWeb(input, "facts", 1)).rejects.toThrow();
    expect(input.providerRouter.circuit.state().open).toBe(true);
    expect(input.providerRouter.circuit.state().blockedUntil).toBeGreaterThanOrEqual(before + 120_000);
    expect(input.providerRouter.circuit.state().blockedUntil).toBeLessThanOrEqual(Date.now() + 120_000);
    await expect(searchCodexWeb(input, "facts", 1)).rejects.toThrow("temporarily unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([200, 400, 429])("keeps a newer inference cooldown when an older search finishes with HTTP %s", async status => {
    transport([{ type: "web_search_call", id: "ws_1", status: "completed" }]);
    if (status !== 200) vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: { message: status === 429 ? "quota exhausted" : "invalid request" } }, { status },
    )));
    const input = runtime();
    const search = searchCodexWeb(input, "facts", 1);
    const inference = input.providerRouter.circuit.acquire();
    if (!inference.allowed) throw new Error("Expected an allowed inference attempt");
    inference.recordFailure();
    const cooldown = input.providerRouter.circuit.state();
    if (status === 200) await search;
    else await expect(search).rejects.toThrow();
    expect(input.providerRouter.circuit.state()).toEqual(cooldown);
    await expect(searchCodexWeb(input, "more facts", 1)).rejects.toThrow("temporarily unavailable");
  });

  it("ignores an older search failure after newer inference succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "quota exhausted" } }, { status: 429 })));
    const input = runtime();
    const search = searchCodexWeb(input, "facts", 1);
    const inference = input.providerRouter.circuit.acquire();
    if (!inference.allowed) throw new Error("Expected an allowed inference attempt");
    inference.recordSuccess();
    await expect(search).rejects.toThrow();
    expect(input.providerRouter.circuit.state().open).toBe(false);
  });

  it("releases a cancelled recovery probe without extending the cooldown", async () => {
    let now = Date.now();
    const input = runtime();
    input.providerRouter.circuit = new CodexCircuitBreaker(() => now);
    const failure = input.providerRouter.circuit.acquire();
    if (!failure.allowed) throw new Error("Expected an allowed attempt");
    failure.recordFailure();
    now = input.providerRouter.circuit.state().nextProbeAt;
    const before = input.providerRouter.circuit.state();
    const controller = new AbortController();
    input.modelRegistry.getApiKeyAndHeaders = async () => {
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    };
    await expect(searchCodexWeb(input, "facts", 1, controller.signal)).rejects.toThrow("cancelled");
    expect(input.providerRouter.circuit.state()).toEqual(before);
  });

  it("rejects an unfinished stream or a response that never searched", async () => {
    transport([], false);
    await expect(searchCodexWeb(runtime(), "query", 5)).rejects.toThrow();
    transport([]);
    await expect(searchCodexWeb(runtime(), "query", 5)).rejects.toThrow("did not complete a web search");
  });

  it("bounds stalled authentication and propagates cancellation", async () => {
    const input = runtime(20);
    input.modelRegistry.getApiKeyAndHeaders = () => new Promise(() => {});
    await expect(searchCodexWeb(input, "query", 5)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(searchCodexWeb(runtime(), "query", 5, controller.signal)).rejects.toThrow("cancelled");
  });
});

describe("Codex compaction checkpoints", () => {
  it("captures opaque compaction items through the existing SDK transport", async () => {
    const requests = transport([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }]);
    const result = await requestCodex(runtime(), { kind: "main", headers: { "x-codex-beta-features": "remote_compaction_v2" },
      context: { messages: [{ role: "user", content: "Remember the release code.", timestamp: 0 }] },
      patch: body => ({ ...body, input: [...body.input as unknown[], { type: "compaction_trigger" }] }),
    });
    expect(result.output).toEqual([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }]);
    expect(requests[0]!.body.input).toEqual(expect.arrayContaining([{ type: "compaction_trigger" }]));
    expect(requests[0]!.headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
  });

  it("replays the checkpoint with the projected retained tail and leaves fallback payloads intact", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    const kept = manager.appendMessage({ role: "user", content: "retained request", timestamp: 2 });
    manager.appendCompaction("Portable facts", kept, 100, {
      codexCompaction: { version: 1, model: model.id, items: [{ type: "compaction", encrypted_content: "opaque" }] },
    });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "<session_context>now</session_context>\nnew request" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 3 });
    const entry = manager.getBranch().findLast(e => e.type === "compaction")!;
    const body = { model: model.id, instructions: "current system prompt", tools: [{ type: "function", name: "current_tool" }],
      input: convertResponsesMessages(model, normalizeContext({ messages: convertToLlm(manager.buildSessionContext().messages) }), new Set(["openai-codex"])) };
    const replayed = replayCodexCheckpoint(body, entry) as typeof body;
    expect(replayed.input[0]).toEqual({ type: "compaction", encrypted_content: "opaque" });
    expect(replayed.input.slice(1)).toEqual(body.input.slice(1));
    expect(JSON.stringify(replayed)).toContain("retained request");
    expect(JSON.stringify(replayed)).toContain("<session_context>");
    expect(replayed.tools).toBe(body.tools);
    expect(replayCodexCheckpoint({ ...body, model: "another-model" }, entry)).toEqual({ ...body, model: "another-model" });
    const fallback = { model: "openai/test", messages: [{ role: "user", content: "Portable facts" }] };
    expect(replayCodexCheckpoint(fallback, entry)).toBe(fallback);
    manager.branch(kept);
    expect(manager.getBranch().some(e => e.type === "compaction")).toBe(false);
    expect(replayCodexCheckpoint(body, undefined)).toBe(body);
  });
});
