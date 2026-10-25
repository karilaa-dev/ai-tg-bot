import { expect, it } from "vitest";
import { ToolActivityCollector, TOOL_ACTIVITY_LIMITS, redactToolText, savedToolActivity } from "../../src/ai/toolActivity.js";

it("correlates parallel calls by ID, replaces provisional updates and distinguishes cancellation", () => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "first", toolName: "read", args: { path: "/a" } });
  activity.onEvent({ type: "tool_execution_start", toolCallId: "second", toolName: "read", args: { path: "/b" } });
  activity.onEvent({ type: "tool_execution_update", toolCallId: "first", toolName: "read", args: { path: "/a" }, partialResult: { content: [{ type: "text", text: "partial" }] } });
  const live = activity.snapshot([], "running");
  expect(live?.calls[0]).toMatchObject({ status: "running", result: { text: "partial" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "second", toolName: "read", result: { content: [{ type: "text", text: "Operation aborted" }], details: {} }, isError: true });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "first", toolName: "read", result: { content: [{ type: "text", text: '{"rows":[{"value":0.000000123456789}]}' }], details: {} }, isError: false });
  const [first, second] = activity.snapshot()?.calls ?? [];
  expect(first).toMatchObject({ name: "read", status: "succeeded", args: { format: "json" }, result: { format: "text" } });
  expect(JSON.parse(first?.result?.text ?? "null")).toEqual({ rows: [{ value: 0.000000123456789 }] });
  expect(first?.result?.text).not.toContain("partial");
  expect(live?.calls[0]?.result?.text).toBe("partial");
  expect(second).toMatchObject({ status: "cancelled", result: { text: "Operation aborted" } });
});

it("records how much reasoning preceded each call so the web can order one chain", () => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "first", toolName: "read", args: { path: "/a" } }, false, 1);
  activity.onEvent({ type: "tool_execution_end", toolCallId: "first", toolName: "read", result: { content: [{ type: "text", text: "ok" }], details: {} }, isError: false }, false, 9);
  activity.onEvent({ type: "tool_execution_start", toolCallId: "second", toolName: "read", args: { path: "/b" } }, false, 2_500);
  activity.onEvent({ type: "tool_execution_start", toolCallId: "third", toolName: "read", args: { path: "/c" } });
  const calls = activity.snapshot(["one", "two"])?.calls ?? [];
  expect(calls.map(call => call.reasoningBefore)).toEqual([1, 1_000, undefined]);
  expect(Object.hasOwn(calls[2]!, "reasoningBefore")).toBe(false);
  expect(savedToolActivity({ version: 1, calls, reasoning: ["one", "two"], omittedCalls: 0 })?.calls.map(call => call.reasoningBefore)).toEqual([1, 1_000, undefined]);
  expect(savedToolActivity({ version: 1, calls: [{ ...calls[0], reasoningBefore: -1 }], reasoning: [], omittedCalls: 0 })).toBeUndefined();
});

it("bounds cyclic, deep and large results without invalid JSON or unbounded call logs", () => {
  const activity = new ToolActivityCollector();
  const cyclic: Record<string, unknown> = { output: Array.from({ length: 10_000 }, () => "A detailed row with useful data.") };
  cyclic.next = cyclic;
  for (let index = 0; index < 100; index++) {
    activity.onEvent({ type: "tool_execution_start", toolCallId: `${index}`, toolName: "read", args: { text: "plain data\n".repeat(10_000) } });
    activity.onEvent({ type: "tool_execution_end", toolCallId: `${index}`, toolName: "read", result: { details: cyclic }, isError: false });
  }
  const snapshot = activity.snapshot();
  expect(snapshot?.calls).toHaveLength(TOOL_ACTIVITY_LIMITS.calls);
  expect(snapshot?.omittedCalls).toBe(36);
  expect(JSON.stringify(snapshot).length).toBeLessThan(TOOL_ACTIVITY_LIMITS.totalChars * 1.5);
  expect(snapshot?.calls[0]?.args?.truncated).toBe(true);
  for (const call of snapshot?.calls ?? []) for (const payload of [call.args, call.result]) {
    expect(payload?.text.length ?? 0).toBeLessThanOrEqual(TOOL_ACTIVITY_LIMITS.payloadChars);
    if (payload?.format === "json") expect(() => JSON.parse(payload.text)).not.toThrow();
  }
});

