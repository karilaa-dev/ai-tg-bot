import type { MessageRecord } from './domain.js';

export function renderMessageForCompaction(message: MessageRecord): string {
  const role = message.role.toUpperCase();
  const parts = message.parts
    .map((part) => {
      if (part.type === 'text') {
        return part.text ?? '';
      }

      return `[Image attachment: file_id=${part.telegramFileId ?? 'unknown'}${part.mediaType ? `, media_type=${part.mediaType}` : ''}]`;
    })
    .filter(Boolean)
    .join('\n');

  return `${role}: ${parts}`;
}
