import { describe, expect, it, vi } from "vitest";
import { OpenRouterError, runOpenRouterTurn, type OpenRouterMessage, type OpenRouterTool } from "../../src/codex/openrouter.js";

const settings = { apiKey: "fake-key", model: "fallback/model", messages: [{ role: "user", content: "Hello" }] as OpenRouterMessage[] };
const png = "data:image/png;base64,aGVsbG8=";

function stream(events: unknown[], options: { done?: boolean; suffix?: string } = {}): Response {
  const bytes = new TextEncoder().encode(": keepalive\r\n\r\n" + events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + (options.done === false ? "" : "data: [DONE]\r\n\r\n") + (options.suffix ?? ""));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    // Deliberately split JSON, CRLF and multibyte text across network packets.
    controller.enqueue(bytes.slice(offset, offset + 7));
    offset += 7;
  } }), { headers: { "content-type": "text/event-stream" } });
}

function answer(content: string, usage?: unknown): Response {
  return stream([{ model: "actual/model", choices: [{ delta: { content }, finish_reason: "stop" }] }, ...(usage ? [{ choices: [], usage }] : [])]);
}

function call(name: string, args: string, id = "call-1"): unknown {
  return { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] };
}

function requestBody(mock: ReturnType<typeof vi.fn>, index = 0): { messages: OpenRouterMessage[]; tools?: unknown[]; stream_options: unknown } {
  return JSON.parse(mock.mock.calls[index]![1].body);
}

