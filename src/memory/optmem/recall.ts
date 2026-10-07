import { Worker } from "node:worker_threads";
import { z } from "zod";
import { runMemo, type MemoInput, type MemoResult } from "./index.js";
import { MemoError } from "./records.js";

const Reply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("matches"), values: z.array(z.boolean()) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

// Only regex matching runs in the worker; database ownership stays in the caller.
export async function recallInWorker(input: Omit<MemoInput, "args">, pattern: string, signal?: AbortSignal): Promise<MemoResult> {
  signal?.throwIfAborted();
  const entry = import.meta.url.endsWith(".ts") ? "./recallWorker.ts" : "./recallWorker.js";
  const worker = new Worker(new URL(entry, import.meta.url), { workerData: pattern });
  let pending: { resolve: (value: boolean[]) => void; reject: (error: unknown) => void } | undefined;
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => { failure = { error }; pending?.reject(error); pending = undefined; };
  const receive = () => new Promise<boolean[]>((resolve, reject) => {
    if (failure) reject(failure.error);
    else pending = { resolve, reject };
  });
  const ready = receive();
  const abort = () => fail(signal?.reason ?? new Error("Memory search aborted"));
  worker.on("message", (message: unknown) => {
    const parsed = Reply.safeParse(message);
    if (!parsed.success) { fail(new Error("Invalid memory search result", { cause: parsed.error })); return; }
    const reply = parsed.data;
    if (reply.kind === "error") { fail(new MemoError(reply.message)); return; }
    pending?.resolve(reply.kind === "ready" ? [] : reply.values);
    pending = undefined;
  });
  worker.once("error", fail);
  worker.once("exit", code => fail(new Error(`Memory search worker exited (${code}).`)));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await ready;
    return await runMemo({ ...input, args: ["recall", pattern], matchRecall: async lines => {
      signal?.throwIfAborted();
      const result = receive();
      worker.postMessage(lines);
      const values = await result;
      if (values.length !== lines.length) throw new Error("Invalid memory search batch size.");
      return values;
    } });
  } catch (error) {
    if (error instanceof MemoError) return { stdout: "", stderr: error.message + "\n", exit_code: 1 };
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
