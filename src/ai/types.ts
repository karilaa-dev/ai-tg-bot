import { type Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { MessageKind, MessageRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { FileRow } from "../db/types.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import type { ResolvedChatFile } from "../files/source.js";
import { type InferenceUsageDelta } from "../pi/usage.js";
import { OutgoingBuffers } from "../files/outgoingBuffers.js";

export interface TurnInput {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  logger: Logger;
  user: UserRow;
  thread: ThreadRow;
  text: string;
  userMessageKind?: MessageKind;
  userMessageContent?: unknown;
  userMessageId?: number;
  turnRunId?: number;
  signal?: AbortSignal;
  outgoingBuffers?: OutgoingBuffers;
  deliveryTiming?: { startedAt: number; firstTextMs?: number; firstFileMs?: number; lastFileMs?: number };
  onUserMessagePersisted?: (message: MessageRow) => Promise<void>;
  onAwaitingDelivery?: (result: {
    assistantMessageId: number;
    provider?: string;
    model?: string;
    usage?: InferenceUsageDelta;
  }) => Promise<void>;
  onDeliveryStarting?: () => boolean;
  onDeliveryConfirmed?: (result: { assistantMessageId: number }) => Promise<void>;
  onDeliveryUnknown?: (result: { assistantMessageId: number; failureCode: string }) => Promise<void>;
  onDeliveryFailed?: (result: { assistantMessageId: number; failureCode: string }) => Promise<void>;
  onExecutionFailure?: (failureCode: string) => Promise<void>;
  resolveFile?: (file: FileRow, signal?: AbortSignal) => Promise<ResolvedChatFile>;
  pi?: Pick<PiRuntimeService, "runtime">;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export type TurnRunner = (input: TurnInput) => Promise<void>;


export type ThinkingDelivery = {
  handled: true;
  messageIds: number[];
};
