import { fixtureUuid } from "./uuid-fixtures.js";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentCache, AttachmentLoader, type AttachmentSource, type LoadedAttachment } from "../../src/web/client/attachments.js";
import { bindChatRequests, getChatAttachmentSource, invalidateChatRequests } from "../../src/web/client/chat/api.js";

const readBlob = globalThis.fetch;
const caches: AttachmentCache[] = [];
const loaders: AttachmentLoader[] = [];
const file = (id: string) => ({ id, name: `${id}.txt`, size: 0, mimeType: "text/plain", caption: null });
const response = (text = "data") => new Response(text, { headers: { "Content-Type": "text/plain" } });

function cache(options: ConstructorParameters<typeof AttachmentCache>[0] = {}) {
  const result = new AttachmentCache(options);
  caches.push(result);
  return result;
}

function source(shared = cache(), fetch: AttachmentSource["fetch"] = async () => response()) {
  return { cache: shared, fetch: vi.fn(fetch), url: (threadId: string, fileId: string) => `/files/${threadId}/${fileId}` };
}

function requests(from: ReturnType<typeof source>) {
  return from.fetch.mock.calls.map(([url, init]) => ({
    url,
    method: init.method ?? "GET",
    consent: new Headers(init.headers).get("X-Conversation-Sandbox-Consent"),
  }));
}

function mount(from: AttachmentSource, threadId = fixtureUuid(1)) {
  let states = new Map<string, LoadedAttachment>();
  const changed = vi.fn((next: Map<string, LoadedAttachment>) => { states = next; });
  const loader = new AttachmentLoader(threadId, changed, from);
  loaders.push(loader);
  return { loader, changed, state: (id = fixtureUuid(1)) => states.get(id) };
}

function readyUrl(view: ReturnType<typeof mount>, id = fixtureUuid(1)) {
  const state = view.state(id);
  if (state?.status !== "ready" || !state.url) throw new Error(`Attachment ${id} is not ready`);
  return state.url;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  for (const shared of caches.splice(0)) shared.dispose();
  invalidateChatRequests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shares an in-flight download across source objects and preserves its remaining subscriber", async () => {
  const pending = deferred<Response>();
  const from = source(cache(), () => pending.promise);
  const first = mount(from);
  const second = mount({ ...from });
  first.loader.load(file(fixtureUuid(1)), "auto");
  second.loader.load(file(fixtureUuid(1)), "auto");
  first.loader.load(file(fixtureUuid(1)), "auto");
  expect(from.fetch).toHaveBeenCalledOnce();
  expect(second.state()).toMatchObject({ status: "loading" });
  first.loader.dispose();
  const notifications = first.changed.mock.calls.length;
  expect(from.fetch.mock.calls[0]?.[1].signal?.aborted).toBe(false);
  pending.resolve(response("shared bytes"));
  await vi.waitFor(() => expect(second.state()?.status).toBe("ready"));
  expect(await (await readBlob(readyUrl(second))).text()).toBe("shared bytes");
  expect(first.changed).toHaveBeenCalledTimes(notifications);
});

it.each([{ context: "thread", threadId: fixtureUuid(2), fileId: fixtureUuid(1) }, { context: "file", threadId: fixtureUuid(1), fileId: fixtureUuid(2) }])("isolates $context contexts even when a custom source resolves them to the same URL", async ({ threadId, fileId }) => {
  const from = { ...source(), url: () => "/files/same-resource" };
  const first = mount(from, fixtureUuid(1));
  const second = mount(from, threadId);
  first.loader.load(file(fixtureUuid(1)), "auto");
  second.loader.load(file(fileId), "auto");
  await vi.waitFor(() => expect(second.state(fileId)?.status).toBe("ready"));
  expect(from.fetch).toHaveBeenCalledTimes(2);
  expect(readyUrl(first)).not.toBe(readyUrl(second, fileId));
});

