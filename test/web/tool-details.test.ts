import { fixtureUuid } from "./uuid-fixtures.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { chainSteps, formatElapsed, ResponseChain, ToolPayloadView, toolLabel } from "../../src/web/client/tool-details.js";
import { messageView } from "../../src/web/message-view.js";
import type { MessageRow } from "../../src/db/types.js";
import type { ToolCallDetail } from "../../src/ai/toolActivity.js";

function row(content: unknown): MessageRow {
  return { id: 1, thread_id: fixtureUuid(1), role: "assistant", kind: "text", text_plain: "Result", content_json: JSON.stringify(content),
    thinking: "Tool calls: 1\n\nOlder saved tool summary", created_at: 0, tg_message_id: null, pi_entry_id: null };
}
const call = { id: "test", name: "bash", status: "error", args: { format: "json", text: JSON.stringify({ script: 'printf "<test>\\n"\necho second' }), truncated: false },
  result: { format: "json", text: JSON.stringify({ stdout: "A full line\nAnother line", stderr: "Failure", exit_code: 7 }), truncated: false }, durationMs: 1250 };

it("validates saved metadata, skips malformed calls and hides finish_response before creating a view", () => {
  const view = messageView(row({ toolActivity: { version: 1, calls: [call, { ...call, name: "finish_response" }, { name: "broken" }], reasoning: [], omittedCalls: 0 } }), []);
  expect(view.toolActivity?.calls).toHaveLength(1);
  const html = renderToStaticMarkup(createElement(ResponseChain, { activity: view.toolActivity, thinking: null, language: "ru", defaultOpen: true }));
  expect(html).toContain("1 вызов инструмента");
  expect(html).toContain("<summary");
  expect(html).toContain("Выполнение команды");
  expect(html).not.toContain("Older saved");
  expect(html).not.toContain("finish_response");
});

it("renders command and stdout as code with actual line breaks and retains precise JSON metadata", () => {
  const view = messageView(row({ toolActivity: { version: 1, calls: [call], reasoning: [], omittedCalls: 0 } }), []);
  const saved = view.toolActivity?.calls[0];
  if (!saved) throw new Error("Missing validated call");
  const args = renderToStaticMarkup(createElement(ToolPayloadView, { payload: saved.args, name: "bash", section: "args", language: "en" }));
  expect(args).toContain("Command");
  expect(args).toContain("bash code");
  expect(args).not.toContain('language-json');
  expect(args).not.toContain("<test>");
  const result = renderToStaticMarkup(createElement(ToolPayloadView, { payload: saved.result, name: "bash", section: "result", language: "ru" }));
  expect(result).toContain("Вывод ошибок");
  expect(result).toMatch(/A full line<\/span><\/div><div[^>]*><span[^>]*>Another line/);
  expect(result).not.toContain("A full line\\nAnother line");
  expect(result).toContain("exit_code");
  expect(result).toContain("Код: json");
  expect(result).toContain("Копировать код");
});

it("falls back for old or invalid records and renders malformed payload text without HTML execution", () => {
  for (const content of [{}, { toolActivity: null }, { toolActivity: { version: 999, calls: [call] } }, { toolActivity: { version: 1, calls: [null, {}] } }]) {
    const view = messageView(row(content), []);
    expect(view.toolActivity).toBeUndefined();
    const html = renderToStaticMarkup(createElement(ResponseChain, { activity: view.toolActivity, thinking: view.thinking, language: "ru", defaultOpen: true }));
    expect(html).toContain("1 вызов инструмента");
    expect(html).toContain("Older saved tool summary");
  }
  const malformed = row({}); malformed.content_json = "{broken";
  expect(() => messageView(malformed, [])).not.toThrow();
  const html = renderToStaticMarkup(createElement(ToolPayloadView, { payload: { format: "json", text: '{"broken": <script>alert(1)</script>', truncated: true }, name: "read", section: "result", language: "ru" }));
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Показан сокращённый результат");
});

