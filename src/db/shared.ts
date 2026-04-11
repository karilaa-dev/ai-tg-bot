import type { ChatThreadRecord, MessagePartRecord, MessageRecord, PersistedPartInput } from '../domain.js';

export interface RawThreadRow {
  id: number | string;
  chat_id: number | string;
  message_thread_id: number | string;
  thinking_enabled: boolean | number;
  compact_message: string | null;
  compacted_through_message_id: number | string | null;
  is_generating: boolean | number;
  active_draft_id: number | string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface RawMessageRow {
  id: number | string;
  thread_id: number | string;
  role: 'user' | 'assistant';
  telegram_message_id: number | string | null;
  responded_by_assistant_message_id: number | string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface RawMessagePartRow {
  id: number | string;
  message_id: number | string;
  part_index: number | string;
  type: 'text' | 'image';
  text: string | null;
  telegram_file_id: string | null;
  media_type: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function mapThread(row: RawThreadRow): ChatThreadRecord {
  return {
    id: Number(row.id),
    chatId: Number(row.chat_id),
    messageThreadId: Number(row.message_thread_id),
    thinkingEnabled: Boolean(row.thinking_enabled),
    compactMessage: row.compact_message,
    compactedThroughMessageId:
      row.compacted_through_message_id === null ? null : Number(row.compacted_through_message_id),
    isGenerating: Boolean(row.is_generating),
    activeDraftId: row.active_draft_id === null ? null : Number(row.active_draft_id),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

export function mapMessage(row: RawMessageRow, parts: MessagePartRecord[]): MessageRecord {
  return {
    id: Number(row.id),
    threadId: Number(row.thread_id),
    role: row.role,
    telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
    respondedByAssistantMessageId:
      row.responded_by_assistant_message_id === null ? null : Number(row.responded_by_assistant_message_id),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    parts,
  };
}

export function mapPart(row: RawMessagePartRow): MessagePartRecord {
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    partIndex: Number(row.part_index),
    type: row.type,
    text: row.text,
    telegramFileId: row.telegram_file_id,
    mediaType: row.media_type,
  };
}

export function groupMessages(rows: RawMessageRow[], partRows: RawMessagePartRow[]): MessageRecord[] {
  const partsByMessageId = new Map<number, MessagePartRecord[]>();

  for (const partRow of partRows) {
    const part = mapPart(partRow);
    const parts = partsByMessageId.get(part.messageId) ?? [];
    parts.push(part);
    partsByMessageId.set(part.messageId, parts);
  }

  return rows.map((row) => mapMessage(row, partsByMessageId.get(Number(row.id)) ?? []));
}

export function normalizeParts(parts: PersistedPartInput[]): PersistedPartInput[] {
  const normalized: PersistedPartInput[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      const text = part.text ?? '';
      if (text.trim().length > 0) {
        normalized.push({
          type: 'text',
          text,
        });
      }
      continue;
    }

    const imagePart: PersistedPartInput = {
      type: 'image',
    };

    if (part.telegramFileId) {
      imagePart.telegramFileId = part.telegramFileId;
    }

    if (part.mediaType) {
      imagePart.mediaType = part.mediaType;
    }

    normalized.push(imagePart);
  }

  return normalized;
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
