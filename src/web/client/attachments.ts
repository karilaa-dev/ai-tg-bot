import { z } from "zod";
import type { WebAttachment } from "../types.js";
import { apiFetch } from "./api.js";

export interface LoadedAttachment { status: "loading" | "ready" | "error"; url?: string; text?: string; mime?: string; error?: string; needsSandbox?: boolean }
type AttachmentMode = "auto" | "download";
type RequestPolicy = "auto" | "download" | "sandbox";
type Listener = (state: LoadedAttachment) => void;

/** A shared cache belongs to one verified session, never to a global file ID. */
export interface AttachmentSource {
  url: (threadId: string, fileId: string) => string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  cache?: AttachmentCache;
}
const adminSource: AttachmentSource = { url: (threadId, fileId) => `/api/threads/${threadId}/files/${fileId}`, fetch: apiFetch };
const FileError = z.object({ error: z.string().optional(), code: z.string().optional() });
interface CacheEntry {
  key: string;
  url: string;
  source: AttachmentSource;
  state?: LoadedAttachment;
  policy: RequestPolicy;
  upgrade: Exclude<RequestPolicy, "auto"> | null;
  bytes: number;
  retiredUrls: string[];
  listeners: Set<Listener>;
  controller: AbortController;
  touched: number;
}

/** One queue per session. Idle blobs have a byte budget; mounted views pin their URLs until released. */
export class AttachmentCache {
  private entries = new Map<string, CacheEntry>();
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private closed = false;
  private clock = 0;
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor({ maxBytes = 32 * 1024 * 1024, maxConcurrent = 1, maxRetries = 2, retryDelayMs = 500 }: {
    maxBytes?: number; maxConcurrent?: number; maxRetries?: number; retryDelayMs?: number;
  } = {}) {
    this.maxBytes = maxBytes;
    this.maxConcurrent = maxConcurrent;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  subscribe(source: AttachmentSource, threadId: string, fileId: string, listener: Listener): { load: (policy: RequestPolicy, retry: boolean) => void; release: () => void } {
    const url = source.url(threadId, fileId);
    const key = JSON.stringify([threadId, fileId, url]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, url, source, policy: "auto", upgrade: null, bytes: 0, retiredUrls: [], listeners: new Set(), controller: new AbortController(), touched: ++this.clock };
      if (!this.closed) this.entries.set(key, entry);
    }
    const item = entry;
    item.listeners.add(listener);
    item.touched = ++this.clock;
    if (item.state && !this.closed) listener(item.state);
    return {
      load: (policy, retry) => {
        if (this.closed || item.controller.signal.aborted || policy === "auto" && item.policy !== "auto") return;
        if (item.state?.status === "loading") {
          if (policy !== "auto" && (item.policy === "auto" || policy === "sandbox" && item.policy === "download")) {
            item.policy = policy;
            item.upgrade = policy;
          }
          return;
        }
        if (!retry && item.state) return;
        item.policy = policy;
        this.enqueue(item);
      },
      release: () => {
        item.listeners.delete(listener);
        item.touched = ++this.clock;
        if (!item.listeners.size) {
          for (const url of item.retiredUrls) URL.revokeObjectURL(url);
          item.retiredUrls = [];
          if (item.state?.status !== "ready") this.remove(item);
        }
        this.evict();
      },
    };
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    for (const entry of this.entries.values()) {
      this.remove(entry);
      for (const listener of entry.listeners) listener({ status: "error" });
      entry.listeners.clear();
    }
  }

  private remove(entry: CacheEntry) {
    entry.controller.abort();
    if (entry.state?.url) URL.revokeObjectURL(entry.state.url);
    for (const url of entry.retiredUrls) URL.revokeObjectURL(url);
    entry.retiredUrls = [];
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  private evict() {
    const idle = [...this.entries.values()].filter(entry => !entry.listeners.size).sort((a, b) => a.touched - b.touched);
    let bytes = idle.reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of idle) {
      if (bytes <= this.maxBytes) break;
      bytes -= entry.bytes;
      this.remove(entry);
    }
  }

