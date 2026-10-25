import { describe, expect, it } from "vitest";
import { finishResponseOpenUi } from "../../src/ai/openui.js";
import { openUiExamples, openUiInstructions } from "../../src/openui/library.js";
import { safeOpenUi, validateOpenUi } from "../../src/openui/validate.js";
import { currentTurnAssistantResult } from "../../src/ai/currentTurnResult.js";
import { messageView } from "../../src/web/message-view.js";
import type { MessageRow } from "../../src/db/types.js";
import { savedRestaurantOpenUi } from "../web/openui-saved-fixture.js";

const source = 'root = Stack([card, next])\ncard = Card("Comparison", [Text("Two options"), Table("Plans", ["Name", "Price"], [["Basic", "$10"], ["Pro", "$20"]])])\nnext = Button("Choose basic", "Tell me more about the Basic plan.")';

describe("OpenUI admission", () => {
  it("preserves the saved restaurant comparison and validates referenced table rows", () => {
    expect(validateOpenUi(savedRestaurantOpenUi)).toBe(savedRestaurantOpenUi);
    expect(safeOpenUi(savedRestaurantOpenUi.replace(',"Lincoln Square"', ""))).toBeUndefined();
  });

  it("validates the actual SDK grammar and normalizes the trusted library", () => {
    const normalized = validateOpenUi(source);
    expect(normalized).toContain('root = Stack([card,next])');
    expect(validateOpenUi(normalized)).toBe(normalized);
    expect(openUiInstructions()).toContain('Table(caption: string, columns: string[], rows: string[][])');
  });

  it("keeps every rich visual prompt example valid against the real SDK and validator", () => {
    for (const example of openUiExamples) expect(validateOpenUi(validateOpenUi(example))).toBe(validateOpenUi(example));
    expect(validateOpenUi('root = Stack([Grid([Card("Lake", [Image("file:42", "Lake at sunrise", "Trail photo")]), Metric("Distance", "9 km", "Valley route")])])')).toContain('Image("file:42"');
  });

  it.each([
    'root = Stack([Image("https://example.com/track.png", "Alt", "Caption")])',
    'root = Stack([Image("/api/chat/threads/2/files/3", "Alt", "Caption")])',
    'root = Stack([Image("data:image/svg+xml,evil", "Alt", "Caption")])',
    'root = Stack([Image("blob:https://example.com/fake", "Alt", "Caption")])',
    'root = Stack([Image("file:0", "Alt", "Caption")])',
    'root = Stack([Image("file:9007199254740992", "Alt", "Caption")])',
    'root = Stack([Image("file:42?token=secret", "Alt", "Caption")])',
    'root = Stack([Image("file:42", "", "Caption")])',
    'root = Stack([Image("file:42", "Alt")])',
    'root = Stack([Text("visible", "silently ignored extra argument")])',
    'root = Stack([Metric("Count", "12", "Context", "red")])',
    'root = Stack([BarChart("Distance", ["A", "B"], ["5"], "km")])',
    'root = Stack([BarChart("Distance", ["A"], ["NaN"], "km")])',
    'root = Stack([BarChart("Distance", ["A"], ["-5"], "km")])',
    'root = Stack([BarChart("Distance", ["A"], ["5;alert(1)"], "km")])',
    'root = Stack([BarChart("Distance", ["A"], ["1e999"], "km")])',
    'root = Stack([Steps("Plan", ["First", "Second"], ["Only one" ])])',
    'root = Stack([Grid([Grid([Metric("Count", "12", "Context")])])])',
    'root = Stack([Card("Nested", [Grid([Image("file:1", "Alt", "")])])])',
    'root = Stack([Grid([Text("Wrong child")])])',
    'root = Stack([constructor])\nconstructor = Text("Reserved")',
    `root = Stack([Grid([${Array.from({ length: 6 }, () => 'Image("file:1", "Alt", "")').join(",")}]),Grid([${Array.from({ length: 6 }, () => 'Image("file:2", "Alt", "")').join(",")}]),Image("file:3","Alt","")])`,
  ])("rejects unsafe images, malformed visuals and discarded arguments: %.85s", value => {
    expect(safeOpenUi(value)).toBeUndefined();
  });

  it("accepts zero-valued charts and bounded decimal quantities", () => {
    const zero = 'root = Stack([BarChart("Count", ["A", "B"], ["0", "0.000001"], "items")])';
    expect(validateOpenUi(zero)).toContain('["0","0.000001"]');
  });

  it.each([
    'root = Stack([Text("unfinished")]',
    'root = Stack([Text("a") Text("b")])',
    'root = Stack([Text("a")]) trailing',
    'root = Stack([Text("a")]); alert("evil")',
    'root = Stack([Text("a")])\nignored rubbish',
    'root = Stack([Text("a")])\nroot = Stack([Text("b")])',
    'root = Stack([root])',
    'root = Stack([a])\na = Card("Cycle", [b])\nb = Card("Cycle", [a])',
    'root = Stack([missing])',
    'root = Stack([Text("a")])\norphan = Text("hidden")',
    'root = Stack([Html("<script>alert(1)</script>")])',
    'root = Stack([Text(1 + 2)])',
    'root = Stack([Text($value)])',
    'root = Stack([Text(@Fetch("https://example.com"))])',
    'root = Stack([Text("a")])\nquery = Query("fetch", {})',
    'root = Stack([Button("Open", Action([OpenUrl("javascript:alert(1)")]))])',
    'root = Stack([Card("Empty", [])])',
    'root = Stack([Table("Plan", ["One"], [["one", "two"]])])',
    `root = Stack([Text(${JSON.stringify("x".repeat(8_001))})])`,
    `root = Stack([${Array.from({ length: 13 }, () => 'Text("a")').join(",")}])`,
    `root = Stack([Text("a")])${" ".repeat(24_000)}`,
  ])("rejects incomplete, unsupported and oversized source: %.70s", value => {
    expect(safeOpenUi(value)).toBeUndefined();
  });

  it("bounds repeated-reference expansion before the SDK materializes the tree", () => {
    const lines = ['root = Stack([a])'];
    for (const [name, next] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]]) lines.push(`${name} = Card("Fanout", [${Array(12).fill(next).join(",")}])`);
    lines.push('e = Text("End")');
    expect(() => validateOpenUi(lines.join("\n"))).toThrow(/expansion/u);
  });

  it("enforces creation origin and requires accessible fallback text", () => {
    expect(() => finishResponseOpenUi({ origin: "telegram" }, source, "Summary")).toThrow(/threads created on the website/u);
    expect(() => finishResponseOpenUi({ origin: "web" }, source, " ")).toThrow(/accompanying answer/u);
    expect(finishResponseOpenUi({ origin: "web" }, source, "Summary")).toBe(validateOpenUi(source));
    expect(finishResponseOpenUi({ origin: "telegram" }, undefined, "Summary")).toBeUndefined();
  });

  it("extracts only completed tool payloads, keeping DSL out of final text", () => {
    const result = currentTurnAssistantResult([{
      role: "toolResult", toolCallId: "finish", toolName: "finish_response", isError: false, timestamp: 1,
      content: [{ type: "text", text: "completed" }], details: { completed: true, text: "Summary", openui: source },
    }]);
    expect(result).toEqual({ completed: true, stopReason: "stop", text: "Summary", openui: validateOpenUi(source), openuiLanguage: "en" });
  });

  it.each([
    { isError: false, details: { completed: false, text: "Draft", openui: source } },
    { isError: true, details: { completed: true, text: "Failed", openui: source } },
    { isError: false, details: { completed: true, text: "", openui: source } },
    { isError: false, details: { completed: true, text: "Summary", openui: 'root = Stack([Image("https://example.com/image.png", "Alt", "")])' } },
  ])("keeps uncompleted, failed, fallback-free and invalid visuals out of delivery", payload => {
    const result = currentTurnAssistantResult([{
      role: "toolResult", toolCallId: "finish", toolName: "finish_response", timestamp: 1,
      content: [{ type: "text", text: "result" }], ...payload,
    }]);
    expect(result.openui).toBeUndefined();
  });

  it("serves saved assistant UI while preserving fallback text and ignoring user payloads", () => {
    const message: MessageRow = {
      id: 1, thread_id: 2, role: "assistant", kind: "text", text_plain: "Summary", thinking: null,
      content_json: JSON.stringify({ text: "Summary", openui: source }), tg_message_id: null, pi_entry_id: null, created_at: 1,
    };
    expect(messageView(message, [])).toMatchObject({ text: "Summary", openui: validateOpenUi(source) });
    expect(messageView({ ...message, role: "user" }, []).openui).toBeUndefined();
    expect(messageView({ ...message, text_plain: "" }, []).openui).toBeUndefined();
    expect(messageView({ ...message, content_json: JSON.stringify({ openui: "invalid" }) }, [])).toMatchObject({ text: "Summary" });
    expect(messageView({ ...message, content_json: "invalid json" }, []).openui).toBeUndefined();
  });
});
