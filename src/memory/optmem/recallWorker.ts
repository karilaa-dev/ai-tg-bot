import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { runMemo } from "./index.js";

const input = z.object({ directory: z.string(), args: z.tuple([z.literal("recall"), z.string()]) }).parse(workerData);
parentPort?.postMessage(await runMemo(input));
