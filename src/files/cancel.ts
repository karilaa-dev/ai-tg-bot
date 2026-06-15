export class FileProcessingCancelledError extends Error {
  constructor() {
    super("file processing cancelled");
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FileProcessingCancelledError();
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof FileProcessingCancelledError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

export function relayAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  const onAbort = () => abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
