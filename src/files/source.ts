export interface ChatFileSource {
  transport: string;
  connectionKey: string;
  remoteKey: string;
  locator: Record<string, unknown>;
  mimeType?: string | null;
}

/** Browser reads may inspect running sandboxes but need consent to resume one. */
export interface FileReadPolicy { allowSandboxResume: boolean; pauseAfterRead: boolean }
export class SandboxConsentRequired extends Error {
  constructor() { super("This attachment needs its sandbox to be started."); }
}

export interface ChatFileSourceAdapter {
  readonly transport: string;
  readonly connectionKey: string;
  fetch(source: ChatFileSource, signal?: AbortSignal, maxBytes?: number, policy?: FileReadPolicy): Promise<Buffer | Uint8Array>;
}

export interface ResolvedChatFile {
  bytes: Buffer;
  mimeType: string | null;
  size: number;
  contentSha256: string;
  source: ChatFileSource;
}
