import type { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, StoredFileType, ThreadRow, UserRow } from "../../db/types.js";
import type { Logger } from "../../logger.js";
import type { ResolvedChatFile } from "../../files/source.js";
import type { CommandRuntime } from "../../sandbox/types.js";
import type { PublishedWebsite } from "../../sandbox/types.js";
import { MAX_FILE_BYTES } from "../../files/limits.js";
import type { BrowserUseToolRuntime } from "../../browserUse/runtime.js";
import type { OutgoingFiles } from "../../files/outgoingFiles.js";
import type { ThreadScope } from "../../memory/retrieval.js";

export interface ToolBuildInput {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  maxMessageId?: number;
  currentScope?: () => Promise<ThreadScope>;
  outgoingFiles?: OutgoingFiles;
  logger?: Logger;
  commandRuntime?: CommandRuntime;
  browserRuntime?: BrowserUseToolRuntime;
  resolveFile?: (file: FileRow, signal?: AbortSignal) => Promise<ResolvedChatFile>;
  selectContextFiles?: (fileIds: number[]) => void;
  selectDurableContextFiles?: (fileIds: number[]) => void;
  publishedWebsites?: PublishedWebsite[];
  registerPublishedWebsite?: (website: PublishedWebsite) => void;
}

export const MAX_LOADED_MESSAGE_CHARS = 8000;
export const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

interface BotToolDefinition<Input = unknown, Output = unknown> {
  description: string;
  holdsCommandActivity?: boolean;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input, signal?: AbortSignal) => Promise<Output>;
  toModelOutput?: (input: { toolCallId: string; input: Input; output: Output }) => unknown | Promise<unknown>;
  toToolDetails?: (input: { toolCallId: string; input: Input; output: Output }) => unknown | Promise<unknown>;
}

export type BotToolRegistry = Record<string, BotToolDefinition<any, any>>;

export function defineBotTool<Input, Output>(definition: BotToolDefinition<Input, Output>): BotToolDefinition<Input, Output> {
  return definition;
}

interface LoadMessageFileEntry {
  file_id: number;
  marker: string;
  type: StoredFileType;
  name: string;
  summary: string | null;
  inline: boolean;
  bash_input_file_id: number;
  source_only: boolean;
  recommended_tool: "materialize_chat_files" | "load_message";
}

interface LoadMessageImageEntry {
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
      sandbox_file_ids: number[];
    };
