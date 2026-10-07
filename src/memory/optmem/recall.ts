import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { MemoResult } from "./index.js";

const Reply = z.object({ stdout: z.string(), stderr: z.string(), exit_code: z.union([z.literal(0), z.literal(1)]) });

// Regex execution is unbounded upstream. Keep it off the bot's event loop so an
// expensive search can be cancelled without interrupting another user's turn.
export async function recallInWorker(directory: string, pattern: string, signal?: AbortSignal): Promise<MemoResult> {
  signal?.throwIfAborted();
  const entry = import.meta.url.endsWith(".ts") ? "./recallWorker.ts" : "./recallWorker.js";
  const worker = new Worker(new URL(entry, import.meta.url), { workerData: { directory, args: ["recall", pattern] } });
  let abort: () => void = () => {};
  try {
    return await new Promise<MemoResult>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error("Memory search aborted"));
      worker.once("message", (message: unknown) => {
        const result = Reply.safeParse(message);
        if (result.success) resolve(result.data);
        else reject(new Error("Invalid memory search result", { cause: result.error }));
      });
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`Memory search worker exited before returning a result (${code}).`)));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
