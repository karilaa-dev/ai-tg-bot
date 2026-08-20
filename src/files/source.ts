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
  fetch(source: ChatFileSource, signal?: AbortSignal): Promise<Buffer | Uint8Array>;
}

export interface ResolvedChatFile {
  bytes: Buffer;
  mimeType: string | null;
  size: number;
  contentSha256: string;
  source: ChatFileSource;
}