it("removes finish_response, configured credentials, nested secrets and transport-only fields", () => {
  const activity = new ToolActivityCollector({ OPENROUTER_API_KEY: "provider-opaque-value" });
  activity.onEvent({ type: "tool_execution_start", toolCallId: "finish", toolName: "finish_response", args: { openui: "private DSL" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "finish", toolName: "finish_response", result: { details: { openui: "private DSL" } }, isError: false });
  activity.onEvent({ type: "tool_execution_start", toolCallId: "public", toolName: "web_search", args: { query: "useful query", password: "user-password", nested: { accessToken: "oauth-value" } } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "public", toolName: "web_search", isError: false,
    result: { content: [{ type: "image", data: "provider-image" }], details: { title: "Search result", url: "https://person:login@example.com/page?api_key=url-value", stdout: "Authorization: Bearer provider-opaque-value", screenshot_base64: "image-data", session_id: "internal-session", transport: "internal-transport", model_hint: "private instruction" } } });
  const snapshot = activity.snapshot();
  expect(snapshot?.calls).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toMatch(/private DSL|provider-opaque-value|user-password|oauth-value|person:login|url-value|image-data|internal-session|internal-transport|private instruction/);
  expect(JSON.stringify(snapshot)).toContain("Search result");
  expect(JSON.stringify(snapshot)).toContain("useful query");
});

it("redacts secret fields even in malformed JSON-like output and signed query strings", () => {
  const text = 'Partial JSON: {"api_key": "malformed-secret", "broken":\nURL https://example.com?key=private-query&auth=private-auth\nCookie: session=first-cookie; arbitrary=second-cookie';
  expect(redactToolText(text)).not.toMatch(/malformed-secret|private-query|private-auth|first-cookie|second-cookie/);
});

it("uses the cancellation signal for arbitrary abort reasons and does not mistake successful file text for cancellation", () => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "notes.txt" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: { content: [{ type: "text", text: "Operation aborted" }] }, isError: false });
  activity.onEvent({ type: "tool_execution_start", toolCallId: "broken", toolName: "bash", args: { script: "exit 7" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "broken", toolName: "bash", result: { details: { exit_code: 7 } }, isError: true });
  activity.onEvent({ type: "tool_execution_start", toolCallId: "stopped", toolName: "bash", args: { script: "sleep 30" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "stopped", toolName: "bash", result: { content: [{ type: "text", text: "Owner lease was lost" }] }, isError: true }, true);
  expect(activity.snapshot([], "cancelled")?.calls.map(call => call.status)).toEqual(["succeeded", "error", "cancelled"]);
});

it("hides typed browser values with opaque targets and their later echoes", () => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "type", toolName: "browser_type", args: { tab_id: "tab-1", ref: "r7", text: "invented-password" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "type", toolName: "browser_type", result: { details: { success: true, echo: "invented-password" } }, isError: false });
  const snapshot = activity.snapshot(["Entered invented-password."]);
  expect(JSON.stringify(snapshot)).not.toContain("invented-password");
  expect(JSON.parse(snapshot?.calls[0]?.args?.text ?? "null")).toEqual({ tab_id: "tab-1", ref: "r7", text: "[redacted]" });
});

it("revalidates saved browser input before exposing old arguments, outputs or reasoning", () => {
  const payload = (value: unknown) => ({ format: "json", text: JSON.stringify(value), truncated: false });
  const activity = savedToolActivity({ version: 1, omittedCalls: 0, reasoning: ["Entered invented-login-value"], calls: [
    { id: "transport-id", name: "browser_type", status: "succeeded", durationMs: 5,
      args: payload({ selector: "input[type=password]", text: "invented-login-value" }), result: payload({ echo: "invented-login-value" }) },
    { id: "malformed", name: "browser_type", status: "error", durationMs: 5,
      args: { format: "text", text: "broken invented-password input", truncated: false }, result: null },
  ] });
  expect(activity?.calls).toHaveLength(2);
  expect(JSON.stringify(activity)).not.toMatch(/invented-login-value|invented-password|transport-id/);
  expect(JSON.parse(activity?.calls[0]?.args?.text ?? "null")).toEqual({ selector: "input[type=password]", text: "[redacted]" });
  expect(activity?.calls[1]?.args?.text).toBe("[redacted]");
});

