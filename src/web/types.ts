export interface WebUser {
  id: number;
  name: string | null;
  username: string | null;
  lastActivity: number;
  threadCount: number;
}

export function userLabel(user: Pick<WebUser, "id" | "name" | "username">): string {
  return user.username ? `@${user.username}` : user.name || `User ${user.id}`;
}

export interface WebThread {
  id: number;
  userId: number;
  title: string;
  archived: boolean;
  parentThreadId: number | null;
  forkPointMessageId: number | null;
  lastActivity: number;
}

export interface WebAttachment {
  id: number;
  name: string;
  size: number | null;
  mimeType: string | null;
  caption: string | null;
}

export interface WebMessage {
  id: number;
  threadId: number;
  role: "user" | "assistant" | "system";
  text: string;
  thinking: string | null;
  createdAt: number;
  attachments: WebAttachment[];
}

export interface WebPage<T> { items: T[]; nextOffset: number | null }
export interface WebHistory {
  user: WebUser;
  thread: WebThread;
  chain: Pick<WebThread, "id" | "title" | "parentThreadId" | "forkPointMessageId">[];
  messages: WebMessage[];
  olderCursor: number | null;
  newerCursor: number | null;
  autoLoadMaxBytes: number;
  maxFileBytes: number;
}