it("shares request modes while separating threads, source endpoints, and independently owned caches", async () => {
  const from = source();
  const otherEndpoint = { ...from, url: (thread: string, id: string) => `/admin/${thread}/${id}` };
  const otherCache = { ...from, cache: cache() };
  const views = [mount(from, fixtureUuid(1)), mount(from, fixtureUuid(2)), mount(otherEndpoint), mount(from), mount(otherCache)];
  for (const [index, view] of views.entries()) view.loader.load(file(fixtureUuid(1)), index === 3 ? "download" : "auto");
  await vi.waitFor(() => expect(views.every(view => view.state()?.status === "ready")).toBe(true));
  expect(from.fetch).toHaveBeenCalledTimes(4);
  expect(from.fetch.mock.calls.map(([url]) => url).sort()).toEqual([
    `/admin/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=auto`, `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=auto`, `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=auto`, `/files/${fixtureUuid(2)}/${fixtureUuid(1)}?mode=auto`,
  ]);
  expect(readyUrl(views[3])).toBe(readyUrl(views[0]));
  expect(new Set(views.map(view => readyUrl(view))).size).toBe(4);
});

it.each([{ method: "GET", allowSandbox: false }, { method: "POST", allowSandbox: true }])(
  "keeps a manual $method in flight through repeated observation and automatic loads",
  async ({ method, allowSandbox }) => {
    const pending = deferred<Response>();
    const from = source(cache(), () => pending.promise);
    const view = mount(from);
    view.loader.load(file(fixtureUuid(1)), "download", true, allowSandbox);
    const signal = from.fetch.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(false);
    for (let refresh = 0; refresh < 3; refresh++) {
      view.loader.observe(file(fixtureUuid(1)));
      view.loader.load(file(fixtureUuid(1)), "auto");
      view.loader.load(file(fixtureUuid(1)), "auto", true);
    }
    expect(signal?.aborted).toBe(false);
    expect(view.state()).toEqual({ status: "loading" });
    const sibling = mount({ ...from });
    sibling.loader.observe(file(fixtureUuid(1)));
    sibling.loader.load(file(fixtureUuid(1)), "auto");
    expect(sibling.state()).toEqual(view.state());
    expect(requests(from)).toEqual([{
      url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download${allowSandbox ? "&sandbox=start" : ""}`,
      method,
      consent: allowSandbox ? "start" : null,
    }]);
    pending.resolve(response("manual bytes"));
    await vi.waitFor(() => expect(view.state()?.status).toBe("ready"));
    expect(sibling.state()).toEqual(view.state());
    expect(await (await readBlob(readyUrl(sibling))).text()).toBe("manual bytes");
    expect(from.fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  { recovery: "gallery", status: 413 },
  { recovery: "attachment row", status: 413 },
  { recovery: "gallery", status: 409 },
  { recovery: "attachment row", status: 409 },
])("shares $recovery recovery from $status with its sibling and later automatic remounts", async ({ recovery, status }) => {
  const pending = deferred<Response>();
  const allowSandbox = status === 409;
  const from = source(cache(), async () => Response.json(allowSandbox
    ? { code: "sandbox_consent_required" }
    : { error: "Load this attachment manually" }, { status }));
  const gallery = mount(from);
  const row = mount({ ...from });
  row.loader.observe(file(fixtureUuid(1)));
  gallery.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(gallery.state()?.status).toBe("error"));
  expect(row.state()).toEqual(gallery.state());
  expect(gallery.state()).toEqual(allowSandbox
    ? { status: "error", needsSandbox: true }
    : { status: "error", error: "Load this attachment manually" });
  from.fetch.mockImplementation(() => pending.promise);
  const initiator = recovery === "gallery" ? gallery : row;
  initiator.loader.load(file(fixtureUuid(1)), "download", true, allowSandbox);
  expect(gallery.state()).toEqual({ status: "loading" });
  expect(row.state()).toEqual(gallery.state());
  for (const view of [gallery, row]) {
    view.loader.observe(file(fixtureUuid(1)));
    view.loader.load(file(fixtureUuid(1)), "auto");
  }
  expect(from.fetch.mock.calls[1]?.[1].signal?.aborted).toBe(false);
  pending.resolve(response("recovered bytes"));
  await vi.waitFor(() => expect(gallery.state()?.status).toBe("ready"));
  const url = readyUrl(gallery);
  expect(row.state()).toEqual(gallery.state());
  expect(gallery.state()).toEqual({ status: "ready", url, mime: "text/plain", text: "recovered bytes" });
  for (const view of [gallery, row]) {
    view.loader.observe(file(fixtureUuid(1)));
    view.loader.load(file(fixtureUuid(1)), "auto");
    view.loader.load(file(fixtureUuid(1)), "auto", true);
    expect(readyUrl(view)).toBe(url);
    view.loader.dispose();
  }
  const remounted = mount(from);
  remounted.loader.observe(file(fixtureUuid(1)));
  remounted.loader.load(file(fixtureUuid(1)), "auto");
  expect(readyUrl(remounted)).toBe(url);
  expect(await (await readBlob(url)).text()).toBe("recovered bytes");
  expect(requests(from)).toEqual([
    { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=auto`, method: "GET", consent: null },
    { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download${allowSandbox ? "&sandbox=start" : ""}`, method: allowSandbox ? "POST" : "GET", consent: allowSandbox ? "start" : null },
  ]);
});

it.each([413, 409])("preserves an initial automatic %s gate until an explicit request", async status => {
  vi.useFakeTimers();
  const from = source(cache(), async () => Response.json(status === 409
    ? { code: "sandbox_consent_required" }
    : { error: "Load this attachment manually" }, { status }));
  const view = mount(from);
  const sibling = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  sibling.loader.observe(file(fixtureUuid(1)));
  await vi.advanceTimersByTimeAsync(0);
  const error = view.state();
  expect(error).toEqual(status === 409
    ? { status: "error", needsSandbox: true }
    : { status: "error", error: "Load this attachment manually" });
  for (let refresh = 0; refresh < 3; refresh++) {
    for (const consumer of [view, sibling]) {
      consumer.loader.observe(file(fixtureUuid(1)));
      consumer.loader.load(file(fixtureUuid(1)), "auto");
    }
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(view.state()).toEqual(error);
  expect(sibling.state()).toEqual(error);
  expect(requests(from)).toEqual([{ url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=auto`, method: "GET", consent: null }]);
});

