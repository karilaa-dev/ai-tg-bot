import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { assertCompactionUseful, COMPACTION_COOLDOWN_MS } from "../../src/pi/compactionPolicy.js";

function fixture() {
  const sessionManager = SessionManager.inMemory();
  const session = { sessionManager, settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1000 } }), model: undefined };
  const append = (text = "Useful conversation context. ".repeat(1600)) => sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  return { session, append };
}

afterEach(() => vi.useRealTimers());

describe("manual compaction eligibility", () => {
  it("rejects an empty or short conversation and allows substantial active context", () => {
    const { session, append } = fixture();
    expect(() => assertCompactionUseful(session)).toThrow(expect.objectContaining({ reason: "too_small" }));
    append("Hello");
    expect(() => assertCompactionUseful(session)).toThrow(expect.objectContaining({ reason: "too_small" }));
    append();
    expect(() => assertCompactionUseful(session)).not.toThrow();
  });

  it("uses retained context after compaction, not the full saved history", () => {
    vi.useFakeTimers();
    const { session, append } = fixture();
    append(); append();
    const tail = append("A short retained message");
    session.sessionManager.appendCompaction("A short summary", tail, 30000);
    vi.advanceTimersByTime(COMPACTION_COOLDOWN_MS + 1);
    append("Next question");
    expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toHaveLength(4);
    expect(() => assertCompactionUseful(session)).toThrow(expect.objectContaining({ reason: "too_small" }));
  });

  it("requires enough context beyond the configured retained tail", () => {
    const { session, append } = fixture();
    append();
    expect(() => assertCompactionUseful({ ...session,
      settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 20_000 } }),
    })).toThrow(expect.objectContaining({ reason: "too_small" }));
  });

  it("rejects a recent compaction even with large new context, then permits it after the cooldown", () => {
    vi.useFakeTimers();
    const { session, append } = fixture();
    const first = append();
    session.sessionManager.appendCompaction("Summary", first, 12000);
    append();
    expect(() => assertCompactionUseful(session)).toThrow(expect.objectContaining({ reason: "recent", retryAt: Date.now() + COMPACTION_COOLDOWN_MS }));
    vi.advanceTimersByTime(COMPACTION_COOLDOWN_MS + 1);
    expect(() => assertCompactionUseful(session)).not.toThrow();
  });

  it("requires meaningful new context even when the retained summary is large", () => {
    vi.useFakeTimers();
    const { session, append } = fixture();
    const tail = append("A retained message");
    session.sessionManager.appendCompaction("Important retained facts. ".repeat(1800), tail, 40000);
    vi.advanceTimersByTime(COMPACTION_COOLDOWN_MS + 1);
    append("Thanks");
    expect(() => assertCompactionUseful(session)).toThrow(expect.objectContaining({ reason: "unchanged" }));
    append("New information. ".repeat(1000));
    expect(() => assertCompactionUseful(session)).not.toThrow();
  });

  it("accounts for context edits rather than pruned raw tool output", () => {
    const { session } = fixture();
    const entry = session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "execute",
      content: [{ type: "text", text: "Old tool output. ".repeat(4000) }], isError: false, timestamp: Date.now() });
    session.sessionManager.appendContextEdit(entry, { content: [{ type: "text", text: "Shortened tool result" }] });
    expect(() => assertCompactionUseful(session)).toThrow(expect.objectContaining({ reason: "too_small" }));
  });
});
