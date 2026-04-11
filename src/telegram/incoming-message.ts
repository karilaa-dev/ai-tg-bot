import type { Message } from 'grammy/types';

import type { IncomingEnvelope, PersistedPartInput, ThreadKey } from '../domain.js';

type TelegramMessage = Message & {
  message_thread_id?: number;
  from?: {
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
};

export interface UserMetadata {
  userName: string;
  userLang: string;
}

export function isSupportedChatType(message: TelegramMessage): boolean {
  return message.chat.type === 'private';
}

export function resolveThreadKey(message: TelegramMessage): ThreadKey {
  return {
    chatId: Number(message.chat.id),
    messageThreadId: Number(message.message_thread_id ?? 0),
  };
}

export function extractUserMetadata(message: TelegramMessage): UserMetadata {
  const firstName = message.from?.first_name?.trim();
  const lastName = message.from?.last_name?.trim();
  const username = message.from?.username?.trim();
  const userName = [firstName, lastName].filter(Boolean).join(' ') || username || 'Telegram User';
  const userLang = message.from?.language_code?.trim() || 'unknown';

  return {
    userName,
    userLang,
  };
}

export function extractIncomingEnvelope(message: TelegramMessage): IncomingEnvelope | null {
  const parts: PersistedPartInput[] = [];

  if (message.text?.trim()) {
    parts.push({
      type: 'text',
      text: message.text,
    });
  } else if (message.photo && message.photo.length > 0) {
    const largest = [...message.photo].sort((left, right) => (left.file_size ?? 0) - (right.file_size ?? 0)).at(-1);

    if (!largest?.file_id) {
      return null;
    }

    if (message.caption?.trim()) {
      parts.push({
        type: 'text',
        text: message.caption,
      });
    }

    parts.push({
      type: 'image',
      telegramFileId: largest.file_id,
      mediaType: 'image/jpeg',
    });
  } else if (message.document?.mime_type?.startsWith('image/') && message.document.file_id) {
    if (message.caption?.trim()) {
      parts.push({
        type: 'text',
        text: message.caption,
      });
    }

    parts.push({
      type: 'image',
      telegramFileId: message.document.file_id,
      mediaType: message.document.mime_type,
    });
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    telegramMessageId: Number(message.message_id),
    parts,
  };
}

export function shouldWarnUnsupportedMessage(message: TelegramMessage): boolean {
  if (!message.from || message.from.is_bot) {
    return false;
  }

  return (
    'sticker' in message ||
    'video' in message ||
    'video_note' in message ||
    'voice' in message ||
    'audio' in message ||
    'animation' in message ||
    'contact' in message ||
    'location' in message ||
    'venue' in message ||
    'poll' in message ||
    'game' in message ||
    'dice' in message ||
    'document' in message
  );
}

export function mergeIncomingEnvelopes(envelopes: IncomingEnvelope[]): IncomingEnvelope {
  if (envelopes.length === 0) {
    throw new Error('At least one envelope is required');
  }

  const mergedParts: PersistedPartInput[] = [];

  for (const envelope of envelopes) {
    if (mergedParts.length > 0) {
      insertBoundary(mergedParts, envelope.parts);
    }

    mergedParts.push(...envelope.parts);
  }

  return {
    telegramMessageId: envelopes.at(-1)?.telegramMessageId ?? envelopes[0]!.telegramMessageId,
    parts: mergedParts,
  };
}

function insertBoundary(existingParts: PersistedPartInput[], nextParts: PersistedPartInput[]): void {
  const previous = existingParts.at(-1);
  const next = nextParts[0];

  if (!previous || !next) {
    return;
  }

  if (previous.type === 'text') {
    previous.text = `${previous.text ?? ''}\n\n`;
    return;
  }

  if (next.type === 'text') {
    next.text = `\n\n${next.text ?? ''}`;
  }
}
