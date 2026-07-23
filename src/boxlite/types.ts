export interface BoxInfo {
  id: string;
  name?: string;
  image: string;
  cpus: number;
  memoryMib: number;
  running: boolean;
  status: string;
}

export interface BoxInputStream {
  writeString(value: string): Promise<void>;
  close(): Promise<void>;
}

export interface BoxOutputStream {
  next(): Promise<string | null>;
}

export interface BoxExecution {
  stdin(): Promise<BoxInputStream>;
  stdout(): Promise<BoxOutputStream>;
  stderr(): Promise<BoxOutputStream>;
  wait(): Promise<{ exitCode: number; errorMessage?: string }>;
  kill(): Promise<void>;
}

// stop() makes a handle terminal immediately, even if the request later rejects or times out.
// Reattach with BoxClient.get() before using the box again, or remove it by identity.
export interface BoxHandle {
  id: string;
  name?: string;
  info(): BoxInfo;
  start(): Promise<void>;
  stop(): Promise<void>;
  copyOut(containerSource: string, hostDestination: string): Promise<void>;
  exec(
    command: string,
    args: string[],
    env: Array<[string, string]>,
    tty: boolean,
    user: string,
    timeoutSecs: number,
    workingDir: string,
  ): Promise<BoxExecution>;
}

export interface BoxCreateOptions {
  image: string;
  cpus: number;
  memoryMib: number;
  diskSizeGb: number;
  workingDir: string;
  volumes: Array<{ hostPath: string; guestPath: string; readOnly: boolean }>;
  network: { mode: "enabled"; allowNet?: string[] };
  ports: [];
  autoRemove: false;
  detach: true;
  user: string;
  security: {
    jailerEnabled: true;
    seccompEnabled: true;
    maxOpenFiles: number;
    maxFileSize: number;
    maxProcesses: number;
    maxCpuTime: number;
    networkEnabled: true;
    closeFds: true;
  };
}

export interface BoxClient {
  // Returns a fresh handle, though BoxLite 0.9.7 may keep a stopped remote identity invalidated.
  get(name: string): Promise<BoxHandle | undefined>;
  getOrCreate(options: BoxCreateOptions, name: string): Promise<{ box: BoxHandle; created: boolean }>;
  listInfo(): Promise<BoxInfo[]>;
  remove(idOrName: string, force?: boolean): Promise<void>;
  shutdown(): Promise<void>;
}

export type BoxClientProvider = () => Promise<BoxClient>;

export interface BoxCommandRequest {
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

export interface BoxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export interface BoxFileExportRequest {
  userId: number;
  guestPath: string;
  hostDestination: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface CommandRuntime {
  execute(request: BoxCommandRequest): Promise<BoxCommandResult>;
  exportFile(request: BoxFileExportRequest): Promise<void>;
  dispose(): Promise<void>;
}