it.each([{ status: 502, message: "Manual download failed" }, { status: 409, message: "Sandbox consent required" }])(
  "keeps manual $status errors shared without automatic retries or sandbox consent",
  async ({ status, message }) => {
    vi.useFakeTimers();
    const from = source(cache(), async () => Response.json({ error: "Initial auto failure" }, { status: 413 }));
    const view = mount(from);
    const sibling = mount(from);
    view.loader.load(file(fixtureUuid(1)), "auto");
    sibling.loader.observe(file(fixtureUuid(1)));
    await vi.advanceTimersByTimeAsync(0);
    from.fetch.mockImplementation(async () => Response.json(status === 409
      ? { code: "sandbox_consent_required" }
      : { error: message }, { status }));
    sibling.loader.load(file(fixtureUuid(1)), "download", true);
    await vi.advanceTimersByTimeAsync(0);
    const error = sibling.state();
    expect(error).toEqual(status === 409
      ? { status: "error", needsSandbox: true }
      : { status: "error", error: message });
    for (let refresh = 0; refresh < 3; refresh++) {
      for (const consumer of [view, sibling]) {
        consumer.loader.observe(file(fixtureUuid(1)));
        consumer.loader.load(file(fixtureUuid(1)), "auto");
        consumer.loader.load(file(fixtureUuid(1)), "auto", true);
      }
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.state()).toEqual(error);
    expect(sibling.state()).toEqual(error);
    expect(requests(from)).toEqual([
      { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=auto`, method: "GET", consent: null },
      { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download`, method: "GET", consent: null },
    ]);
  },
);

