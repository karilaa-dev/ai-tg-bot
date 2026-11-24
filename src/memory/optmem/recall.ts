import { Worker } from "node:worker_threads";
import { z } from "zod";
import { runMemo, type MemoInput, type MemoResult } from "./index.js";
import { MemoError } from "./records.js";
import { raceWithAbort } from "../../files/cancel.js";

const Reply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("matches"), values: z.array(z.boolean()) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

/**
 * One deadline covers worker startup and every batch of a recall. A pattern
 * that backtracks badly then returns a recoverable tool error instead of
 * holding the turn, which itself has no time limit by default.
 */
export const RECALL_DEADLINE_MS = 5_000;

type WorkerState =
  | { phase: "idle" }
  | { phase: "waiting"; expected: "ready" | "matches"; resolve: (values: boolean[]) => void; reject: (error: unknown) => void }
  | { phase: "failed"; error: unknown };

class RecallDeadlineError extends Error {}

// Only regex matching runs in the worker; database ownership stays in the caller.
export async function recallInWorker(
  input: Omit<MemoInput, "args">,
  pattern: string,
  signal?: AbortSignal,
  options: { deadlineMs?: number } = {},
): Promise<MemoResult> {
  signal?.throwIfAborted();
  const deadlineMs = options.deadlineMs ?? RECALL_DEADLINE_MS;
  const deadlineController = new AbortController();
  const searchSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
  const entry = import.meta.url.endsWith(".ts") ? "./recallWorker.ts" : "./recallWorker.js";
  const worker = new Worker(new URL(entry, import.meta.url), { workerData: pattern });
  let state: WorkerState = { phase: "idle" };
  const fail = (error: unknown) => {
    if (state.phase === "failed") return;
    if (state.phase === "waiting") state.reject(error);
    state = { phase: "failed", error };
  };
  const receive = (expected: "ready" | "matches") => new Promise<boolean[]>((resolve, reject) => {
    if (state.phase === "failed") reject(state.error);
    else if (state.phase === "waiting") reject(new Error("Memory search already has an outstanding request."));
    else state = { phase: "waiting", expected, resolve, reject };
  });
  const ready = receive("ready");
  const abort = () => fail(searchSignal.reason);
  worker.on("message", (message: unknown) => {
    const parsed = Reply.safeParse(message);
    if (!parsed.success) { fail(new Error("Invalid memory search result", { cause: parsed.error })); return; }
    const reply = parsed.data;
    if (reply.kind === "error") { fail(new MemoError(reply.message)); return; }
    if (state.phase !== "waiting" || state.expected !== reply.kind) {
      fail(new Error("Unexpected memory search worker reply."));
      return;
    }
    state.resolve(reply.kind === "ready" ? [] : reply.values);
    state = { phase: "idle" };
  });
  worker.once("error", fail);
  worker.once("exit", code => fail(new Error(`Memory search worker exited (${code}).`)));
  searchSignal.addEventListener("abort", abort, { once: true });
  if (searchSignal.aborted) abort();
  const deadline = setTimeout(() => deadlineController.abort(new RecallDeadlineError()), deadlineMs);
  try {
    return await raceWithAbort((async () => {
      await ready;
      searchSignal.throwIfAborted();
      return runMemo({ ...input, signal: searchSignal, args: ["recall", pattern], matchRecall: async lines => {
        searchSignal.throwIfAborted();
        const result = receive("matches");
        try { worker.postMessage(lines); } catch (error) { fail(error); }
        const values = await result;
        if (values.length !== lines.length) throw new Error("Invalid memory search batch size.");
        return values;
      } });
    })(), searchSignal);
  } catch (error) {
    if (error instanceof MemoError) return { stdout: "", stderr: error.message + "\n", exit_code: 1 };
    // The caller's cancellation keeps its own reason; only the deadline becomes a tool error.
    if (error instanceof RecallDeadlineError && !signal?.aborted) {
      return { stdout: "", stderr: `Memory search stopped after ${deadlineMs / 1_000} seconds. Use a simpler or more specific pattern, for example literal words or an anchored date, and avoid nested repetition such as (a+)+.\n`, exit_code: 1 };
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    searchSignal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
