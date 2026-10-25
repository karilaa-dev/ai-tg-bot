import { fixtureUuid } from "./uuid-fixtures.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindChatRequests, chatFetch, invalidateChatRequests } from "../../src/web/client/chat/api.js";
import { DraftStore, emptyDraft, type Draft } from "../../src/web/client/chat/drafts.js";
import { LiveDraft } from "../../src/web/client/chat/live-draft.js";
import { acceptFiles, fileProblemText } from "../../src/web/client/chat/composer.js";
import { deferred } from "../helpers/async.js";

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
});
afterEach(() => { invalidateChatRequests(); vi.unstubAllGlobals(); });

const message: Draft = { text: "Alice's private message", files: [new File(["private"], "private.txt")], requestId: "same-request" };

it("scopes persisted drafts by verified user and removes legacy and other-user drafts", () => {
  sessionStorage.setItem("chat-draft:new", "unscoped legacy text");
  sessionStorage.setItem("unrelated", "keep");
  const alice = new DraftStore(1);
  expect(alice.read("new")).toEqual(emptyDraft);
  alice.write("new", message);
  alice.write(fixtureUuid(2), message);
  expect(sessionStorage.getItem("chat-draft:1:new")).toBe(message.text);
  const bob = new DraftStore(2);
  expect(bob.read("new")).toEqual(emptyDraft);
  expect(bob.read(fixtureUuid(2))).toEqual(emptyDraft);
  expect(sessionStorage.getItem("chat-draft:1:new")).toBeNull();
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
});

it("retains text across reloads only for the same account", () => {
  new DraftStore(1).write(fixtureUuid(2), message);
  expect(new DraftStore(1).read(fixtureUuid(2))).toEqual({ ...emptyDraft, text: message.text });
});

it("revokes files, retry ids, queued starts and late writes on sign-out, even for the same account", async () => {
  const alice = new DraftStore(1);
  alice.write("new", message);
  alice.queueStart(fixtureUuid(3), message);
  const completion = deferred<void>();
  const lateFailure = completion.promise.then(() => {
    alice.restore(fixtureUuid(2), message);
    alice.write("new", message);
    alice.queueStart(fixtureUuid(4), message);
  });
  alice.close();
  const nextLogin = new DraftStore(1);
  completion.resolve();
  await lateFailure;
  expect(alice.active).toBe(false);
  expect(alice.read("new")).toEqual(emptyDraft);
  expect(alice.takeStart(fixtureUuid(3))).toBeUndefined();
  expect(alice.takeStart(fixtureUuid(4))).toBeUndefined();
  expect(nextLogin.read(fixtureUuid(2))).toEqual(emptyDraft);
  expect(nextLogin.read("new")).toEqual(emptyDraft);
  expect(sessionStorage.length).toBe(0);
});

it("restores failed sends after navigation within a session without replacing newer typing", () => {
  const alice = new DraftStore(1);
  alice.restore(fixtureUuid(2), message);
  expect(alice.read(fixtureUuid(2))).toEqual(message);
  const newer = { ...emptyDraft, text: "newer draft" };
  alice.write(fixtureUuid(2), newer);
  alice.restore(fixtureUuid(2), message);
  expect(alice.read(fixtureUuid(2))).toEqual(newer);
  alice.queueStart(fixtureUuid(3), message);
  expect(alice.takeStart(fixtureUuid(3))).toEqual(message);
  expect(alice.takeStart(fixtureUuid(3))).toBeUndefined();
});

it("keeps in-memory drafts revocable when browser storage is unavailable", () => {
  vi.stubGlobal("sessionStorage", { get length() { throw new Error("Storage disabled"); }, getItem() { throw new Error("Storage disabled"); }, setItem() { throw new Error("Storage disabled"); } });
  const drafts = new DraftStore(1);
  drafts.write(fixtureUuid(2), message);
  expect(drafts.read(fixtureUuid(2))).toEqual(message);
  drafts.close();
  expect(drafts.read(fixtureUuid(2))).toEqual(emptyDraft);
});

it("ignores expired responses from requests belonging to a revoked session", async () => {
  const response = deferred<Response>();
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal("fetch", () => response.promise);
  const request = chatFetch(`/api/chat/threads/${fixtureUuid(2)}/messages`);
  invalidateChatRequests();
  response.resolve(new Response(null, { status: 401 }));
  await expect(request).rejects.toMatchObject({ status: 401 });
  expect(dispatchEvent).not.toHaveBeenCalled();
  await expect(chatFetch("/api/chat/threads")).rejects.toMatchObject({ status: 401 });
  expect(dispatchEvent).toHaveBeenCalledOnce();
});

it("binds private requests to the verified account without using that assertion as authentication", async () => {
  let received: Headers | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    received = new Headers(init.headers);
    expect(init.credentials).toBe("same-origin");
    return new Response(null, { status: 200 });
  });
  bindChatRequests(1001);
  await chatFetch("/api/chat/threads", { method: "POST" });
  expect(received?.get("X-Chat-User")).toBe("1001");
  expect(received?.get("X-Chat-Request")).toBe("1");
});