it.each([
  { outcome: "success", status: 200, allowSandbox: false },
  { outcome: "size gate", status: 413, allowSandbox: false },
  { outcome: "consent gate", status: 409, allowSandbox: false },
  { outcome: "success", status: 200, allowSandbox: true },
  { outcome: "consent gate", status: 409, allowSandbox: true },
])(
  "waits for automatic $outcome before requesting a manual upgrade (sandbox consent: $allowSandbox)",
  async ({ status, allowSandbox }) => {
    const automatic = deferred<Response>();
    const manual = deferred<Response>();
    const from = source(cache(), () => automatic.promise);
    from.fetch.mockImplementationOnce(() => automatic.promise).mockImplementation(() => manual.promise);
    const view = mount(from);
    const sibling = mount(from);
    view.loader.load(file(fixtureUuid(1)), "auto");
    sibling.loader.observe(file(fixtureUuid(1)));
    for (let click = 0; click < 3; click++) sibling.loader.load(file(fixtureUuid(1)), "download", true, allowSandbox);
    view.loader.observe(file(fixtureUuid(1)));
    view.loader.load(file(fixtureUuid(1)), "auto");
    expect(from.fetch).toHaveBeenCalledOnce();
    expect(from.fetch.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    expect(view.state()).toEqual({ status: "loading" });
    expect(sibling.state()).toEqual(view.state());
    automatic.resolve(status === 200 ? response("automatic bytes") : Response.json(status === 409
      ? { code: "sandbox_consent_required" }
      : { error: "Load this attachment manually" }, { status }));
    if (status !== 200) {
      await vi.waitFor(() => expect(from.fetch).toHaveBeenCalledTimes(2));
      expect(view.state()).toEqual({ status: "loading" });
      expect(sibling.state()).toEqual(view.state());
      expect(requests(from)[1]).toEqual({
        url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download${allowSandbox ? "&sandbox=start" : ""}`,
        method: allowSandbox ? "POST" : "GET",
        consent: allowSandbox ? "start" : null,
      });
      manual.resolve(response("manual bytes"));
    }
    await vi.waitFor(() => expect(view.state()?.status).toBe("ready"));
    expect(view.state()?.text).toBe(status === 200 ? "automatic bytes" : "manual bytes");
    expect(sibling.state()).toEqual(view.state());
    const url = readyUrl(view);
    for (const consumer of [view, sibling]) {
      consumer.loader.observe(file(fixtureUuid(1)));
      consumer.loader.load(file(fixtureUuid(1)), "auto", true);
      expect(readyUrl(consumer)).toBe(url);
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(from.fetch).toHaveBeenCalledTimes(status === 200 ? 1 : 2);
  },
);

it.each([false, true])("uses the explicit policy when a queued automatic load starts (sandbox consent: %s)", async allowSandbox => {
  const blocker = deferred<Response>();
  const from = source(cache({ maxConcurrent: 1 }), async () => response("upgraded bytes"));
  from.fetch.mockImplementationOnce(() => blocker.promise);
  const view = mount(from);
  view.loader.load(file(fixtureUuid(2)), "auto");
  view.loader.load(file(fixtureUuid(1)), "auto");
  view.loader.load(file(fixtureUuid(1)), "download", true, allowSandbox);
  view.loader.observe(file(fixtureUuid(1)));
  view.loader.load(file(fixtureUuid(1)), "auto");
  expect(from.fetch).toHaveBeenCalledOnce();
  blocker.resolve(response("blocking bytes"));
  await vi.waitFor(() => expect(view.state()?.status).toBe("ready"));
  expect(requests(from)).toEqual([
    { url: `/files/${fixtureUuid(1)}/${fixtureUuid(2)}?mode=auto`, method: "GET", consent: null },
    { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download${allowSandbox ? "&sandbox=start" : ""}`, method: allowSandbox ? "POST" : "GET", consent: allowSandbox ? "start" : null },
  ]);
});

it.each([{ options: {}, limit: 1 }, { options: { maxConcurrent: 2 }, limit: 2 }])(
  "uses one queue across threads with concurrency $limit",
  async ({ options, limit }) => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    const from = source(cache(options), () => {
      const next = deferred<Response>();
      pending.push(next);
      return next.promise;
    });
    const views = Array.from({ length: 6 }, (_, index) => mount(from, fixtureUuid(index + 1)));
    for (const view of views) view.loader.load(file(fixtureUuid(1)), "auto");
    expect(from.fetch).toHaveBeenCalledTimes(limit);
    pending[0]?.resolve(response());
    await vi.waitFor(() => expect(from.fetch).toHaveBeenCalledTimes(limit + 1));
    expect(views.filter(view => view.state()?.status === "ready")).toHaveLength(1);
  },
);

