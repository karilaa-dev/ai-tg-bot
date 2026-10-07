import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { compileRecallPattern } from "./regex.js";

try {
  const pattern = compileRecallPattern(z.string().parse(workerData));
  parentPort?.on("message", (input: unknown) => {
    const lines = z.array(z.string()).max(256).parse(input);
    parentPort?.postMessage({ kind: "matches", values: lines.map(line => pattern.test(line)) });
  });
  parentPort?.postMessage({ kind: "ready" });
} catch (error) {
  parentPort?.postMessage({ kind: "error", message: `bad regex: ${error instanceof Error ? error.message : String(error)}` });
}
