export interface SandboxThreadFile {
  fileId: number;
  messageId: number | null;
  name: string;
  mimeType: string | null;
  expectedSize: number | null;
  expectedSha256: string | null;
  telegramRefs: Array<{
    id: number;
    telegramFileId: string;
    telegramSize: number | null;
    isPrimary: boolean;
    lastSeenAt: number;
  }>;
}

export interface SandboxCommandRequest {
  userId: number;
  threadId: number;
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  workingDir: string;
  timeoutMs: number;
  maxOutputChars: number;
  threadFiles?: SandboxThreadFile[];
  signal?: AbortSignal;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  threadFiles: SandboxThreadFileSyncResult;
  error?: string;
}

export interface SandboxThreadFileSyncResult {
  directory: string;
  available: number;
}

export interface SandboxFileReadRequest {
  userId: number;
  threadId: number;
  virtualPath: string;
  maxBytes: number;
  threadFiles?: SandboxThreadFile[];
  signal?: AbortSignal;
}

export interface SandboxFileReadResult {
  sandboxId: string;
  canonicalPath: string;
  bytes: Buffer;
}

export interface SandboxSourceFileReadRequest {
  sandboxId: string;
  userId: number;
  threadId: number;
  canonicalPath: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface PublishWebsiteRequest {
  userId: number;
  threadId: number;
  port: number;
  path?: string;
  threadFiles?: SandboxThreadFile[];
  signal?: AbortSignal;
}

export interface PublishedWebsite {
  sandboxId: string;
  port: number;
  path: string;
  url: string;
  pausesAfterMinutes: number;
}

export interface SandboxActivityLease {
  release(): void;
}

export interface CommandRuntime {
  acquireActivityLease?(userId: number, threadId: number): SandboxActivityLease;
  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  readWorkspaceFile(request: SandboxFileReadRequest): Promise<SandboxFileReadResult>;
  readSourceFile(request: SandboxSourceFileReadRequest): Promise<Buffer>;
  publishWebsite(request: PublishWebsiteRequest): Promise<PublishedWebsite>;
  dispose(): Promise<void>;
}
