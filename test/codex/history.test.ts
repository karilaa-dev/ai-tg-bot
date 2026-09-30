import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { codexRolloutHistory, convertPiSessionEntries, loadThreadHistory, normalizeHistoryCallIds } from "../../src/codex/history.js";

function session(...entries: unknown[]): string {
  return [{ type: "session", version: 3, id: "old-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/old/bot" }, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n";
}

function entry(id: string, parentId: string | null, role: string, content: unknown, extra: object = {}): object {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content, ...extra } };
}

const nativeRecord = (type: string, payload: object) => ({ type, timestamp: "2026-01-01T00:00:00.000Z", payload });
const nativeMessage = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const nativeTurn = (id: string, text: string, response?: string) => [
  nativeRecord("event_msg", { type: "task_started", turn_id: id }),
  nativeRecord("turn_context", { turn_id: id }),
  nativeRecord("response_item", nativeMessage("user", text)),
  ...(response ? [nativeRecord("response_item", nativeMessage("assistant", response))] : []),
  nativeRecord("event_msg", { type: "task_complete", turn_id: id, ...(response ? {} : { error: { message: "Rejected before output" } }) }),
];

describe("persisted native history repair", () => {
  it("rolls back the latest real user turn together with a newer manual compaction turn", () => {
    const source = [
      nativeRecord("session_meta", { id: "manual-compaction" }),
      nativeRecord("response_item", nativeMessage("user", "Imported legacy user")),
      ...nativeTurn("first", "First real native user", "First real native answer"),
      ...nativeTurn("second", "Second real native user", "Second real native answer"),
      nativeRecord("event_msg", { type: "task_started", turn_id: "manual" }),
      nativeRecord("compacted", { replacement_history: [nativeMessage("user", "Manual summary of both native turns")] }),
      nativeRecord("event_msg", { type: "task_complete", turn_id: "manual" }),
      nativeRecord("event_msg", { type: "thread_rolled_back", num_turns: 1 }),
    ].map(value => JSON.stringify(value)).join("\n");
    const history = codexRolloutHistory(source);
    expect(JSON.stringify(history.items)).toContain("Imported legacy user");
    expect(JSON.stringify(history.items)).toContain("First real native answer");
    expect(JSON.stringify(history.items)).not.toContain("Second real native");
    expect(JSON.stringify(history.items)).not.toContain("Manual summary");
    expect(history.turnIds).toEqual(["first"]);
    const manual = codexRolloutHistory(source.split("\n").slice(0, -1).join("\n"), { lastTurnId: "manual" });
    expect(JSON.stringify(manual.items)).toContain("Manual summary");
  });

  it("matches native tolerant loading for unknown audit records and a truncated tail", () => {
    const source = [
      JSON.stringify(nativeRecord("session_meta", { id: "truncated-audit" })),
      JSON.stringify(nativeRecord("response_item", nativeMessage("user", "Preserved request"))),
      JSON.stringify(nativeRecord("response_item", nativeMessage("assistant", "Preserved answer"))),
      JSON.stringify({ type: "unknown_audit", payload: { future: true } }),
      '{"type":"event_msg","payload":',
    ].join("\n");
    expect(codexRolloutHistory(source).items).toEqual([nativeMessage("user", "Preserved request"), nativeMessage("assistant", "Preserved answer")]);
    expect(codexRolloutHistory(source).invalidCallIds).toBe(0);
    expect(() => codexRolloutHistory('{"type":"session_meta"')).toThrow("header");
  });

  it("retains the active summary, later tools, and unanswered failed users while excluding rolled-back compactions and preserving old fork cutoffs", () => {
    const long = "a".repeat(83);
    const kept = "b".repeat(84);
    const source = [
      nativeRecord("session_meta", { id: "native-source", history_mode: "paginated" }),
      nativeRecord("response_item", nativeMessage("user", "Old raw prefix")),
      nativeRecord("response_item", { type: "function_call", name: "read", call_id: long, arguments: '{"file_id":17}' }),
      nativeRecord("response_item", { type: "function_call_output", call_id: long, output: "Old raw result" }),
      ...nativeTurn("before", "Before compaction", "Successful answer before compaction"),
      nativeRecord("event_msg", { type: "task_started", turn_id: "after" }),
      nativeRecord("turn_context", { turn_id: "after" }),
      nativeRecord("response_item", nativeMessage("user", "After compaction")),
      nativeRecord("compacted", { replacement_history: [nativeMessage("user", "Compacted summary [[chat-file:17]]"), { type: "function_call", call_id: kept, name: "read", arguments: "{}" }, { type: "function_call_output", call_id: kept, output: "Preserved compacted result" }] }),
      nativeRecord("response_item", nativeMessage("assistant", "Successful answer after compaction")),
      nativeRecord("event_msg", { type: "task_complete", turn_id: "after" }),
      nativeRecord("event_msg", { type: "image_generation_end", saved_path: "/codex/generated_images/native-source/image.png" }),
      nativeRecord("event_msg", { type: "item_completed", item: { type: "imageGeneration", savedPath: "/codex/generated_images/native-source/other.png" } }),
      nativeRecord("event_msg", { type: "task_started", turn_id: "rollback" }),
      nativeRecord("response_item", nativeMessage("user", "Rolled back request")),
      nativeRecord("event_msg", { type: "image_generation_end", saved_path: "/codex/generated_images/native-source/rolled-back.png" }),
      nativeRecord("compacted", { replacement_history: [nativeMessage("user", "Rolled back summary")] }),
      nativeRecord("event_msg", { type: "thread_rolled_back", num_turns: 1 }),
      ...nativeTurn("failed", "Unanswered failed request"),
    ].map(value => JSON.stringify(value)).join("\n");
    const history = codexRolloutHistory(source);
    const serialized = JSON.stringify(history.items);
    expect(serialized).toContain("Compacted summary [[chat-file:17]]");
    expect(serialized).toContain("Preserved compacted result");
    expect(serialized).toContain("Successful answer after compaction");
    expect(serialized).not.toContain("Old raw prefix");
    expect(serialized).not.toContain("Rolled back");
    expect(serialized.match(/Unanswered failed request/g)).toHaveLength(1);
    expect(history.invalidCallIds).toBe(1);
    expect(history.turnIds).toEqual(["before", "after", "failed"]);
    expect(history.artifactPaths).toEqual(["/codex/generated_images/native-source/image.png", "/codex/generated_images/native-source/other.png"]);
    const calls = history.items.filter(item => item.call_id);
    expect(calls[0]!.call_id).toBe(calls[1]!.call_id);
    expect(String(calls[0]!.call_id).length).toBeLessThanOrEqual(64);
    const fork = codexRolloutHistory(source, { lastTurnId: "before" });
    expect(JSON.stringify(fork.items)).toContain("Old raw result");
    expect(JSON.stringify(fork.items)).toContain("Successful answer before compaction");
    expect(JSON.stringify(fork.items)).not.toContain("After compaction");
    expect(fork.turnIds).toEqual(["before"]);
    expect(fork.artifactPaths).toEqual([]);
    const failedFork = codexRolloutHistory(source, { lastTurnId: "failed" });
    expect(JSON.stringify(failedFork.items).match(/Unanswered failed request/g)).toHaveLength(1);
    expect(failedFork.turnIds).toEqual(["before", "after", "failed"]);
    expect(() => codexRolloutHistory(source, { lastTurnId: "absent" })).toThrow("fork turn");
  });

  it("does not repair invalid raw IDs that have already been replaced by a valid compacted window", () => {
    const history = codexRolloutHistory([
      nativeRecord("session_meta", { id: "valid-window" }),
      nativeRecord("response_item", { type: "function_call", name: "old", call_id: "x".repeat(83), arguments: "{}" }),
      nativeRecord("compacted", { replacement_history: [{ item: nativeMessage("user", "Valid current summary") }] }),
    ].map(value => JSON.stringify(value)).join("\n"));
    expect(history.invalidCallIds).toBe(0);
    expect(history.items).toEqual([nativeMessage("user", "Valid current summary")]);
  });

  it("bounds old compaction text and discards old media instead of expanding the raw history", () => {
    const history = codexRolloutHistory([
      nativeRecord("session_meta", { id: "old-compaction" }),
      nativeRecord("response_item", nativeMessage("user", "obsolete ".repeat(20_000))),
      nativeRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Recent request" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }),
      nativeRecord("compacted", { message: "Old local summary" }),
    ].map(value => JSON.stringify(value)).join("\n"));
    expect(JSON.stringify(history.items)).toContain("Recent request");
    expect(JSON.stringify(history.items)).toContain("Old local summary");
    expect(JSON.stringify(history.items)).not.toContain("input_image");
    expect(JSON.stringify(history.items).length).toBeLessThan(81_000);
  });
});

