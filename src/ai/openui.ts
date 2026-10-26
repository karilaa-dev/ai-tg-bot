import type { ThreadRow } from "../db/types.js";
import { inspectOpenUi, validateOpenUi } from "../openui/validate.js";
import { threadChainScope } from "../memory/retrieval.js";
import type { FileResolver } from "../files/resolver.js";
import type { CreatedFileAttachment } from "../files/types.js";
import type { TurnInput } from "./types.js";

export function threadAllowsOpenUi(thread: Pick<ThreadRow, "origin"> | undefined): boolean {
  return thread?.origin === "web";
}

export function finishResponseOpenUi(thread: Pick<ThreadRow, "origin">, source: string | undefined, fallback: string): string | undefined {
  if (source === undefined) return undefined;
  if (!threadAllowsOpenUi(thread)) throw new Error("OpenUI is only available in threads created on the website. Finish with plain text and files.");
  if (!fallback.trim()) throw new Error("OpenUI requires a short accompanying answer in text.");
  return validateOpenUi(source);
}

export async function retainOpenUiImages(input: Pick<TurnInput, "repos" | "thread" | "resolveFile" | "signal"> & {
  source: string; fileResolver: FileResolver; attachments: CreatedFileAttachment[]; maxMessageId?: number;
}): Promise<void> {
  const { fileIds } = inspectOpenUi(input.source);
  if (!fileIds.length) return;
  const scope = await threadChainScope(input.repos, input.thread, input.maxMessageId);
  for (const id of fileIds) {
    input.signal?.throwIfAborted();
    const attachment = input.attachments.find(file => file.fileId === id);
    if (!attachment && !scope.fileIds.includes(id)) throw new Error(`OpenUI image #${id} is not available in this conversation.`);
    const file = await input.repos.files.get(id, scope.messageScopes);
    if (!file || file.type !== "image") throw new Error(`OpenUI image #${id} is unavailable.`);
    const resolved = attachment?.data ?? (await (input.resolveFile
      ? input.resolveFile(file, input.signal) : input.fileResolver.resolveFile(file, input.signal))).bytes;
    await input.fileResolver.persistFile(file, resolved, input.signal);
  }
}