it("sanitizes nested JSON strings and escaped credentials in source without losing useful values", () => {
  const code = String.raw`const body = "{\"api_key\":\"invented-private-value\"}"; text(body);`;
  expect(redactToolText(code)).toBe(String.raw`const body = "{\"api_key\":\"[redacted]\"}"; text(body);`);
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "nested", toolName: "codemode", args: { code } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "nested", toolName: "codemode", isError: false,
    result: { details: { stdout: JSON.stringify({ session_id: "invented-session", openui: "private-program", value: 0.000000123456789,
      nested: JSON.stringify({ api_key: "nested-private-value", keep: "visible" }) }) } } });
  const snapshot = activity.snapshot();
  const saved = savedToolActivity(snapshot);
  for (const value of [snapshot, saved]) {
    expect(JSON.stringify(value)).not.toMatch(/invented-private-value|invented-session|private-program|nested-private-value/);
    const stdout = JSON.parse(value?.calls[0]?.result?.text ?? "null").stdout;
    expect(JSON.parse(stdout)).toEqual({ session_id: "[details omitted]", openui: "[details omitted]", value: 0.000000123456789,
      nested: JSON.stringify({ api_key: "[redacted]", keep: "visible" }) });
  }
});

it.each(["", "0.123456789012345678901234567890", "123.4500", '{ "large": 9007199254740993, "decimal": 123.4500 }', '"literal string"'])("preserves literal read text through snapshots and saved-record validation: %s", text => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_end", toolCallId: "literal", toolName: "read", isError: false,
    result: { content: [{ type: "text", text }], details: { path: "numbers.txt" } } });
  const snapshot = activity.snapshot();
  expect(snapshot?.calls[0]?.result).toEqual({ format: "text", text, truncated: false });
  expect(savedToolActivity(snapshot)?.calls[0]?.result).toEqual({ format: "text", text, truncated: false });
});

it("redacts JSON-bearing strings recursively while retaining numeric lexemes and harmless formatting", () => {
  const text = String.raw`{ "large": 9007199254740993, "decimal": 123.4500, "\u0061pi_key": 123456, "openui": {"program":"private-program"}, "nested": "{\"api_key\":\"nested-secret\",\"value\":123.4500}" }`;
  const safe = redactToolText(text);
  expect(safe).toContain('"large": 9007199254740993, "decimal": 123.4500');
  expect(safe).not.toMatch(/123456,|private-program|nested-secret/);
  expect(JSON.parse(safe)).toMatchObject({ api_key: "[redacted]", openui: "[details omitted]", nested: '{"api_key":"[redacted]","value":123.4500}' });
});

it("bounds sanitizer input before inspecting huge single lines and preserves complete useful lines", () => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "large", toolName: "read", args: { path: "large.log" } });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "large", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: `Useful heading\n${"_".repeat(5_000_000)}password=never-visit-tail` }] } });
  const payload = activity.snapshot()?.calls[0]?.result;
  expect(payload).toMatchObject({ format: "text", truncated: true });
  expect(payload?.text).toContain("Useful heading");
  expect(payload?.text.length).toBeLessThan(100);
  expect(redactToolText("_".repeat(20_000))).toHaveLength(20_000);
});

it("sanitizes live labels with configured and subsequently learned browser values", () => {
  const activity = new ToolActivityCollector({ PROVIDER_API_KEY: "synthetic-provider-value" });
  expect(activity.sanitizeText("Run synthetic-provider-value")).toBe("Run [redacted]");
  activity.onEvent({ type: "tool_execution_start", toolCallId: "type", toolName: "browser_type", args: { text: "synthetic browser value" } });
  expect(activity.sanitizeText("Entered synthetic browser value / synthetic%20browser%20value"))
    .toBe("Entered [redacted] / [redacted]");
  expect(activity.sanitizeText("Useful heading\n" + "_".repeat(5_000_000))).toBe("Useful heading\n[details omitted]");
});