it("reuses ready blobs after all views unmount and another loader mounts", async () => {
  const from = source();
  const first = mount(from);
  first.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(first.state()?.status).toBe("ready"));
  const url = readyUrl(first);
  first.loader.dispose();
  expect(await (await readBlob(url)).text()).toBe("data");
  const remounted = mount(from);
  remounted.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(remounted.state()?.status).toBe("ready"));
  expect(readyUrl(remounted)).toBe(url);
  expect(from.fetch).toHaveBeenCalledOnce();
});

it("observes without fetching, then follows another consumer's load and retains its ready blob", async () => {
  const from = source(cache({ maxBytes: 0 }));
  const observer = mount(from);
  observer.loader.observe(file(fixtureUuid(1)));
  expect(from.fetch).not.toHaveBeenCalled();
  expect(observer.state()).toBeUndefined();
  const downloader = mount(from);
  downloader.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(observer.state()?.status).toBe("ready"));
  const url = readyUrl(observer);
  downloader.loader.dispose();
  expect(await (await readBlob(url)).text()).toBe("data");
  observer.loader.dispose();
  await expect(readBlob(url)).rejects.toThrow();
});

it("evicts least-recently-used idle blobs using actual response bytes instead of file metadata", async () => {
  const from = source(cache({ maxBytes: 8 }));
  const first = mount(from);
  const second = mount(from);
  first.loader.load(file(fixtureUuid(1)), "auto");
  second.loader.load(file(fixtureUuid(2)), "auto");
  await vi.waitFor(() => expect(second.state(fixtureUuid(2))?.status).toBe("ready"));
  const firstUrl = readyUrl(first);
  const secondUrl = readyUrl(second, fixtureUuid(2));
  first.loader.dispose();
  second.loader.dispose();
  const reused = mount(from);
  reused.loader.load(file(fixtureUuid(1)), "auto");
  expect(readyUrl(reused)).toBe(firstUrl);
  reused.loader.dispose();
  const third = mount(from);
  third.loader.load(file(fixtureUuid(3)), "auto");
  await vi.waitFor(() => expect(third.state(fixtureUuid(3))?.status).toBe("ready"));
  const thirdUrl = readyUrl(third, fixtureUuid(3));
  third.loader.dispose();
  expect(from.fetch).toHaveBeenCalledTimes(3);
  expect(await (await readBlob(firstUrl)).text()).toBe("data");
  expect(await (await readBlob(thirdUrl)).text()).toBe("data");
  await expect(readBlob(secondUrl)).rejects.toThrow();
  const evicted = mount(from);
  evicted.loader.load(file(fixtureUuid(2)), "auto");
  await vi.waitFor(() => expect(evicted.state(fixtureUuid(2))?.status).toBe("ready"));
  expect(from.fetch).toHaveBeenCalledTimes(4);
  expect(readyUrl(evicted, fixtureUuid(2))).not.toBe(secondUrl);
});

it("allows pinned blobs to exceed the idle budget without displacing retained idle bytes", async () => {
  const from = source(cache({ maxBytes: 4 }), async url => response(url.includes(`/${fixtureUuid(1)}?`) ? "0123456789" : "data"));
  const pinned = mount(from);
  const idle = mount(from);
  pinned.loader.load(file(fixtureUuid(1)), "auto");
  idle.loader.load(file(fixtureUuid(2)), "auto");
  await vi.waitFor(() => expect(idle.state(fixtureUuid(2))?.status).toBe("ready"));
  idle.loader.dispose();
  expect(await (await readBlob(readyUrl(pinned))).text()).toBe("0123456789");
  const reused = mount(from);
  reused.loader.load(file(fixtureUuid(2)), "auto");
  expect(reused.state(fixtureUuid(2))?.status).toBe("ready");
  expect(from.fetch).toHaveBeenCalledTimes(2);
  const pinnedUrl = readyUrl(pinned);
  pinned.loader.dispose();
  await expect(readBlob(pinnedUrl)).rejects.toThrow();
  expect(await (await readBlob(readyUrl(reused, fixtureUuid(2)))).text()).toBe("data");
});