  private set(entry: CacheEntry, state: LoadedAttachment) {
    if (this.closed || entry.controller.signal.aborted) return;
    if (entry.state?.url) entry.retiredUrls.push(entry.state.url);
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  }

  private enqueue(entry: CacheEntry) {
    this.set(entry, { status: "loading" });
    this.queue.push(async () => {
      const policy = entry.policy;
      entry.upgrade = null;
      const result = await this.fetch(entry, policy);
      if (!result) return;
      if (this.closed || entry.controller.signal.aborted) {
        if (result.url) URL.revokeObjectURL(result.url);
        return;
      }
      const upgrade = entry.upgrade;
      entry.upgrade = null;
      // A pending explicit request may recover an automatic failure; ready bytes already satisfy every view.
      if (result.status === "error" && upgrade) this.enqueue(entry);
      else this.set(entry, result);
    });
    this.pump();
  }

  private async fetch(entry: CacheEntry, policy: RequestPolicy): Promise<LoadedAttachment | undefined> {
    const allowSandbox = policy === "sandbox";
    const signal = entry.controller.signal;
    if (signal.aborted) return;
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await entry.source.fetch(`${entry.url}?mode=${policy === "auto" ? "auto" : "download"}${allowSandbox ? "&sandbox=start" : ""}`, {
          signal,
          ...(allowSandbox ? { method: "POST", headers: { "X-Conversation-Sandbox-Consent": "start" } } : {}),
        });
        if (signal.aborted) return;
        if (!response.ok) {
          if (!allowSandbox && !entry.upgrade && (response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
            const retryAfter = response.headers.get("Retry-After");
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
            const delay = Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay) : this.retryDelayMs * 2 ** attempt;
            // A long server backoff belongs to an explicit retry, not a timer that keeps a view alive indefinitely.
            if (delay <= 30_000) {
              await response.body?.cancel();
              await this.wait(delay, signal);
              if (signal.aborted) return;
              continue;
            }
          }
          const parsed = FileError.safeParse(await response.json().catch(() => null));
          const body = parsed.success ? parsed.data : null;
          return response.status === 409 && body?.code === "sandbox_consent_required"
            ? { status: "error", needsSandbox: true }
            : { status: "error", error: body?.error ?? "Could not load this file." };
        }
        const blob = await response.blob();
        const mime = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
        const text = mime === "text/plain" ? await blob.slice(0, 64 * 1024).text() : undefined;
        if (signal.aborted) return;
        entry.bytes = blob.size;
        return { status: "ready", url: URL.createObjectURL(blob), mime, text };
      }
    } catch (error) {
      if (!signal.aborted) return { status: "error", error: error instanceof Error ? error.message : "Could not load this file." };
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  private pump() {
    while (!this.closed && this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      if (!job) break;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }
}

/** A view subscribes to shared bytes; closing it releases its pins without discarding the session cache. */
export class AttachmentLoader {
  private states = new Map<string, LoadedAttachment>();
  private subscriptions = new Map<string, ReturnType<AttachmentCache["subscribe"]>>();
  private cache: AttachmentCache;
  private closed = false;
  constructor(private threadId: string, private changed: (states: Map<string, LoadedAttachment>) => void, private source: AttachmentSource = adminSource) {
    this.cache = source.cache ?? new AttachmentCache();
  }

  observe(file: Pick<WebAttachment, "id">) {
    if (this.closed) return;
    const previous = this.subscriptions.get(file.id);
    if (previous) return previous;
    const subscription = this.cache.subscribe(this.source, this.threadId, file.id, state => {
      if (this.closed) return;
      this.states.set(file.id, state);
      this.changed(new Map(this.states));
    });
    this.subscriptions.set(file.id, subscription);
    return subscription;
  }

  load(file: WebAttachment, mode: AttachmentMode, retry = false, allowSandbox = false) {
    this.observe(file)?.load(allowSandbox ? "sandbox" : mode, retry);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscriptions.values()) subscription.release();
    this.subscriptions.clear();
    this.states.clear();
    if (!this.source.cache) this.cache.dispose();
  }
}
