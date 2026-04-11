import type { ThreadKey } from './domain.js';

export function makeThreadKey(thread: ThreadKey): string {
  return `${thread.chatId}:${thread.messageThreadId}`;
}