it("explicitly retries a ready resource while keeping its prior URL valid for mounted views", async () => {
  let attempt = 0;
  const from = source(cache({ maxBytes: 0 }), async () => response(++attempt === 1 ? "broken image" : "replacement image"));
  const first = mount(from);
  const sibling = mount(from);
  first.loader.load(file(fixtureUuid(1)), "auto");
  sibling.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(sibling.state()?.status).toBe("ready"));
  const oldUrl = readyUrl(sibling);
  first.loader.load(file(fixtureUuid(1)), "download", true);
  await vi.waitFor(() => expect(first.state()).toMatchObject({ status: "ready", text: "replacement image" }));
  expect(from.fetch).toHaveBeenCalledTimes(2);
  expect(from.fetch.mock.lastCall?.[0]).toBe(`/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download`);
  expect(sibling.state()).toEqual(first.state());
  expect(readyUrl(first)).not.toBe(oldUrl);
  expect(await (await readBlob(oldUrl)).text()).toBe("broken image");
  first.loader.dispose();
  expect(await (await readBlob(oldUrl)).text()).toBe("broken image");
  sibling.loader.dispose();
  await expect(readBlob(oldUrl)).rejects.toThrow();
});

it("disposes cached blobs and active work, drops queued work, and ignores late responses", async () => {
  const shared = cache({ maxConcurrent: 1 });
  const pending = deferred<Response>();
  const from = source(shared, url => url.includes(`/${fixtureUuid(1)}?`) ? Promise.resolve(response()) : pending.promise);
  const view = mount(from);
  const create = vi.spyOn(URL, "createObjectURL");
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(view.state()?.status).toBe("ready"));
  const url = readyUrl(view);
  view.loader.load(file(fixtureUuid(2)), "auto");
  view.loader.load(file(fixtureUuid(3)), "auto");
  expect(from.fetch).toHaveBeenCalledTimes(2);
  shared.dispose();
  expect(from.fetch.mock.calls[1]?.[1].signal?.aborted).toBe(true);
  expect(view.state()).toEqual({ status: "error" });
  expect(view.state(fixtureUuid(2))).toEqual({ status: "error" });
  await expect(readBlob(url)).rejects.toThrow();
  const notifications = view.changed.mock.calls.length;
  pending.resolve(response("late"));
  await new Promise(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledOnce();
  expect(view.changed).toHaveBeenCalledTimes(notifications);
  view.loader.load(file(fixtureUuid(4)), "auto");
  expect(from.fetch).toHaveBeenCalledTimes(2);
});

it("does not create a blob URL if cache disposal happens while the response body is streaming", async () => {
  const body = new TransformStream<Uint8Array, Uint8Array>();
  const writer = body.writable.getWriter();
  const received = new Response(body.readable, { headers: { "Content-Type": "image/png" } });
  const read = vi.spyOn(received, "blob");
  const create = vi.spyOn(URL, "createObjectURL");
  const shared = cache();
  const from = source(shared, async () => received);
  const view = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  shared.dispose();
  const notifications = view.changed.mock.calls.length;
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
  await new Promise(resolve => setImmediate(resolve));
  expect(create).not.toHaveBeenCalled();
  expect(view.changed).toHaveBeenCalledTimes(notifications);
});

it.each(["seconds", "HTTP date"])("honors Retry-After expressed as %s without exposing a transient error", async format => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T00:00:00Z"));
  const retryAfter = format === "seconds" ? "2" : new Date(Date.now() + 2_000).toUTCString();
  let attempt = 0;
  const from = source(cache({ retryDelayMs: 10 }), async () => ++attempt === 1
    ? new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }) : response());
  const view = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(from.fetch).toHaveBeenCalledOnce();
  expect(view.state()?.status).toBe("loading");
  await vi.advanceTimersByTimeAsync(1);
  expect(from.fetch).toHaveBeenCalledTimes(2);
  expect(view.state()?.status).toBe("ready");
  expect(view.changed.mock.calls.some(([states]) => states.get(fixtureUuid(1))?.status === "error")).toBe(false);
});