it("renders optional live response drafts through the text renderer without executing markup or OpenUI", () => {
  for (const draft of [undefined, null, { text: "", thinking: "" }]) {
    expect(renderToStaticMarkup(createElement(LiveDraft, { draft }))).toBe("");
  }
  const html = renderToStaticMarkup(createElement(LiveDraft, { draft: { text: '<script>alert("private")</script>\n\n**Working**', thinking: "Thinking about the answer" } }));
  expect(html).toContain("Assistant response in progress");
  expect(html).toContain("<strong>Working</strong>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("chat-openui");
});

it("shows a live chain line while a reply starts, before any text or tool output", () => {
  const live = { state: "generating" as const, startedAt: Date.now() - 14_000, queuedTurns: 0 };
  const html = renderToStaticMarkup(createElement(LiveDraft, { draft: null, live }));
  expect(html).toContain("Thinking");
  expect(html).toContain("14s");
  const queued = renderToStaticMarkup(createElement(LiveDraft, { draft: null, live: { state: "queued", startedAt: Date.now(), queuedTurns: 3 } }));
  expect(queued).toContain("Waiting to start");
  expect(queued).toContain("2 ahead");
  expect(queued).not.toContain("chain-time");
});

it("shows live tool progress with the finished-response renderer, even with streaming text off", () => {
  const toolActivity = { version: 1 as const, omittedCalls: 0, reasoning: ["private reasoning"], calls: [
    { id: "tool-1", name: "web_search", status: "running" as const, durationMs: null, args: { format: "json" as const, text: '{"query":"<b>x</b>"}', truncated: false }, result: null },
  ] };
  const html = renderToStaticMarkup(createElement(LiveDraft, { draft: { text: "", thinking: "", toolActivity } }));
  expect(html).toContain("Assistant response in progress");
  // The collapsed chain names the step in progress instead of a call count.
  expect(html).toContain('class="chain"');
  expect(html).toContain("Search the web");
  expect(html).not.toContain("web_search");
  expect(html).not.toContain("<b>x</b>");
  expect(renderToStaticMarkup(createElement(LiveDraft, { draft: { text: "", thinking: "", toolActivity: { ...toolActivity, calls: [] } } }))).toBe("");
});

it("accepts any file type within the separate file, count and aggregate limits", () => {
  const limit = 50 * 1024 * 1024;
  const file = (name: string, size: number, type = "") => new File([new Uint8Array(size)], name, { type });
  const odd = [file("archive.zip", 10, "application/zip"), file("clip.mov", 10, "video/quicktime"), file("old.doc", 10, "application/msword"), file("setup.exe", 10), file("blob", 10)];
  expect(acceptFiles([], odd, limit)).toEqual({ files: odd, problem: null });
  const big = file("big.bin", limit - 5);
  const total = acceptFiles([big], [file("a.zip", 4), file("b.zip", 4)], limit, limit);
  expect(total.files.map(item => item.name)).toEqual(["big.bin", "a.zip"]);
  expect(total.problem).toEqual({ kind: "total-too-large", names: ["b.zip"], maxBytes: limit });
  const nearlyFull = [file("big.zip", 11), ...Array.from({ length: 8 }, (_, i) => file(`small-${i}`, 1))];
  const recoveredSlot = acceptFiles(nearlyFull, [file("too-big.zip", 2), file("fits.zip", 1)], 20, 20);
  expect(recoveredSlot.files.map(file => file.name)).toEqual([...nearlyFull.map(file => file.name), "fits.zip"]);
  expect(recoveredSlot.problem).toEqual({ kind: "total-too-large", names: ["too-big.zip"], maxBytes: 20 });
  expect(fileProblemText(total.problem!, "ru")).toContain("b.zip");
  expect(acceptFiles([], [file("huge.mkv", limit + 1)], limit).problem).toMatchObject({ kind: "too-large", names: ["huge.mkv"] });
  const many = Array.from({ length: 12 }, (_, index) => file(`f${index}.dat`, 1));
  const capped = acceptFiles([], many, limit);
  expect(capped.files).toHaveLength(10);
  expect(capped.problem).toEqual({ kind: "too-many" });
});

it("accepts ten Telegram-sized files without treating the per-file limit as the message limit", () => {
  const limit = 50 * 1024 * 1024;
  const files = Array.from({ length: 10 }, (_, index) => {
    const file = new File([], `archive-${index}.zip`);
    Object.defineProperty(file, "size", { value: limit });
    return file;
  });
  expect(acceptFiles([], files, limit)).toEqual({ files, problem: null });
  const oversized = new File([], "too-large.zip");
  Object.defineProperty(oversized, "size", { value: limit + 1 });
  expect(acceptFiles([], [oversized], limit).problem).toMatchObject({ kind: "too-large" });
});
