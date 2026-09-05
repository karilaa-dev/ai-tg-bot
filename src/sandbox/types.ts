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
    width?: number | null;
    height?: number | null;
    direction: "inbound" | "outbound";
    mediaKind: "document" | "photo";
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

interface SandboxMaterializedFile {
  fileId: number;
  originalName: string;
  mimeType: string | null;
  path: string | null;
  status: "available" | "source_unavailable" | "restore_failed";
  errorCode?: string;
}

export interface SandboxThreadFileSyncResult {
  directory: string;
  available: number;
  files: SandboxMaterializedFile[];
}

export interface SandboxFileMaterializeRequest {
  userId: number;
  threadId: number;
  files: SandboxThreadFile[];
  signal?: AbortSignal;
}

export interface SandboxFileReadRequest {
  userId: number;
  threadId: number;
  virtualPath: string;
  maxBytes: number;
  preserveSource?: boolean;
  threadFiles?: SandboxThreadFile[];
  signal?: AbortSignal;
}

export interface SandboxFileReadResult {
  sandboxId: string;
  canonicalPath: string;
  sourceCanonicalPath: string | null;
  bytes: Buffer;
  size: number;
  contentSha256: string;
}

export interface SandboxFileWriteRequest {
  userId: number;
  threadId: number;
  virtualPath: string;
  bytes: Buffer;
  signal?: AbortSignal;
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
  siteDirectory: string;
  path?: string;
  threadFiles?: SandboxThreadFile[];
  signal?: AbortSignal;
}

export interface PublishedWebsite {
  sandboxId: string;
  port: number;
  siteDirectory: string;
  path: string;
  url: string;
  pausesAfterMinutes: number;
}

export interface SandboxActivityLease {
  release(): void;
}

export interface CommandRuntime {
  acquireActivityLease?(userId: number, threadId: number): SandboxActivityLease;
  materializeFiles(request: SandboxFileMaterializeRequest): Promise<SandboxThreadFileSyncResult>;
  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  readWorkspaceFile(request: SandboxFileReadRequest): Promise<SandboxFileReadResult>;
  writeWorkspaceFile?(request: SandboxFileWriteRequest): Promise<void>;
  readSourceFile(request: SandboxSourceFileReadRequest): Promise<Buffer>;
  publishWebsite(request: PublishWebsiteRequest): Promise<PublishedWebsite>;
  dispose(): Promise<void>;
}
