import type { WebAttachment } from "../types.js";

export interface LoadedAttachment { status: "loading" | "ready" | "error"; url?: string; text?: string; mime?: string; error?: string; needsSandbox?: boolean }

/** One queue per open thread; disposal cancels queued and active work and releases every blob. */
export class AttachmentLoader {
  private controller = new AbortController();
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private states = new Map<number, LoadedAttachment>();
  constructor(private threadId: number, private changed: (states: Map<number, LoadedAttachment>) => void) {}

  load(file: WebAttachment, mode: "auto" | "download", retry = false, allowSandbox = false) {
    if (this.controller.signal.aborted || (!retry && this.states.has(file.id))) return;
    if (this.states.get(file.id)?.status === "loading") return;
    this.set(file.id, { status: "loading" });
    this.queue.push(async () => {
      try {
        const response = await fetch(`/api/threads/${this.threadId}/files/${file.id}?mode=${mode}${allowSandbox ? "&sandbox=start" : ""}`, {
          signal: this.controller.signal,
          ...(allowSandbox ? { method: "POST", headers: { "X-Conversation-Sandbox-Consent": "start" } } : {}),
        });
        if (!response.ok) {
          const body = await response.json() as { error?: string; code?: string };
          if (response.status === 409 && body.code === "sandbox_consent_required") {
            if (!this.controller.signal.aborted) this.set(file.id, { status: "error", needsSandbox: true });
            return;
          }
          throw new Error(body.error ?? "Could not load this file.");
        }
        const blob = await response.blob();
        const mime = response.headers.get("content-type") ?? "application/octet-stream";
        const text = mime.startsWith("text/plain") ? await blob.slice(0, 64 * 1024).text() : undefined;
        if (this.controller.signal.aborted) return;
        this.set(file.id, { status: "ready", url: URL.createObjectURL(blob), mime, text });
      } catch (error) {
        if (!this.controller.signal.aborted) this.set(file.id, { status: "error", error: error instanceof Error ? error.message : "Could not load this file." });
      }
    });
    this.pump();
  }

  dispose() {
    this.controller.abort();
    this.queue = [];
    for (const state of this.states.values()) if (state.url) URL.revokeObjectURL(state.url);
    this.states.clear();
  }

  private set(id: number, state: LoadedAttachment) {
    const previous = this.states.get(id);
    if (previous?.url) URL.revokeObjectURL(previous.url);
    this.states.set(id, state);
    this.changed(new Map(this.states));
  }

  private pump() {
    while (!this.controller.signal.aborted && this.active < 3 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }
}
