import type { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, StoredFileType, ThreadRow, UserRow } from "../../db/types.js";
import type { Logger } from "../../logger.js";
import type { TextEmbedder } from "../../memory/embeddings.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES } from "../../files/limits.js";

export interface ToolBuildInput {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  logger?: Logger;
  embedder?: TextEmbedder;
  redownloadFile?: (file: FileRow) => Promise<Buffer>;
  createdFiles?: CreatedFileAttachment[];
  pendingCreatedFiles?: PendingCreatedFile[];
  imageGenerator?: BotImageGenerator;
}

export interface CreatedFileAttachment {
  fileId: number;
  type: StoredFileType;
  name: string;
  path: string;
  size: number;
  caption?: string | null;
  inline: boolean;
  card: string;
  delivery?: "document" | "photo";
  origin?: "created_file" | "generated_image";
}

export type PendingCreatedFile = Promise<{ attachment?: CreatedFileAttachment; revisedPrompt?: string | null; error?: string }>;
export type ImageGenerationMode = "auto" | "generate" | "edit";
export type CreatedFileDeliveryPreference = "auto" | "photo" | "document";

export const GENERATED_IMAGE_FINAL_TEXT_GUIDANCE =
  'Write one concise past-tense final sentence starting with "Done —" that says what you generated or changed. Do not mention imagegen, generate_image, or an image tool.';

export const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_BASH_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_LOADED_MESSAGE_CHARS = 8000;
export const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

export interface ImageGenerationReference {
  fileId: number;
  name: string;
  path: string;
  mimeType: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  quality: AppConfig["CODEX_IMAGE_QUALITY"];
  size: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  mode: ImageGenerationMode;
  references: ImageGenerationReference[];
}

export interface ImageGenerationResult {
  imageBase64: string;
  revisedPrompt?: string | null;
  status?: string | null;
  mediaType?: string | null;
}

export type BotImageGenerator = (input: ImageGenerationRequest) => Promise<ImageGenerationResult>;

export interface BotToolDefinition<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input) => Promise<Output>;
  toModelOutput?: (input: { toolCallId: string; input: Input; output: Output }) => unknown | Promise<unknown>;
}

export type BotToolRegistry = Record<string, BotToolDefinition<any, any>>;

export function defineBotTool<Input, Output>(definition: BotToolDefinition<Input, Output>): BotToolDefinition<Input, Output> {
  return definition;
}

export interface CodexDynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
  exposeToContext?: boolean;
}

export type CodexToolContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface LoadMessageFileEntry {
  file_id: number;
  type: StoredFileType;
  name: string;
  summary: string | null;
  inline: boolean;
}

export interface LoadMessageImageEntry {
  file_id: number;
  name: string;
  caption: string | null;
  path: string;
  telegram_file_id: string | null;
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
    };
