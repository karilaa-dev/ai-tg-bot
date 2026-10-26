/** `requestId` is kept while the content is unchanged so a retried send cannot post twice. */
export interface Draft { text: string; files: File[]; requestId: string | null }
export type DraftKey = string;
export type PendingSend = Omit<Draft, "requestId"> & { requestId: string } & (
  | { status: "sending" }
  | { status: "sent"; messageId: number; sentAt: number }
  | { status: "failed"; error: unknown }
);

export const emptyDraft: Draft = { text: "", files: [], requestId: null };
const noPendingSends: readonly PendingSend[] = [];
const storagePrefix = "chat-draft:";

export function clearStoredDrafts(keepPrefix?: string) {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(storagePrefix) && (keepPrefix === undefined || !key.startsWith(keepPrefix))) sessionStorage.removeItem(key);
    }
  } catch { /* Storage can be disabled. */ }
}

export function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; LAN deployments may serve plain HTTP.
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export const isEmptyDraft = (draft: Draft) => !draft.text.trim() && !draft.files.length;

/** Each verified login owns a revocable store, including callbacks still in flight. */
export class DraftStore {
  readonly id = newRequestId();
  private drafts = new Map<DraftKey, Draft>();
  private starts = new Map<string, Draft>();
  private sends = new Map<DraftKey, readonly PendingSend[]>();
  private listeners = new Set<() => void>();
  private closed = false;
  private prefix: string;

  constructor(readonly userId: number) {
    this.prefix = `${storagePrefix}${userId}:`;
    clearStoredDrafts(this.prefix);
  }

  get active() { return !this.closed; }

  read(key: DraftKey): Draft {
    if (this.closed) return emptyDraft;
    const saved = this.drafts.get(key);
    if (saved) return saved;
    let text = "";
    try { text = sessionStorage.getItem(this.prefix + key) ?? ""; } catch { /* Storage can be disabled. */ }
    return { ...emptyDraft, text };
  }

  write(key: DraftKey, draft: Draft) {
    if (this.closed) return;
    if (isEmptyDraft(draft)) this.drafts.delete(key); else this.drafts.set(key, draft);
    try {
      if (draft.text) sessionStorage.setItem(this.prefix + key, draft.text); else sessionStorage.removeItem(this.prefix + key);
    } catch { /* Keep the draft in memory only. */ }
  }

  pending(key: DraftKey): readonly PendingSend[] {
    return this.closed ? noPendingSends : this.sends.get(key) ?? noPendingSends;
  }

  updatePending(key: DraftKey, update: (current: readonly PendingSend[]) => readonly PendingSend[]) {
    if (this.closed) return;
    const current = this.pending(key);
    const next = update(current);
    if (next === current) return;
    if (next.length) this.sends.set(key, next); else this.sends.delete(key);
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  queueStart(threadId: string, draft: Draft) { if (!this.closed) this.starts.set(threadId, draft); }
  takeStart(threadId: string): Draft | undefined {
    const draft = this.starts.get(threadId);
    this.starts.delete(threadId);
    return draft;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.drafts.clear();
    this.starts.clear();
    this.sends.clear();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
    clearStoredDrafts();
  }
}
