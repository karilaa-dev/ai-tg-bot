import type { Readable } from "node:stream";

export interface ChatFileSource {
  transport: string;
  connectionKey: string;
  remoteKey: string;
  locator: Record<string, unknown>;
  mimeType?: string | null;
}

export interface ChatFileSourceAdapter {
  readonly transport: string;
  readonly connectionKey: string;
  fetch(source: ChatFileSource, signal?: AbortSignal): Promise<Buffer | Uint8Array | Readable>;
}

export interface ResolvedChatFile {
  path: string;
  bytes: Buffer;
  mimeType: string | null;
  size: number;
  contentSha256: string;
  expiresAt: number;
  source: ChatFileSource;
}

export function sourceIdentity(source: Pick<ChatFileSource, "transport" | "connectionKey" | "remoteKey">): string {
  return `${source.transport}\u0000${source.connectionKey}\u0000${source.remoteKey}`;
}
