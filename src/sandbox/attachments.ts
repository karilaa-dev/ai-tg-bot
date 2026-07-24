import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolBuildInput } from "../ai/tools/types.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { threadChainScope } from "../memory/retrieval.js";
import { botAttachmentRoot, guestAttachmentRoot } from "./paths.js";

export interface StagedInputFile {
  file_id: number;
  path: string;
  name: string;
  size: number;
}

export interface StagedAttachments {
  files: StagedInputFile[];
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export type ChatFileStagingInput = Pick<
  ToolBuildInput,
  "config" | "repos" | "user" | "thread" | "resolveFile"
>;

export async function stageChatFiles(
  input: ChatFileStagingInput,
  requestedIds: number[],
  signal?: AbortSignal,
): Promise<StagedAttachments> {
  const ids = [...new Set(requestedIds)];
  if (!ids.length) {
    return {
      files: [],
      env: {},
      async cleanup() {},
    };
  }
  const scope = await threadChainScope(input.repos, input.thread);
  const rows = await input.repos.files.listByIds(scope.fileIds);
  const byId = new Map(rows.map((file) => [file.id, file]));
  const requestedFiles = ids.map((id) => {
    const file = byId.get(id);
    if (!file) throw new Error(`Input file #${id} is not available in this thread.`);
    return file;
  });
  const resolveFile = input.resolveFile;
  if (!resolveFile) throw new Error("Chat attachment byte access is unavailable.");
  const callId = randomUUID();
  const hostRoot = path.join(botAttachmentRoot(input.config, input.user.tg_id, input.thread.id), callId);
  const guestRoot = path.posix.join(guestAttachmentRoot(input.thread.id), callId);
  await fs.mkdir(hostRoot, { recursive: true, mode: 0o700 });
  const files: StagedInputFile[] = [];
  try {
    const resolvedFiles = await Promise.all(requestedFiles.map(async (file) => {
      throwIfAborted(signal);
      const resolved = await resolveFile(file, signal);
      throwIfAborted(signal);
      if (resolved.bytes.length > MAX_FILE_BYTES) {
        throw new Error(`Input file #${file.id} exceeds the file size limit.`);
      }
      return { file, bytes: resolved.bytes };
    }));
    for (const { file, bytes } of resolvedFiles) {
      const hostPath = path.join(hostRoot, String(file.id));
      await fs.writeFile(hostPath, bytes, { flag: "wx", mode: 0o400 });
      const guestPath = path.posix.join(guestRoot, String(file.id));
      files.push({ file_id: file.id, path: guestPath, name: file.name, size: bytes.length });
    }
  } catch (error) {
    try {
      await fs.rm(hostRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "attachment staging and cleanup both failed");
    }
    throw error;
  }
  return {
    files,
    env: Object.fromEntries(files.map((file) => [`CHAT_FILE_${file.file_id}`, file.path])),
    async cleanup() {
      await fs.rm(hostRoot, { recursive: true, force: true });
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
}