it("shares two automatic retries, then waits for a manual retry after a non-JSON 429", async () => {
  vi.useFakeTimers();
  const from = source(cache(), async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }));
  const first = mount(from);
  const second = mount(from);
  first.loader.load(file(fixtureUuid(1)), "auto");
  second.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(from.fetch).toHaveBeenCalledTimes(2);
  expect(first.state()?.status).toBe("loading");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(from.fetch).toHaveBeenCalledTimes(3);
  expect(first.state()).toMatchObject({ status: "error", error: expect.any(String) });
  expect(second.state()).toEqual(first.state());
  first.loader.load(file(fixtureUuid(1)), "auto");
  second.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(from.fetch).toHaveBeenCalledTimes(3);
  from.fetch.mockImplementation(async () => response("recovered"));
  second.loader.load(file(fixtureUuid(1)), "auto", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(from.fetch).toHaveBeenCalledTimes(4);
  expect(first.state()).toMatchObject({ status: "ready", text: "recovered" });
});

it("uses the configured retry budget and delay when Retry-After is absent", async () => {
  vi.useFakeTimers();
  const from = source(cache({ maxRetries: 1, retryDelayMs: 250 }), async () => new Response(null, { status: 429 }));
  const view = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(249);
  expect(from.fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(from.fetch).toHaveBeenCalledTimes(2);
  expect(view.state()?.status).toBe("error");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(from.fetch).toHaveBeenCalledTimes(2);
});

it.each(["cache", "last loader"])("cancels an automatic retry when the %s is disposed", async disposed => {
  vi.useFakeTimers();
  const shared = cache();
  const from = source(shared, async () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }));
  const view = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(0);
  if (disposed === "cache") shared.dispose(); else view.loader.dispose();
  const notifications = view.changed.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(from.fetch).toHaveBeenCalledOnce();
  expect(from.fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  expect(view.changed).toHaveBeenCalledTimes(notifications);
});

