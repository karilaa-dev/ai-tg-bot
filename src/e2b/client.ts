import {
  FileType,
  Sandbox,
  type CommandHandle,
  type CommandResult,
  type EntryInfo,
  type SandboxInfo,
} from "e2b";
import type { AppConfig } from "../config.js";

export const E2B_IDLE_PAUSE_MS = 3 * 60_000;
export const E2B_WEBSITE_IDLE_PAUSE_MS = 15 * 60_000;
export const E2B_WEBSITE_IDLE_PAUSE_MINUTES = E2B_WEBSITE_IDLE_PAUSE_MS / 60_000;

export interface E2BCommandHandle {
  readonly pid: number;
  wait(): Promise<CommandResult>;
  kill(): Promise<boolean>;
}

export interface E2BSandbox {
  readonly id: string;
  run(
    command: string,
    options?: {
      background?: false;
      cwd?: string;
      envs?: Record<string, string>;
      user?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<CommandResult>;
  runBackground(
    command: string,
    options?: {
      cwd?: string;
      envs?: Record<string, string>;
      user?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<E2BCommandHandle>;
  writeFile(path: string, data: string | Buffer | Uint8Array, user?: string, signal?: AbortSignal): Promise<void>;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  readText(path: string, signal?: AbortSignal): Promise<string>;
  fileInfo(path: string, signal?: AbortSignal): Promise<EntryInfo>;
  fileExists(path: string, signal?: AbortSignal): Promise<boolean>;
  removeFile(path: string, user?: string, signal?: AbortSignal): Promise<void>;
  getHost(port: number): string;
  isRunning(signal?: AbortSignal): Promise<boolean>;
  setTimeout(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  pause(signal?: AbortSignal): Promise<boolean>;
}

export interface E2BClient {
  list(metadata: Record<string, string>, signal?: AbortSignal): Promise<SandboxInfo[]>;
  getInfo(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo>;
  create(metadata: Record<string, string>, signal?: AbortSignal): Promise<E2BSandbox>;
  connect(sandboxId: string, timeoutMs: number, signal?: AbortSignal): Promise<E2BSandbox>;
}

export function createE2BClient(config: AppConfig): E2BClient {
  return new SdkE2BClient(config);
}

class SdkE2BClient implements E2BClient {
  constructor(private readonly config: AppConfig) {}

  async list(metadata: Record<string, string>, signal?: AbortSignal): Promise<SandboxInfo[]> {
    const paginator = Sandbox.list({
      apiKey: this.config.E2B_API_KEY,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
      query: { metadata, state: ["running", "paused"] },
    });
    const items: SandboxInfo[] = [];
    do {
      items.push(...await paginator.nextItems({
        apiKey: this.config.E2B_API_KEY,
        requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
        signal,
      }));
    } while (paginator.hasNext);
    return items;
  }

  getInfo(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo> {
    return Sandbox.getInfo(sandboxId, {
      apiKey: this.config.E2B_API_KEY,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
      signal,
    });
  }

  async create(metadata: Record<string, string>, signal?: AbortSignal): Promise<E2BSandbox> {
    const sandbox = await Sandbox.create(this.config.E2B_TEMPLATE, {
      apiKey: this.config.E2B_API_KEY,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
      signal,
      metadata,
      timeoutMs: E2B_IDLE_PAUSE_MS,
      secure: true,
      allowInternetAccess: true,
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: false,
      },
      network: {
        allowPublicTraffic: true,
      },
    });
    return new SdkE2BSandbox(sandbox, this.config);
  }

  async connect(sandboxId: string, timeoutMs: number, signal?: AbortSignal): Promise<E2BSandbox> {
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey: this.config.E2B_API_KEY,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
      signal,
      timeoutMs,
    });
    return new SdkE2BSandbox(sandbox, this.config);
  }
}

class SdkE2BSandbox implements E2BSandbox {
  readonly id: string;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly config: AppConfig,
  ) {
    this.id = sandbox.sandboxId;
  }

  run(command: string, options: Parameters<E2BSandbox["run"]>[1] = {}): Promise<CommandResult> {
    return this.sandbox.commands.run(command, {
      ...options,
      background: false,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  runBackground(
    command: string,
    options: Parameters<E2BSandbox["runBackground"]>[1] = {},
  ): Promise<CommandHandle> {
    return this.sandbox.commands.run(command, {
      ...options,
      background: true,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  async writeFile(
    path: string,
    data: string | Buffer | Uint8Array,
    user = "root",
    signal?: AbortSignal,
  ): Promise<void> {
    const payload = typeof data === "string" ? data : exactArrayBuffer(data);
    await this.sandbox.files.write(path, payload, {
      user,
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.sandbox.files.read(path, {
      format: "bytes",
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  readText(path: string, signal?: AbortSignal): Promise<string> {
    return this.sandbox.files.read(path, {
      format: "text",
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  fileInfo(path: string, signal?: AbortSignal): Promise<EntryInfo> {
    return this.sandbox.files.getInfo(path, {
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.files.exists(path, {
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  removeFile(path: string, user = "root", signal?: AbortSignal): Promise<void> {
    return this.sandbox.files.remove(path, {
      user,
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  getHost(port: number): string {
    return this.sandbox.getHost(port);
  }

  isRunning(signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.isRunning({
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  setTimeout(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return this.sandbox.setTimeout(timeoutMs, {
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }

  pause(signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.pause({
      keepMemory: true,
      signal,
      requestTimeoutMs: this.config.E2B_REQUEST_TIMEOUT_MS,
    });
  }
}

function exactArrayBuffer(value: Buffer | Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export { FileType };