it.each([
  `await tools.browser_type({ ref: "r7", text: "synthetic-nested-browser-value" });`,
  `throw new Error("earlier operation failed"); await tools.browser_type({ text: "synthetic-nested-browser-value" });`,
  `const value = 'synthetic-nested-browser-value'; const type = tools.browser_type; await type({ text: value });`,
  `const value = 'synthetic-nested-browser-value'; const api = tools; await api['browser_' + 'type']({ text: value });`,
  `const value = 'synthetic-nested-browser-value'; await tools['browser_' + 'type']({ ['te' + 'xt']: value });`,
  String.raw`await to\u006fls.browser_type({ text: "synthetic-nested-browser-value" });`,
  String.raw`await tools.browser_type({ text: "synthetic-\u006eested-browser-value" });`,
])("withholds private source before its first snapshot and protects later echoes: %s", code => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "code", toolName: "codemode", args: { code } });
  const first = activity.snapshot(["Entered synthetic-nested-browser-value"], "running");
  expect(JSON.stringify(first)).not.toContain("synthetic-nested-browser-value");
  expect(JSON.parse(first?.calls[0]?.args?.text ?? "null")).toEqual({ code: "[details omitted]" });
  activity.onEvent({ type: "tool_execution_end", toolCallId: "code", toolName: "codemode", isError: true,
    result: { content: [{ type: "text", text: "Failed before typing synthetic-nested-browser-value" }] } });
  expect(activity.snapshot()?.calls[0]?.status).toBe("error");
  expect(JSON.stringify(activity.snapshot())).not.toContain("synthetic-nested-browser-value");
  expect(activity.sanitizeText("Entered synthetic-nested-browser-value")).toBe("Entered [redacted]");

  const historical = savedToolActivity({ version: 1, calls: [{ id: "old", name: "codemode", status: "error", durationMs: 1,
    args: { format: "json", text: JSON.stringify({ code }), truncated: false },
    result: { format: "text", text: "Failed before typing synthetic-nested-browser-value", truncated: false } }],
    reasoning: ["Entered synthetic-nested-browser-value"], omittedCalls: 0 });
  expect(historical?.calls).toHaveLength(1);
  expect(JSON.stringify(historical)).not.toContain("synthetic-nested-browser-value");
});

it.each([
  'const large = 9007199254740993;\nconst precise = 123.4500 / 3; text(precise / 2);',
  'const result = await tools.bash({ script: "printf hello" });\ntext(result);',
  'const row = await tools.web_search({query: "precise measurements"}); text(row);',
])("preserves ordinary source and numeric lexemes through live and saved activity: %s", code => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "code", toolName: "codemode", args: { code } });
  const live = activity.snapshot([], "running");
  for (const snapshot of [live, savedToolActivity(live)]) {
    expect(JSON.parse(snapshot?.calls[0]?.args?.text ?? "null")).toEqual({ code });
  }
});

it("redacts nested browser metadata and output without any top-level browser events", () => {
  const value = "synthetic-metadata-only-value";
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_end", toolCallId: "code", toolName: "codemode", isError: false,
    result: { content: [{ type: "text", text: `Script completed\nWall time 0.1 seconds\nOutput:\nEntered ${value}` }],
      details: { calls: [{ name: "browser_type", args: { text: value, ref: "r7" }, status: "succeeded" }] } } });
  const live = activity.snapshot([`Entered ${value}`]);
  expect(JSON.stringify(live)).not.toContain(value);
  expect(JSON.parse(live?.calls[0]?.result?.text ?? "null")).toMatchObject({
    output: "Entered [redacted]", calls: [{ name: "browser_type", args: { text: "[redacted]", ref: "r7" } }],
  });
  expect(activity.sanitizeText(`Entered ${value}`)).toBe("Entered [redacted]");

  const historical = savedToolActivity({ version: 1, reasoning: [`Entered ${value}`], omittedCalls: 0, calls: [
    { id: "earlier", name: "read", status: "succeeded", durationMs: 1, args: null,
      result: { format: "text", text: `Earlier ${value}`, truncated: false } },
    { id: "nested", name: "codemode", status: "succeeded", durationMs: 1, args: null,
      result: { format: "json", text: JSON.stringify({ output: `Entered ${value}`, calls: [{ name: "browser_type", args: { text: value } }] }), truncated: false } },
  ] });
  expect(JSON.stringify(historical)).not.toContain(value);
  expect(historical?.calls[0]?.result?.text).toBe("Earlier [redacted]");
});

