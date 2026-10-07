import path from "node:path";
import type { AppConfig } from "../config.js";
import { runMemo } from "./optmem/index.js";

export function userMemoryDirectory(config: Pick<AppConfig, "OPTMEM_DIR" | "PI_CODING_AGENT_DIR">, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid memory owner.");
  return path.resolve(config.OPTMEM_DIR ?? path.join(config.PI_CODING_AGENT_DIR, "memory"), String(userId));
}

export async function initializeUserMemory(config: AppConfig, userId: number): Promise<void> {
  const result = await runMemo({ directory: userMemoryDirectory(config, userId), args: ["init"] });
  if (result.exit_code) throw new Error(`OptMem initialization failed: ${result.stderr}`);
}
