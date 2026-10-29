import { WebHttpError } from "./auth.js";

/** One outstanding download per identity; distinct identities wait in FIFO order. */
export class DownloadPool {
  private active = 0;
  private readonly users = new Set<number>();
  private readonly queue: Array<() => void> = [];

  async acquire(userId: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.users.has(userId)) throw new WebHttpError(429, "Your previous file is still loading. Try again shortly.", { "Retry-After": "1" });
    if (this.active >= 3 && this.queue.length >= 24) throw new WebHttpError(503, "Other files are loading. Try again shortly.");
    this.users.add(userId);
    if (this.active >= 3) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ready = () => { signal.removeEventListener("abort", aborted); resolve(); };
          const aborted = () => {
            this.queue.splice(this.queue.indexOf(ready), 1);
            reject(signal.reason);
          };
          this.queue.push(ready);
          signal.addEventListener("abort", aborted, { once: true });
        });
      } catch (error) { this.users.delete(userId); throw error; }
    } else this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.users.delete(userId);
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    return release;
  }
}
