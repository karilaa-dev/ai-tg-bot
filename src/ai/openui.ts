import type { ThreadRow } from "../db/types.js";
import { validateOpenUi } from "../openui/validate.js";

export function threadAllowsOpenUi(thread: Pick<ThreadRow, "origin"> | undefined): boolean {
  return thread?.origin === "web";
}

export function finishResponseOpenUi(thread: Pick<ThreadRow, "origin">, source: string | undefined, fallback: string): string | undefined {
  if (source === undefined) return undefined;
  if (!threadAllowsOpenUi(thread)) throw new Error("OpenUI is only available in threads created on the website. Finish with plain text and files.");
  if (!fallback.trim()) throw new Error("OpenUI requires a short accompanying answer in text.");
  return validateOpenUi(source);
}
