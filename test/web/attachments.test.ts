import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { AttachmentLoader, type LoadedAttachment } from "../../src/web/client/attachments.js";
import { downloadTelegramFile } from "../../src/files/telegram.js";
import { loadTestConfig } from "../../src/config.js";
import { FileTooLargeError } from "../../src/files/limits.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("loads at most three attachments, deduplicates refreshes, and cancels work on navigation", async () => {
  const pending: Array<(response: Response) => void> = [];
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    pending.push(resolve);
    const signal = options.signal!;
    signals.push(signal);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let states = new Map<number, LoadedAttachment>();
  const loader = new AttachmentLoader(1, next => { states = next; });
  const file = (id: number) => ({ id, name: `${id}.txt`, size: 5, mimeType: "text/plain", caption: null });
  for (let id = 1; id <= 5; id++) loader.load(file(id), "auto");
  loader.load(file(1), "auto");
  expect(fetch).toHaveBeenCalledTimes(3);
  pending[0]!(new Response("hello", { headers: { "Content-Type": "text/plain" } }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  expect(states.get(1)).toMatchObject({ status: "ready", text: "hello", url: "blob:fixture" });
  expect(create).toHaveBeenCalledOnce();
  loader.dispose();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(revoke).toHaveBeenCalledWith("blob:fixture");
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("shows file errors and retries only when requested", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "File unavailable" }), { status: 502 })));
  let states = new Map<number, LoadedAttachment>();
  const loader = new AttachmentLoader(9, next => { states = next; });
  const file = { id: 3, name: "a.txt", size: 5, mimeType: "text/plain", caption: null };
  loader.load(file, "auto");
  await vi.waitFor(() => expect(states.get(3)?.status).toBe("error"));
  loader.load(file, "auto");
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.mocked(fetch).mockResolvedValue(new Response("hello"));
  loader.load(file, "download", true);
  await vi.waitFor(() => expect(states.get(3)?.status).toBe("ready"));
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("/api/threads/9/files/3?mode=download");
  loader.dispose();
});

it("stops Telegram reads when actual bytes exceed the automatic download limit", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(3));
    controller.enqueue(new Uint8Array(3));
  }, cancel });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  const api = { getFile: vi.fn().mockResolvedValue({ file_path: "files/a.txt" }) } as unknown as Api;
  await expect(downloadTelegramFile({ api, config: loadTestConfig(), fileId: "test", maxBytes: 5 })).rejects.toBeInstanceOf(FileTooLargeError);
  expect(cancel).toHaveBeenCalledOnce();
});

it("accepts the exact byte boundary and rejects oversized Telegram metadata before fetching", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("hello")));
  const getFile = vi.fn().mockResolvedValue({ file_path: "files/a.txt", file_size: 5 });
  const api = { getFile } as unknown as Api;
  expect((await downloadTelegramFile({ api, config: loadTestConfig(), fileId: "test", maxBytes: 5 })).bytes.toString()).toBe("hello");
  getFile.mockResolvedValue({ file_path: "files/a.txt", file_size: 6 });
  await expect(downloadTelegramFile({ api, config: loadTestConfig(), fileId: "test", maxBytes: 5 })).rejects.toBeInstanceOf(FileTooLargeError);
  expect(fetch).toHaveBeenCalledOnce();
});