it("stops automatic retries at sandbox consent and only starts a sandbox after explicit approval", async () => {
  vi.useFakeTimers();
  let attempt = 0;
  const from = source(cache({ retryDelayMs: 100 }), async () => ++attempt === 1
    ? new Response(null, { status: 429 })
    : Response.json({ code: "sandbox_consent_required" }, { status: 409 }));
  const view = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(100);
  expect(view.state()).toMatchObject({ status: "error", needsSandbox: true });
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(from.fetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of from.fetch.mock.calls) {
    expect(url).not.toContain("sandbox=start");
    expect(init.method ?? "GET").toBe("GET");
    expect(new Headers(init.headers).has("X-Conversation-Sandbox-Consent")).toBe(false);
  }
  from.fetch.mockImplementation(async () => response());
  view.loader.load(file(fixtureUuid(1)), "download", true, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(view.state()?.status).toBe("ready");
  expect(from.fetch.mock.lastCall?.[0]).toBe(`/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download&sandbox=start`);
  expect(from.fetch.mock.lastCall?.[1].method).toBe("POST");
  expect(new Headers(from.fetch.mock.lastCall?.[1].headers).get("X-Conversation-Sandbox-Consent")).toBe("start");
});

it.each([429, 503])("does not repeat sandbox consent after POST %s or carry it into an unapproved retry", async status => {
  vi.useFakeTimers();
  const from = source(cache(), async () => new Response(null, { status, headers: { "Retry-After": "1" } }));
  const view = mount(from);
  const sibling = mount(from);
  sibling.loader.observe(file(fixtureUuid(1)));
  view.loader.load(file(fixtureUuid(1)), "download", true, true);
  await vi.advanceTimersByTimeAsync(0);
  const error = view.state();
  expect(error?.status).toBe("error");
  for (let refresh = 0; refresh < 3; refresh++) {
    for (const consumer of [view, sibling]) {
      consumer.loader.observe(file(fixtureUuid(1)));
      consumer.loader.load(file(fixtureUuid(1)), "auto");
      consumer.loader.load(file(fixtureUuid(1)), "auto", true);
    }
  }
  await vi.advanceTimersByTimeAsync(30_000);
  expect(view.state()).toEqual(error);
  expect(sibling.state()).toEqual(error);
  expect(requests(from)).toEqual([{ url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download&sandbox=start`, method: "POST", consent: "start" }]);
  from.fetch.mockImplementation(async () => Response.json({ code: "sandbox_consent_required" }, { status: 409 }));
  sibling.loader.load(file(fixtureUuid(1)), "download", true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(view.state()).toEqual({ status: "error", needsSandbox: true });
  expect(sibling.state()).toEqual(view.state());
  expect(requests(from)).toEqual([
    { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download&sandbox=start`, method: "POST", consent: "start" },
    { url: `/files/${fixtureUuid(1)}/${fixtureUuid(1)}?mode=download`, method: "GET", consent: null },
  ]);
});

it("binds cached media to the verified account and prevents old sources fetching after a rebind", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response("account bytes"));
  vi.stubGlobal("fetch", fetch);
  bindChatRequests(1001);
  const oldSource = getChatAttachmentSource();
  expect(getChatAttachmentSource()).toBe(oldSource);
  const oldView = mount(oldSource);
  oldView.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(oldView.state()?.status).toBe("ready"));
  const oldUrl = readyUrl(oldView);
  oldView.loader.dispose();
  bindChatRequests(2002);
  await expect(readBlob(oldUrl)).rejects.toThrow();
  const newSource = getChatAttachmentSource();
  expect(newSource.cache).not.toBe(oldSource.cache);
  await expect(oldSource.fetch(oldSource.url(fixtureUuid(1), fixtureUuid(1)), {})).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledOnce();
  const newView = mount(newSource);
  newView.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(newView.state()?.status).toBe("ready"));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Chat-User")).toBe("1001");
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("X-Chat-User")).toBe("2002");
  const newUrl = readyUrl(newView);
  invalidateChatRequests();
  expect(() => getChatAttachmentSource()).toThrow();
  await expect(readBlob(newUrl)).rejects.toThrow();
});

it("invalidates an in-flight account response without admitting its late bytes into the next session", async () => {
  const pending = deferred<Response>();
  const fetch = vi.fn((_url: string, _init?: RequestInit) => pending.promise);
  vi.stubGlobal("fetch", fetch);
  const create = vi.spyOn(URL, "createObjectURL");
  bindChatRequests(1001);
  const old = mount(getChatAttachmentSource());
  old.loader.load(file(fixtureUuid(1)), "auto");
  bindChatRequests(2002);
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  const notifications = old.changed.mock.calls.length;
  pending.resolve(response("old account"));
  await new Promise(resolve => setImmediate(resolve));
  expect(create).not.toHaveBeenCalled();
  expect(old.changed).toHaveBeenCalledTimes(notifications);
  fetch.mockImplementation(async () => response("new account"));
  const current = mount(getChatAttachmentSource());
  current.loader.load(file(fixtureUuid(1)), "auto");
  await vi.waitFor(() => expect(current.state()).toMatchObject({ status: "ready", text: "new account" }));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("cancels account retries at logout and requires a verified session before creating another source", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 429, headers: { "Retry-After": "1" } }));
  vi.stubGlobal("fetch", fetch);
  bindChatRequests(1001);
  const from = getChatAttachmentSource();
  const view = mount(from);
  view.loader.load(file(fixtureUuid(1)), "auto");
  await vi.advanceTimersByTimeAsync(0);
  invalidateChatRequests();
  expect(() => getChatAttachmentSource()).toThrow();
  const notifications = view.changed.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(view.changed).toHaveBeenCalledTimes(notifications);
  await expect(from.fetch(from.url(fixtureUuid(1), fixtureUuid(1)), {})).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledOnce();
});