describe("OpenRouter fallback", () => {
  it("streams Unicode input, preserves image inputs and accounts for cache tokens once", async () => {
    const onText = vi.fn();
    const onUsage = vi.fn();
    const fetch = vi.fn(async () => answer("Hello 🌍", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 5 }, cost: 0.002 }));
    const messages: OpenRouterMessage[] = [{ role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: png } }] }];
    const result = await runOpenRouterTurn({ ...settings, messages, fetch, onText, onUsage });
    expect(result.text).toBe("Hello 🌍");
    expect(result.model).toBe("actual/model");
    expect(result.messages).toEqual([{ role: "assistant", content: "Hello 🌍" }]);
    expect(requestBody(fetch).messages).toEqual(messages);
    expect(requestBody(fetch).stream_options).toEqual({ include_usage: true });
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, totalTokens: 120, cacheReadRatio: 0.6,
      calls: [{ provider: "openrouter", model: "actual/model", reasoningTokens: 5, cost: { total: 0.002 } }] });
    expect(onText).toHaveBeenCalledExactlyOnceWith("Hello 🌍");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(result.usage);
  });

  it("assembles fragmented tool calls, sends results and images, and accumulates usage across steps", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "Found it" }, { type: "image_url", image_url: { url: png } }] }));
    const tool: OpenRouterTool = { name: "inspect", description: "Inspect a file", parameters: { type: "object" }, execute };
    const fetch = vi.fn().mockResolvedValueOnce(stream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-", function: { name: "ins", arguments: '{"file":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "pect", arguments: "42}" } }] }, finish_reason: "tool_calls" }] },
      { usage: { prompt_tokens: 50, completion_tokens: 5 } },
    ])).mockResolvedValueOnce(answer("An image", { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } }));
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const result = await runOpenRouterTurn({ ...settings, tools: [tool], fetch, onToolCall, onToolResult });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ file: 42 }, undefined, "call-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = requestBody(fetch, 1);
    expect(second.messages[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "inspect", arguments: '{"file":42}' } }] });
    expect(second.messages[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: "Found it" });
    expect(second.messages[3]).toEqual({ role: "user", content: [{ type: "text", text: "Images returned by inspect (call-1):" }, { type: "image_url", image_url: { url: png } }] });
    expect(second.tools).toEqual(requestBody(fetch).tools);
    expect(result.usage).toMatchObject({ inputTokens: 70, outputTokens: 15, cacheReadTokens: 80, totalTokens: 165 });
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(settings.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("stops immediately after a successful finish_response", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "Delivered" }], details: { completed: true } }));
    const fetch = vi.fn(async () => stream([call("finish_response", "{}") ]));
    const result = await runOpenRouterTurn({ ...settings, fetch, tools: [{ name: "finish_response", description: "Finish", parameters: {}, execute }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.messages.at(-1)).toMatchObject({ role: "tool", content: "Delivered" });
  });

  it("does not execute any tool when finish_response is mixed into a batch", async () => {
    const execute = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(stream([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: "one", function: { name: "write", arguments: "{}" } },
      { index: 1, id: "two", function: { name: "finish_response", arguments: "{}" } },
    ] }, finish_reason: "tool_calls" }] }])).mockResolvedValueOnce(answer("Try again"));
    await runOpenRouterTurn({ ...settings, fetch, tools: ["write", "finish_response"].map(name => ({ name, description: name, parameters: {}, execute })) });
    expect(execute).not.toHaveBeenCalled();
    expect(requestBody(fetch, 1).messages.filter(message => message.role === "tool")).toHaveLength(2);
    expect(requestBody(fetch, 1).messages[2]!.content).toContain("No tools in this batch ran");
  });

  it("reports tool failures to the model without restarting the turn", async () => {
    const execute = vi.fn(async () => { throw new Error("Missing file"); });
    const fetch = vi.fn().mockResolvedValueOnce(stream([call("read", "{}")])).mockResolvedValueOnce(answer("The file is missing."));
    const result = await runOpenRouterTurn({ ...settings, fetch, tools: [{ name: "read", description: "Read", parameters: {}, execute }] });
    expect(result.text).toBe("The file is missing.");
    expect(requestBody(fetch, 1).messages[2]).toMatchObject({ role: "tool", content: '{"error":"Missing file"}' });
  });

  it("retains opaque reasoning blocks between tool steps", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stream([
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "First " }, { type: "reasoning.encrypted", index: 1, data: "opaque" }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "step" }] } }] }, call("read", "{}"),
    ])).mockResolvedValueOnce(answer("Done"));
    await runOpenRouterTurn({ ...settings, fetch, tools: [{ name: "read", description: "Read", parameters: {}, execute: async () => "OK" }] });
    expect(requestBody(fetch, 1).messages[1]!.reasoning_details).toEqual([{ type: "reasoning.text", index: 0, text: "First step" }, { type: "reasoning.encrypted", index: 1, data: "opaque" }]);
  });

  it("cancels a blocked stream and closes its reader", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort(new DOMException("Stopped", "AbortError"))); }, cancel })));
    await expect(runOpenRouterTurn({ ...settings, fetch, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError", message: "Stopped" });
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels tools that do not implement their own abort handling", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      queueMicrotask(() => controller.abort(new DOMException("Stopped", "AbortError")));
      return new Promise(() => {});
    });
    await expect(runOpenRouterTurn({ ...settings, signal: controller.signal, fetch: async () => stream([call("blocked", "{}")]),
      tools: [{ name: "blocked", description: "Blocked", parameters: {}, execute }] })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retains partial text and usage when a later provider request fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stream([{ choices: [{ delta: { content: "Checking…" } }] }, call("read", "{}"), { usage: { prompt_tokens: 10, completion_tokens: 3 } }]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 429, message: "Rate limited" } }), { status: 429 }));
    let failure: unknown;
    try { await runOpenRouterTurn({ ...settings, fetch, tools: [{ name: "read", description: "Read", parameters: {}, execute: async () => ({ found: true }) }] }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OpenRouterError);
    expect(failure).toMatchObject({ status: 429, code: 429, partial: { text: "Checking…", usage: { totalTokens: 13 }, messages: expect.arrayContaining([{ role: "tool", tool_call_id: "call-1", content: '{"found":true}' }]) } });
  });

  it("rejects mid-stream provider errors and incomplete responses", async () => {
    await expect(runOpenRouterTurn({ ...settings, fetch: async () => stream([{ error: { code: "server_error", message: "Provider failed" } }]) })).rejects.toMatchObject({ code: "server_error", message: "Provider failed" });
    await expect(runOpenRouterTurn({ ...settings, fetch: async () => stream([{ choices: [{ delta: { content: "Partial" } }] }], { done: false }) })).rejects.toMatchObject({ partial: { text: "Partial" }, message: "OpenRouter disconnected before completing its response." });
  });

  it("bounds model cycles and tool calls without executing excess work", async () => {
    const execute = vi.fn(async () => "OK");
    const tool = { name: "repeat", description: "Repeat", parameters: {}, execute };
    const fetch = vi.fn(async () => stream([call("repeat", "{}") ]));
    await expect(runOpenRouterTurn({ ...settings, fetch, tools: [tool], maxModelCycles: 2 })).rejects.toMatchObject({ message: "OpenRouter fallback model cycle limit reached." });
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockClear();
    await expect(runOpenRouterTurn({ ...settings, fetch, tools: [tool], maxToolCalls: 1 })).rejects.toMatchObject({ message: "OpenRouter fallback tool limit reached." });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves zero as unlimited for model cycles and tool calls", async () => {
    const execute = vi.fn(async () => "OK");
    let cycles = 0;
    const fetch = vi.fn(async () => {
      cycles++;
      if (cycles === 33) return answer("Completed all work");
      return stream([{ choices: [{ delta: { tool_calls: [0, 1, 2].map(index => ({ index, id: `cycle-${cycles}-call-${index}`, function: { name: "step", arguments: "{}" } })) }, finish_reason: "tool_calls" }] }]);
    });
    const result = await runOpenRouterTurn({ ...settings, fetch, tools: [{ name: "step", description: "Do a step", parameters: {}, execute }], maxModelCycles: 0, maxToolCalls: 0 });
    expect(result.text).toBe("Completed all work");
    expect(fetch).toHaveBeenCalledTimes(33);
    expect(execute).toHaveBeenCalledTimes(96);
  });
});