it("learns browser input even when its call is omitted by the live call limit", () => {
  const activity = new ToolActivityCollector();
  for (let index = 0; index < TOOL_ACTIVITY_LIMITS.calls; index++) {
    activity.onEvent({ type: "tool_execution_start", toolCallId: `${index}`, toolName: "read", args: { path: "report" } });
  }
  activity.onEvent({ type: "tool_execution_start", toolCallId: "omitted", toolName: "browser_type", args: { text: "synthetic-omitted-value" } });
  expect(activity.snapshot(["Entered synthetic-omitted-value"])?.omittedCalls).toBe(1);
  expect(JSON.stringify(activity.snapshot(["Entered synthetic-omitted-value"]))).not.toContain("synthetic-omitted-value");
  expect(activity.sanitizeText("Entered synthetic-omitted-value")).toBe("Entered [redacted]");
});

it.each(["update", "end"])("learns nested browser metadata from an omitted Code mode %s", phase => {
  const activity = new ToolActivityCollector();
  const value = "synthetic-omitted-nested-value";
  for (let index = 0; index < TOOL_ACTIVITY_LIMITS.calls; index++) {
    activity.onEvent({ type: "tool_execution_start", toolCallId: `${index}`, toolName: "read", args: { path: "report" } });
  }
  const args = { code: `await tools.browser_type({text:String.fromCharCode(${Array.from(value, char => char.charCodeAt(0)).join(",")})});` };
  activity.onEvent({ type: "tool_execution_start", toolCallId: "omitted", toolName: "codemode", args });
  const result = { content: [{ type: "text", text: "Completed" }], details: { calls: [{ name: "browser_type", args: { text: value } }] } };
  activity.onEvent(phase === "update"
    ? { type: "tool_execution_update", toolCallId: "omitted", toolName: "codemode", args, partialResult: result }
    : { type: "tool_execution_end", toolCallId: "omitted", toolName: "codemode", result, isError: false });
  const snapshot = activity.snapshot([`Entered ${value}`]);
  expect(snapshot?.calls).toHaveLength(TOOL_ACTIVITY_LIMITS.calls);
  expect(snapshot?.omittedCalls).toBe(1);
  expect(JSON.stringify(snapshot)).not.toContain(value);
  expect(activity.sanitizeText(`Entered ${value}`)).toBe("Entered [redacted]");
});

it("withholds saved details if uninspected calls could contain private inputs", () => {
  const value = "synthetic-omitted-value";
  const calls = Array.from({ length: TOOL_ACTIVITY_LIMITS.calls }, (_, index) => ({ id: `${index}`, name: "read", status: "succeeded", durationMs: 1,
    args: null, result: { format: "text", text: `Earlier ${value}`, truncated: false } }));
  const historical = savedToolActivity({ version: 1, reasoning: [`Entered ${value}`], omittedCalls: 0,
    calls: [...calls, { id: "omitted", name: "browser_type", status: "succeeded", durationMs: 1, result: null,
      args: { format: "json", text: JSON.stringify({ text: value }), truncated: false } }] });
  expect(historical?.calls).toHaveLength(TOOL_ACTIVITY_LIMITS.calls);
  expect(historical?.omittedCalls).toBe(1);
  expect(JSON.stringify(historical)).not.toContain(value);
});

it.each([
  `const values = ${JSON.stringify(Array.from({ length: 200 }, (_, index) => `synthetic-candidate-${index}`))}; await tools.browser_type({text: values.join('')});`,
  `const value = 'synthetic-large-value';\n${" ".repeat(100_000)}await tools.browser_type({text: value});`,
  `${"0;".repeat(5_000)}await tools.browser_type({text: 'synthetic-token-limit-value'});`,
])("withholds details and later text when source or secret budgets are exceeded", code => {
  const activity = new ToolActivityCollector();
  activity.onEvent({ type: "tool_execution_start", toolCallId: "code", toolName: "codemode", args: { code } });
  expect(activity.snapshot(["An unknown reconstructed private value"])?.calls[0]?.args)
    .toEqual({ format: "text", text: "[details omitted]", truncated: true });
  expect(activity.sanitizeText("An unknown reconstructed private value")).toBe("[details omitted]");
});