describe("Pi history conversion", () => {
  it("normalizes long paired ids deterministically without truncation collisions or changing valid ids", () => {
    const long = `call_${"a".repeat(78)}`;
    const other = `${long.slice(0, -1)}b`;
    const collision = `pi_${createHash("sha256").update(long).digest("base64url")}`;
    const values = [long, other, collision, "valid-id"].flatMap(call_id => [{ type: "function_call", call_id }, { type: "function_call_output", call_id }]);
    const normalized = normalizeHistoryCallIds(values);
    expect(normalized).toEqual(normalizeHistoryCallIds(values));
    expect(normalized.every(item => item.call_id.length <= 64)).toBe(true);
    expect(new Set(normalized.map(item => item.call_id))).toHaveProperty("size", 4);
    for (let index = 0; index < normalized.length; index += 2) expect(normalized[index]!.call_id).toBe(normalized[index + 1]!.call_id);
    expect(normalized[4]!.call_id).toBe(collision);
    expect(normalized[6]!.call_id).toBe("valid-id");
    expect(values[0]!.call_id).toBe(long);
    expect(normalizeHistoryCallIds(normalized)).toEqual(normalized);
  });
  it("retains the active compacted branch, summary data, images, and paired tool results", () => {
    const input = session(
      entry("u1", null, "user", "Remember [[chat-file:41]] and the original request."),
      entry("abandoned", "u1", "assistant", [{ type: "text", text: "Other branch secret" }]),
      entry("a1", "u1", "assistant", [{ type: "text", text: "Inspecting the file." }, { type: "toolCall", id: "call1", name: "read", arguments: { file_id: 41 } }]),
      entry("t1", "a1", "toolResult", [{ type: "text", text: "Original file result" }], { toolCallId: "call1", toolName: "read", details: { file_id: 41, path: "/home/user/workspace/report.pdf" } }),
      { type: "compaction", id: "c1", parentId: "t1", timestamp: "2026-01-01T00:00:00.000Z", summary: "The report is file #41.", firstKeptEntryId: "a1", tokensBefore: 200, details: { fileIds: [41] } },
      { type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-01-01T00:00:00.000Z", fromId: "abandoned", summary: "Returned to the report task." },
      entry("u2", "b1", "user", [{ type: "text", text: "Use this image" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }]),
    );
    const output = convertPiSessionEntries(input);
    const serialized = JSON.stringify(output.items);
    expect(serialized).not.toContain("original request");
    expect(serialized).toContain("The report is file #41");
    expect(serialized).toContain('\\"fileIds\\":[41]');
    expect(serialized).toContain("Returned to the report task");
    expect(serialized).toContain("/home/user/workspace/report.pdf");
    expect(serialized).toContain("data:image/png;base64,aGVsbG8=");
    expect(serialized).not.toContain("Other branch secret");
    expect(output.items).toContainEqual({ type: "function_call", name: "read", arguments: '{"file_id":41}', call_id: "call1" });
    expect(output.items).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call1" }));
    expect(output.entryIds).toEqual(["u1", "a1", "t1", "c1", "b1", "u2"]);
  });

  it("honors context edits while preserving terminal response data and artifact ids", () => {
    const output = convertPiSessionEntries(session(
      entry("u", null, "user", "Make the document"),
      entry("a", "u", "assistant", [{ type: "toolCall", id: "done", name: "finish_response", arguments: { text: "Document ready", files: ["/home/user/workspace/document.docx"] } }]),
      entry("t", "a", "toolResult", [{ type: "text", text: "obsolete large output" }], { toolCallId: "done", toolName: "finish_response", details: { completed: true, text: "Document ready", files: [{ file_id: 17 }] } }),
      { type: "context_edit", id: "edit", parentId: "t", timestamp: "2026-01-01T00:00:00.000Z", targetId: "t", replacement: { content: [{ type: "text", text: "Shortened result [[chat-file:17]]" }] } },
    ));
    expect(JSON.stringify(output.items)).not.toContain("obsolete large output");
    expect(JSON.stringify(output.items)).toContain("Shortened result [[chat-file:17]]");
    expect(JSON.stringify(output.items)).toContain('\\"file_id\\":17');
    expect(JSON.stringify(output.items)).toContain("Document ready");
  });

  it("supports old flat version-one sessions without modifying the provided entries", () => {
    const original = [{ type: "session", version: 1, id: "legacy", timestamp: "2025-01-01", cwd: "/old" },
      { type: "message", message: { role: "user", content: "Remember this legacy detail" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I remember" }] } }];
    const input = original.map(entry => JSON.stringify(entry)).join("\n");
    expect(JSON.stringify(convertPiSessionEntries(input).items)).toContain("legacy detail");
    expect(original[1]).not.toHaveProperty("id");
  });

  it("truncates at a requested old fork entry and rejects missing or cyclic branches", () => {
    const input = session(entry("u", null, "user", "Fork here"), entry("a", "u", "assistant", [{ type: "text", text: "Future answer" }]));
    expect(JSON.stringify(convertPiSessionEntries(input, { piEntryId: "u" }).items)).not.toContain("Future answer");
    expect(() => convertPiSessionEntries(input, { piEntryId: "missing" })).toThrow("missing");
    expect(() => convertPiSessionEntries(session(entry("loop", "loop", "user", "cycle")))).toThrow("cyclic");
  });

  it("closes interrupted calls and retains orphan outputs without invalid tool pairs", () => {
    const interrupted = convertPiSessionEntries(session(entry("a", null, "assistant", [{ type: "toolCall", id: "unfinished", name: "bash", arguments: { command: "pwd" } }])));
    expect(interrupted.items.at(-1)).toMatchObject({ type: "function_call_output", call_id: "unfinished", output: expect.stringContaining("interrupted") });
    const orphan = convertPiSessionEntries(session(entry("t", null, "toolResult", [{ type: "text", text: "Preserved orphan [[chat-file:9]]" }], { toolCallId: "missing", toolName: "read" })));
    expect(orphan.items[0]).toMatchObject({ type: "message", role: "user" });
    expect(JSON.stringify(orphan.items)).toContain("[[chat-file:9]]");
  });
});

describe("existing conversation import", () => {
  let database: AppDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await database?.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function setup(): Promise<Repos> {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 42, firstName: "Existing", lang: "en" });
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-history-"));
    return repos;
  }

  it("imports Pi history, supplements undelivered database-only context, and leaves the source file unchanged", async () => {
    const repos = await setup();
    const thread = await repos.threads.create({ userId: 42, topicId: null, title: "Old chat" });
    const sessionFile = path.join(directory!, "old.jsonl");
    const content = session(entry("u", null, "user", "Old request [[chat-file:4]]"), entry("a", "u", "assistant", [{ type: "text", text: "Old answer" }]));
    await writeFile(sessionFile, content);
    await repos.threads.setPiSession(thread.id, sessionFile, "old-session");
    await repos.messages.insert({ threadId: thread.id, role: "user", content: { text: "Old request [[chat-file:4]]" }, textPlain: "Old request [[chat-file:4]]", piEntryId: "u" });
    await repos.messages.insert({ threadId: thread.id, role: "assistant", content: { text: "Old answer" }, textPlain: "Old answer", piEntryId: "a" });
    const fallback = await repos.messages.insert({ threadId: thread.id, role: "user", content: { text: "Fallback-only detail", file_ids: [7] }, textPlain: "Fallback-only detail" });
    const active = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Current question" });
    const imported = await loadThreadHistory({ repos, thread: (await repos.threads.get(thread.id))!, maxMessageId: active.id - 1 });
    expect(imported.source).toBe("pi");
    expect(imported.snapshotMessageId).toBe(fallback.id);
    expect(JSON.stringify(imported.items)).toContain("Fallback-only detail");
    expect(JSON.stringify(imported.items)).toContain('\\"file_ids\\":[7]');
    expect(JSON.stringify(imported.items)).not.toContain("Current question");
    expect(imported.items.filter(item => item.type === "message" && item.content.some(part => part.type !== "input_image" && part.text === "Old answer"))).toHaveLength(1);
    expect(await readFile(sessionFile, "utf8")).toBe(content);
    expect((await repos.threads.get(thread.id))?.codex_thread_id).toBeNull();
  });

  it("recovers a missing or broken Pi file from the bounded database branch", async () => {
    const repos = await setup();
    const parent = await repos.threads.create({ userId: 42, topicId: null, title: "Parent" });
    const shared = await repos.messages.insert({ threadId: parent.id, role: "user", content: {}, textPlain: "Shared detail" });
    await repos.messages.insert({ threadId: parent.id, role: "assistant", content: {}, textPlain: "Parent future secret" });
    const child = await repos.threads.create({ userId: 42, topicId: 99, title: "Fork", parentThreadId: parent.id, forkPointMessageId: shared.id });
    const own = await repos.messages.insert({ threadId: child.id, role: "user", content: { file_ids: [21] }, textPlain: "Child detail [[chat-file:21]]" });
    const active = await repos.messages.insert({ threadId: child.id, role: "user", content: {}, textPlain: "Queued future" });
    for (const sessionFile of [path.join(directory!, "missing.jsonl"), path.join(directory!, "broken.jsonl")]) {
      if (sessionFile.endsWith("broken.jsonl")) await writeFile(sessionFile, session(entry("orphan", "lost-parent", "user", "partial context")) + '{"truncated"');
      await repos.threads.setPiSession(child.id, sessionFile, "legacy");
      const history = await loadThreadHistory({ repos, thread: (await repos.threads.get(child.id))!, maxMessageId: active.id - 1 });
      expect(history.source).toBe("database");
      expect(history.snapshotMessageId).toBe(own.id);
      expect(JSON.stringify(history.items)).toContain("Shared detail");
      expect(JSON.stringify(history.items)).toContain("Child detail [[chat-file:21]]");
      expect(JSON.stringify(history.items)).not.toContain("Parent future secret");
      expect(JSON.stringify(history.items)).not.toContain("Queued future");
    }
  });

  it("catches up fallback messages after a checkpoint without replaying Pi or later queued turns", async () => {
    const repos = await setup();
    const thread = await repos.threads.create({ userId: 42, topicId: null, title: "Resumed" });
    const before = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Already imported" });
    const fallback = await repos.messages.insert({ threadId: thread.id, role: "assistant", content: {}, textPlain: "OpenRouter answer" });
    const active = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Current accepted question" });
    const history = await loadThreadHistory({ repos, thread, afterMessageId: before.id, maxMessageId: active.id - 1 });
    expect(history.snapshotMessageId).toBe(fallback.id);
    expect(JSON.stringify(history.items)).toContain("OpenRouter answer");
    expect(JSON.stringify(history.items)).not.toContain("Already imported");
    expect(JSON.stringify(history.items)).not.toContain("Current accepted question");
    const unchanged = await loadThreadHistory({ repos, thread, afterMessageId: fallback.id, maxMessageId: fallback.id });
    expect(unchanged).toEqual({ items: [], source: "empty", snapshotMessageId: fallback.id });
  });

  it("advances past native assistant rows after failed delivery without duplicating them, while importing fallback continuations", async () => {
    const repos = await setup();
    const thread = await repos.threads.create({ userId: 42, topicId: null, title: "Missed delivery checkpoint" });
    const accepted = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Accepted native question", piEntryId: "codex:turn-1" });
    const native = await repos.messages.insert({ threadId: thread.id, role: "assistant", content: {}, textPlain: "Native answer already in its rollout", piEntryId: "codex:turn-1" });
    const skipped = await loadThreadHistory({ repos, thread, afterMessageId: accepted.id, maxMessageId: native.id, skipNativeLinkedMessages: true });
    expect(skipped).toEqual({ items: [], source: "empty", snapshotMessageId: native.id });
    await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Fallback question", piEntryId: "openrouter:user-1" });
    const fallback = await repos.messages.insert({ threadId: thread.id, role: "assistant", content: {}, textPlain: "Fallback answer", piEntryId: "openrouter:answer-1" });
    const queued = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Later queued question" });
    const catchup = await loadThreadHistory({ repos, thread, afterMessageId: accepted.id, maxMessageId: queued.id - 1, skipNativeLinkedMessages: true });
    expect(catchup.snapshotMessageId).toBe(fallback.id);
    expect(JSON.stringify(catchup.items)).toContain("Fallback question");
    expect(JSON.stringify(catchup.items)).toContain("Fallback answer");
    expect(JSON.stringify(catchup.items)).not.toContain("Native answer");
    expect(JSON.stringify(catchup.items)).not.toContain("Later queued question");
    // A missing native rollout must rebuild from every durable row instead.
    const rebuilt = await loadThreadHistory({ repos, thread, maxMessageId: fallback.id });
    expect(JSON.stringify(rebuilt.items)).toContain("Native answer already in its rollout");
    expect(JSON.stringify(rebuilt.items)).toContain("Accepted native question");
  });

  it("excludes persisted future Pi entries using the accepted database message bound", async () => {
    const repos = await setup();
    const thread = await repos.threads.create({ userId: 42, topicId: null, title: "Bounded" });
    const old = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Visible", piEntryId: "old" });
    await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Future private detail", piEntryId: "future" });
    const file = path.join(directory!, "future.jsonl");
    await writeFile(file, session(entry("old", null, "user", "Visible"), entry("future", "old", "user", "Future private detail")));
    const history = await loadThreadHistory({ repos, thread: { ...thread, pi_session_file: file }, maxMessageId: old.id });
    expect(JSON.stringify(history.items)).toContain("Visible");
    expect(JSON.stringify(history.items)).not.toContain("Future private detail");
  });

  it("imports a legacy fork from its selected Pi entry when the target references the parent's session file", async () => {
    const repos = await setup();
    const parent = await repos.threads.create({ userId: 42, topicId: null, title: "Old source" });
    const file = path.join(directory!, "shared-source.jsonl");
    await writeFile(file, session(
      entry("u", null, "user", "Original detail"),
      { type: "compaction", id: "summary", parentId: "u", timestamp: "2026-01-01T00:00:00.000Z", summary: "Original compacted detail", firstKeptEntryId: "u", tokensBefore: 10 },
      entry("fork", "summary", "assistant", [{ type: "text", text: "Fork answer" }]),
      entry("future", "fork", "user", "Parent future private instruction"),
    ));
    await repos.threads.setPiSession(parent.id, file, "old-parent");
    await repos.messages.insert({ threadId: parent.id, role: "user", content: {}, textPlain: "Original detail", piEntryId: "u" });
    const forkPoint = await repos.messages.insert({ threadId: parent.id, role: "assistant", content: {}, textPlain: "Fork answer", piEntryId: "fork" });
    await repos.messages.insert({ threadId: parent.id, role: "user", content: {}, textPlain: "Parent future private instruction", piEntryId: "future" });
    const target = await repos.threads.create({ userId: 42, topicId: 456, title: "New fork", parentThreadId: parent.id, forkPointMessageId: forkPoint.id });
    await repos.threads.setPiSession(target.id, file, "old-parent");
    await repos.messages.insert({ threadId: target.id, role: "user", content: {}, textPlain: "The fork's own later detail" });
    const history = await loadThreadHistory({ repos, thread: (await repos.threads.get(target.id))! });
    expect(history.source).toBe("pi");
    expect(JSON.stringify(history.items)).toContain("Original detail");
    expect(JSON.stringify(history.items)).toContain("Original compacted detail");
    expect(JSON.stringify(history.items)).toContain("Fork answer");
    expect(JSON.stringify(history.items)).toContain("The fork's own later detail");
    expect(JSON.stringify(history.items)).not.toContain("Parent future private instruction");
  });

  it("imports a long compacted conversation's active window without reintroducing linked or unlinked summarized database rows", async () => {
    const repos = await setup();
    const thread = await repos.threads.create({ userId: 42, topicId: null, title: "Long old chat" });
    const file = path.join(directory!, "long-compacted.jsonl");
    const entries: unknown[] = [];
    let parentId: string | null = null;
    for (let index = 0; index < 6; index++) {
      const id = `old-${index}`;
      const text = `Summarized raw message ${index}: ${"old verbose conversation ".repeat(4_000)}`;
      entries.push(entry(id, parentId, "user", text));
      await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: text, ...(index % 2 ? { piEntryId: id } : {}) });
      parentId = id;
    }
    entries.push(entry("kept", parentId, "user", "Active request [[chat-file:41]]"));
    entries.push({ type: "compaction", id: "compact", parentId: "kept", timestamp: "2026-01-01T00:00:00.000Z", summary: "Remember the migration phrase EMERALD and report file #41.", firstKeptEntryId: "kept", tokensBefore: 180_000, details: { fileIds: [41] } });
    entries.push(entry("latest", "compact", "assistant", [{ type: "text", text: "Working on the active request." }]));
    const raw = session(...entries);
    expect(raw.length).toBeGreaterThan(500_000);
    await writeFile(file, raw);
    await repos.threads.setPiSession(thread.id, file, "old-long-chat");
    await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Active request [[chat-file:41]]", piEntryId: "kept" });
    const history = await loadThreadHistory({ repos, thread: (await repos.threads.get(thread.id))! });
    const imported = JSON.stringify(history.items);
    expect(history.source).toBe("pi");
    expect(imported.length).toBeLessThan(2_000);
    expect(imported).toContain("migration phrase EMERALD");
    expect(imported).toContain("Active request [[chat-file:41]]");
    expect(imported).toContain("Working on the active request");
    expect(imported).not.toContain("Summarized raw message");
    expect(await readFile(file, "utf8")).toBe(raw);
    // A fork taken before the compaction keeps its original uncompressed context.
    const beforeCompaction = convertPiSessionEntries(raw, { piEntryId: "old-1" });
    expect(JSON.stringify(beforeCompaction.items)).toContain("Summarized raw message 1");
    expect(JSON.stringify(beforeCompaction.items)).not.toContain("migration phrase EMERALD");
  });
});
