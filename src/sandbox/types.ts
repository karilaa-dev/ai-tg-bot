export interface SandboxCommandRequest {
  userId: number;
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  workingDir: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export interface SandboxFileExportRequest {
  userId: number;
  guestPath: string;
  hostDestination: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface CommandRuntime {
  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  exportFile(request: SandboxFileExportRequest): Promise<void>;
  dispose(): Promise<void>;
}

