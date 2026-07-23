import type { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, StoredFileType, ThreadRow, UserRow } from "../../db/types.js";
import type { Logger } from "../../logger.js";
import type { TextEmbedder } from "../../memory/embeddings.js";
import type { ResolvedChatFile } from "../../files/source.js";
import type { CommandRuntime } from "../../sandbox/types.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES } from "../../files/limits.js";

export interface ToolBuildInput {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  logger?: Logger;
  embedder?: TextEmbedder;
  commandRuntime?: CommandRuntime;
  resolveFile?: (file: FileRow, signal?: AbortSignal) => Promise<ResolvedChatFile>;
  selectContextFiles?: (fileIds: number[]) => void;
  selectDurableContextFiles?: (fileIds: number[]) => void;
  createdFiles?: CreatedFileAttachment[];
  pendingCreatedFiles?: PendingCreatedFile[];
}

export interface CreatedFileAttachment {
  fileId: number;
  type: StoredFileType;
  name: string;
  mimeType?: string | null;
  path?: string;
  data?: Buffer;
  size: number;
  caption?: string | null;
  inline: boolean;
  card: string;
  delivery?: "document" | "photo";
  origin?: "created_file" | "generated_image";
  telegramDelivery?: {
    messageId: number;
    fileId: string | null;
    fileUniqueId: string | null;
  };
}

export type PendingCreatedFile = Promise<{ attachment?: CreatedFileAttachment; revisedPrompt?: string | null; error?: string }>;
export type CreatedFileDeliveryPreference = "auto" | "photo" | "document";
export const MAX_LOADED_MESSAGE_CHARS = 8000;
export const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

export interface BotToolDefinition<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input, signal?: AbortSignal) => Promise<Output>;
  toModelOutput?: (input: { toolCallId: string; input: Input; output: Output }) => unknown | Promise<unknown>;
}

export type BotToolRegistry = Record<string, BotToolDefinition<any, any>>;

export function defineBotTool<Input, Output>(definition: BotToolDefinition<Input, Output>): BotToolDefinition<Input, Output> {
  return definition;
}

export interface LoadMessageFileEntry {
  file_id: number;
  marker: string;
  type: StoredFileType;
  name: string;
  summary: string | null;
  inline: boolean;
  bash_input_file_id: number;
}

export interface LoadMessageImageEntry {
  file_id: number;
  marker: string;
  name: string;
  caption: string | null;
  note: string;
}

export type LoadMessageResult =
  | { error: string }
  | {
      message_id: number;
      role: string;
      kind: string | null;
      text: string;
      truncated: boolean;
      files: LoadMessageFileEntry[];
      images: LoadMessageImageEntry[];
      materialized_file_ids: number[];
      durable_file_ids: number[];
    };
