import { WebHttpError } from "./auth.js";

/** Map membership is the download state: waiting for admission, active with a unique lease, or absent. */
export class DownloadPool {
  private readonly active = new Map<number, () => void>();
  private readonly waiting = new Map<number, () => void>();

  async acquire(userId: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active.has(userId) || this.waiting.has(userId)) throw new WebHttpError(429, "Your previous file is still loading. Try again shortly.", { "Retry-After": "1" });
    if (this.active.size < 3) return this.admit(userId);
    if (this.waiting.size >= 24) throw new WebHttpError(503, "Other files are loading. Try again shortly.");

    const release = await new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(userId);
        reject(signal.reason);
      };
      this.waiting.set(userId, () => {
        signal.removeEventListener("abort", abort);
        this.waiting.delete(userId);
        resolve(this.admit(userId));
      });
      signal.addEventListener("abort", abort, { once: true });
    });
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    return release;
  }

  private admit(userId: number): () => void {
    const release = () => {
      if (this.active.get(userId) !== release) return;
      this.active.delete(userId);
      this.waiting.values().next().value?.();
    };
    this.active.set(userId, release);
    return release;
  }
}
