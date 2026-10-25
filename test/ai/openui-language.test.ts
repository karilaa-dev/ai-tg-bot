import { fixtureUuid } from "./uuid.js";
import { describe, expect, it } from "vitest";
import { resolveOpenUiLanguage } from "../../src/openui/language.js";
import { currentTurnAssistantResult } from "../../src/ai/currentTurnResult.js";
import { messageView } from "../../src/web/message-view.js";
import type { MessageRow } from "../../src/db/types.js";

const openui = 'root = Stack([Text("Useful detail")])';
const message: MessageRow = {
  id: 1, thread_id: fixtureUuid(2), role: "assistant", kind: "text", text_plain: "An English answer.", thinking: null,
  content_json: JSON.stringify({ openui }), tg_message_id: null, pi_entry_id: null, created_at: 1,
};

describe("generated UI response language", () => {
  it.each([
    ["Охайошечки! Here are my picks for dinner in downtown Bellevue.", "en"],
    ["Вот мои рекомендации для ужина в центре города Bellevue.", "ru"],
    ["Готово.", "ru"],
    ["42", "en"],
    ["English explanation.\n```\nРусские слова внутри кода не меняют язык ответа\n```", "en"],
    ["Русское объяснение. https://example.com/a/long/english/source/page", "ru"],
    ["Русский ответ с `long English variable names inside code`.", "ru"],
  ])("infers legacy response prose: %s", (text, language) => {
    expect(resolveOpenUiLanguage(text)).toBe(language);
  });

  it("prefers validated saved language for short or mixed responses", () => {
    expect(resolveOpenUiLanguage("OK", "ru")).toBe("ru");
    expect(resolveOpenUiLanguage("Охайошечки!", "en")).toBe("en");
    expect(resolveOpenUiLanguage("Русский ответ", { language: "en" })).toBe("ru");
  });

  it("reads language only from successful validated visual completions", () => {
    const result = currentTurnAssistantResult([{
      role: "toolResult", toolCallId: "finish", toolName: "finish_response", isError: false, timestamp: 1,
      content: [{ type: "text", text: "completed" }], details: { completed: true, text: "OK", openui, openuiLanguage: "ru" },
    }]);
    expect(result.openuiLanguage).toBe("ru");
    expect(currentTurnAssistantResult([{
      role: "toolResult", toolCallId: "finish", toolName: "finish_response", isError: false, timestamp: 1,
      content: [{ type: "text", text: "completed" }], details: { completed: true, text: "OK", openui: "invalid", openuiLanguage: "ru" },
    }]).openuiLanguage).toBeUndefined();
  });

  it("projects stable language for new and legacy saved messages without viewer settings", () => {
    expect(messageView(message, []).openuiLanguage).toBe("en");
    expect(messageView({ ...message, text_plain: "Вот как произошёл сбой системы." }, []).openuiLanguage).toBe("ru");
    expect(messageView({ ...message, content_json: JSON.stringify({ openui, openuiLanguage: "ru" }) }, []).openuiLanguage).toBe("ru");
    expect(messageView({ ...message, role: "user" }, []).openuiLanguage).toBeUndefined();
    expect(messageView(message, [], [], true).openuiLanguage).toBeUndefined();
    expect(messageView({ ...message, content_json: JSON.stringify({ openui: "invalid", openuiLanguage: "ru" }) }, []).openuiLanguage).toBeUndefined();
  });
});
