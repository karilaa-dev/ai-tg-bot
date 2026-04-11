export type DatabaseClient = 'sqlite3' | 'pg';

export type MessageRole = 'user' | 'assistant';

export type MessagePartType = 'text' | 'image';

export interface ThreadKey {
  chatId: number;
  messageThreadId: number;
}

export interface MessagePartRecord {
  id: number;
  messageId: number;
  partIndex: number;
  type: MessagePartType;
  text: string | null;
  telegramFileId: string | null;
  mediaType: string | null;
}

export interface MessageRecord {
  id: number;
  threadId: number;
  role: MessageRole;
  telegramMessageId: number | null;
  respondedByAssistantMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  parts: MessagePartRecord[];
}

export interface ChatThreadRecord {
  id: number;
  chatId: number;
  messageThreadId: number;
  thinkingEnabled: boolean;
  compactMessage: string | null;
  compactedThroughMessageId: number | null;
  isGenerating: boolean;
  activeDraftId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedPartInput {
  type: MessagePartType;
  text?: string;
  telegramFileId?: string;
  mediaType?: string;
}

export interface CreateMessageInput {
  threadId: number;
  role: MessageRole;
  telegramMessageId?: number | null;
  parts: PersistedPartInput[];
}

export interface PromptContext {
  modelName: string;
  botName: string;
  time: string;
  timezone: string;
  date: string;
  userName: string;
  userLang: string;
}

export interface IncomingEnvelope {
  telegramMessageId: number;
  parts: PersistedPartInput[];
}

export interface ThreadSnapshot {
  thread: ChatThreadRecord;
  messages: MessageRecord[];
  cutoffMessageId: number;
  pendingUserMessageIds: number[];
}

export interface DatabaseRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getOrCreateThread(chatId: number, messageThreadId: number): Promise<ChatThreadRecord>;
  getThreadByKey(chatId: number, messageThreadId: number): Promise<ChatThreadRecord | null>;
  getThreadById(threadId: number): Promise<ChatThreadRecord | null>;
  updateThinkingEnabled(threadId: number, enabled: boolean): Promise<ChatThreadRecord>;
  setGenerationState(threadId: number, isGenerating: boolean, activeDraftId: number | null): Promise<void>;
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  listMessages(threadId: number): Promise<MessageRecord[]>;
  listPendingUserMessages(threadId: number): Promise<MessageRecord[]>;
  markUserMessagesResponded(userMessageIds: number[], assistantMessageId: number): Promise<void>;
  updateCompaction(threadId: number, compactMessage: string, throughMessageId: number): Promise<ChatThreadRecord>;
}