it("names tools in plain language and keeps identifiers out of the summary", () => {
  expect(toolLabel("web_search", "en")).toBe("Search the web");
  expect(toolLabel("web_search", "ru")).toBe("Поиск в интернете");
  expect(toolLabel("browser_screenshot", "en")).toBe("Take a screenshot");
  expect(toolLabel("mcp.custom_lookup", "en")).toBe("Mcp custom lookup");
  expect(toolLabel("constructor", "en")).toBe("Constructor");
  const view = messageView(row({ toolActivity: { version: 1, calls: [{ ...call, name: "web_search", status: "running", durationMs: null }], reasoning: ["**Planning**\n\nShown in the live chain"], omittedCalls: 0 } }), []);
  const live = { state: "generating" as const, startedAt: Date.now() - 3_000, queuedTurns: 0 };
  const collapsed = renderToStaticMarkup(createElement(ResponseChain, { activity: view.toolActivity, language: "en", live }));
  expect(collapsed).toContain("Search the web");
  expect(collapsed).toContain("3s");
  expect(collapsed).not.toContain("web_search");
  expect(collapsed).not.toContain("Shown in the live chain");
  const open = renderToStaticMarkup(createElement(ResponseChain, { activity: view.toolActivity, language: "en", live, defaultOpen: true }));
  expect(open).toContain("Shown in the live chain");
  // The identifier stays a data attribute for tests; the visible text uses the friendly name.
  expect(open.replace(/<[^>]+>/g, " ")).not.toContain("web_search");
});

it("orders reasoning and tool calls into one chronological chain", () => {
  const detail = call as ToolCallDetail;
  const first = { ...detail, id: "a", name: "web_search", reasoningBefore: 1 };
  const second = { ...detail, id: "b", name: "bash", reasoningBefore: 2 };
  const { steps } = chainSteps({ version: 1, calls: [first, second], reasoning: ["one", "two", "three"], omittedCalls: 0 }, null);
  expect(steps.map(step => step.kind === "tool" ? step.call.id : step.text)).toEqual(["one", "a", "two", "b", "three"]);
  // Records saved before ordering existed keep reasoning ahead of every call.
  const legacy = chainSteps({ version: 1, calls: [{ ...detail, id: "c" }], reasoning: ["early", "late"], omittedCalls: 0 }, null);
  expect(legacy.steps.map(step => step.kind === "tool" ? step.call.id : step.text)).toEqual(["early", "late", "c"]);
  const saved = messageView(row({ toolActivity: { version: 1, calls: [first], reasoning: ["one"], omittedCalls: 0 } }), []);
  expect(saved.toolActivity?.calls[0]?.reasoningBefore).toBe(1);
});

it("labels finished chains with how long the reply took", () => {
  const detail = call as ToolCallDetail;
  expect(formatElapsed(400, "en")).toBe("1s");
  expect(formatElapsed(32_400, "en")).toBe("32s");
  expect(formatElapsed(74_000, "en")).toBe("1m 14s");
  expect(formatElapsed(120_000, "ru")).toBe("2 мин");
  expect(formatElapsed(3_900_000, "en")).toBe("1h 5m");
  const activity = { version: 1 as const, calls: [{ ...detail, status: "succeeded" as const }], reasoning: ["Checked"], omittedCalls: 0 };
  const render = (props: Partial<Parameters<typeof ResponseChain>[0]>) => renderToStaticMarkup(createElement(ResponseChain, { language: "en", ...props }));
  expect(render({ activity, durationMs: 32_400 })).toContain("Worked for 32s");
  expect(render({ thinking: "Only reasoning", durationMs: 8_000 })).toContain("Thought for 8s");
  expect(render({ durationMs: 4_200 })).toContain("Answered in 4s");
  expect(render({ activity, durationMs: 26_000, stopped: true })).toContain("Stopped after 26s");
  expect(render({ activity })).toContain("1 tool call");
  expect(render({})).toBe("");
  expect(renderToStaticMarkup(createElement(ResponseChain, { language: "ru", activity, durationMs: 74_000 }))).toContain("Готово за 1 мин 14 с");
});

it("renders raw numeric and JSON file output literally without number conversion", () => {
  for (const text of ["0.123456789012345678901234567890", "123.4500", '{ "large": 9007199254740993, "decimal": 123.4500 }', "\n\n123.4500  "]) {
    const view = messageView(row({ toolActivity: { version: 1, calls: [{ ...call, name: "read", result: { format: "text", text, truncated: false } }], reasoning: [], omittedCalls: 0 } }), []);
    const result = view.toolActivity?.calls[0]?.result;
    if (!result) throw new Error("Missing literal output");
    expect(result).toEqual({ format: "text", text, truncated: false });
    const html = renderToStaticMarkup(createElement(ToolPayloadView, { payload: result, name: "read", section: "result", language: "en" }));
    for (const number of text.match(/[\d.]+/g) ?? []) expect(html).toContain(number);
    if (text.startsWith("\n")) expect(html).toContain("123.4500  </span>");
    expect(html).toContain("text code");
  }
});
