import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
  type ExecutionHandlers,
  type NetworkPolicy,
  type RunCommandOpts,
  type SandboxInfo,
  type WriteEntry,
} from "@alibaba-group/opensandbox";
import type { AppConfig } from "../config.js";

export type OpenSandboxState = string;

export const PUBLIC_INTERNET_NETWORK_POLICY: NetworkPolicy = {
  defaultAction: "allow",
  egress: [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ].map((target) => ({ action: "deny", target })),
};

export interface OpenSandboxInfo {
  id: string;
  state: OpenSandboxState;
  metadata: Record<string, string>;
  createdAt: Date;
}

export interface OpenSandboxCreateSpec {
  image: string;
  metadata: Record<string, string>;
  hostPath: string;
  cpu: string;
  memory: string;
  readyTimeoutMs: number;
}

export interface OpenSandboxConnection {
  readonly id: string;
  getInfo(): Promise<OpenSandboxInfo>;
  run(
    command: string,
    options: RunCommandOpts,
    handlers: ExecutionHandlers,
    signal?: AbortSignal,
  ): Promise<{ id?: string; exitCode?: number | null; error?: { name: string; value: string } }>;
  interrupt(executionId: string): Promise<void>;
  writeFiles(entries: WriteEntry[]): Promise<void>;
  readBytes(path: string, options?: { range?: string; offset?: number; limit?: number }): Promise<Uint8Array>;
  deleteFiles(paths: string[]): Promise<void>;
  pause(): Promise<void>;
  resume(readyTimeoutMs: number): Promise<OpenSandboxConnection>;
  close(): Promise<void>;
}

export interface OpenSandboxClient {
  list(metadata: Record<string, string>): Promise<OpenSandboxInfo[]>;
  getInfo(id: string): Promise<OpenSandboxInfo>;
  create(spec: OpenSandboxCreateSpec): Promise<OpenSandboxConnection>;
  connect(id: string, readyTimeoutMs: number): Promise<OpenSandboxConnection>;
  resume(id: string, readyTimeoutMs: number): Promise<OpenSandboxConnection>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  close(): Promise<void>;
}

export type OpenSandboxClientProvider = () => Promise<OpenSandboxClient>;

export function createOpenSandboxClientProvider(config: AppConfig): OpenSandboxClientProvider {
  return createRetryableOpenSandboxClientProvider(() => createOpenSandboxClient(config));
}

export function createRetryableOpenSandboxClientProvider(
  factory: () => Promise<OpenSandboxClient>,
): OpenSandboxClientProvider {
  let client: OpenSandboxClient | undefined;
  let pending: Promise<OpenSandboxClient> | undefined;
  return async () => {
    if (client) return client;
    pending ??= factory();
    const initialization = pending;
    try {
      client = await initialization;
      return client;
    } finally {
      if (pending === initialization) pending = undefined;
    }
  };
}

export async function createOpenSandboxClient(config: AppConfig): Promise<OpenSandboxClient> {
  const connectionConfig = new ConnectionConfig({
    domain: config.OPEN_SANDBOX_DOMAIN,
    protocol: config.OPEN_SANDBOX_PROTOCOL,
    apiKey: config.OPEN_SANDBOX_API_KEY,
    requestTimeoutSeconds: Math.max(1, Math.ceil(config.OPEN_SANDBOX_CONTROL_TIMEOUT_MS / 1000)),
    useServerProxy: config.OPEN_SANDBOX_USE_SERVER_PROXY,
  });
  return new SdkOpenSandboxClient(connectionConfig);
}

export function formatSandboxError(error: unknown): string {
  return String(error);
}

class SdkOpenSandboxClient implements OpenSandboxClient {
  private readonly manager: SandboxManager;

  constructor(private readonly connectionConfig: ConnectionConfig) {
    this.manager = SandboxManager.create({ connectionConfig });
  }

  async list(metadata: Record<string, string>): Promise<OpenSandboxInfo[]> {
    const items: OpenSandboxInfo[] = [];
    let page = 1;
    while (true) {
      const response = await this.manager.listSandboxInfos({ metadata, page, pageSize: 100 });
      items.push(...response.items.map(toOpenSandboxInfo));
      if (!response.pagination?.hasNextPage) return items;
      page += 1;
    }
  }

  async getInfo(id: string): Promise<OpenSandboxInfo> {
    return toOpenSandboxInfo(await this.manager.getSandboxInfo(id));
  }

  async create(spec: OpenSandboxCreateSpec): Promise<OpenSandboxConnection> {
    const sandbox = await Sandbox.create({
      connectionConfig: this.connectionConfig,
      image: spec.image,
      metadata: spec.metadata,
      entrypoint: ["tail", "-f", "/dev/null"],
      resource: { cpu: spec.cpu, memory: spec.memory },
      timeoutSeconds: null,
      networkPolicy: PUBLIC_INTERNET_NETWORK_POLICY,
      volumes: [{
        name: "user-data",
        host: { path: spec.hostPath },
        mountPath: "/data",
        readOnly: false,
      }],
      readyTimeoutSeconds: Math.max(1, Math.ceil(spec.readyTimeoutMs / 1000)),
    });
    return new SdkOpenSandboxConnection(sandbox);
  }

  async connect(id: string, readyTimeoutMs: number): Promise<OpenSandboxConnection> {
    return new SdkOpenSandboxConnection(await Sandbox.connect({
      connectionConfig: this.connectionConfig,
      sandboxId: id,
      readyTimeoutSeconds: Math.max(1, Math.ceil(readyTimeoutMs / 1000)),
    }));
  }

  async resume(id: string, readyTimeoutMs: number): Promise<OpenSandboxConnection> {
    return new SdkOpenSandboxConnection(await Sandbox.resume({
      connectionConfig: this.connectionConfig,
      sandboxId: id,
      readyTimeoutSeconds: Math.max(1, Math.ceil(readyTimeoutMs / 1000)),
    }));
  }

  pause(id: string): Promise<void> {
    return this.manager.pauseSandbox(id);
  }

  kill(id: string): Promise<void> {
    return this.manager.killSandbox(id);
  }

  async close(): Promise<void> {
    await this.manager.close();
    await this.connectionConfig.closeTransport();
  }
}

class SdkOpenSandboxConnection implements OpenSandboxConnection {
  readonly id: string;

  constructor(private readonly sandbox: Sandbox) {
    this.id = sandbox.id;
  }

  async getInfo(): Promise<OpenSandboxInfo> {
    return toOpenSandboxInfo(await this.sandbox.getInfo());
  }

  async run(
    command: string,
    options: RunCommandOpts,
    handlers: ExecutionHandlers,
    signal?: AbortSignal,
  ) {
    return this.sandbox.commands.run(command, options, handlers, signal);
  }

  interrupt(executionId: string): Promise<void> {
    return this.sandbox.commands.interrupt(executionId);
  }

  writeFiles(entries: WriteEntry[]): Promise<void> {
    return this.sandbox.files.writeFiles(entries);
  }

  readBytes(path: string, options?: { range?: string; offset?: number; limit?: number }): Promise<Uint8Array> {
    return this.sandbox.files.readBytes(path, options);
  }

  deleteFiles(paths: string[]): Promise<void> {
    return this.sandbox.files.deleteFiles(paths);
  }

  pause(): Promise<void> {
    return this.sandbox.pause();
  }

  async resume(readyTimeoutMs: number): Promise<OpenSandboxConnection> {
    return new SdkOpenSandboxConnection(await this.sandbox.resume({
      readyTimeoutSeconds: Math.max(1, Math.ceil(readyTimeoutMs / 1000)),
    }));
  }

  close(): Promise<void> {
    return this.sandbox.close();
  }
}

function toOpenSandboxInfo(info: SandboxInfo): OpenSandboxInfo {
  return {
    id: info.id,
    state: info.status.state,
    metadata: info.metadata ?? {},
    createdAt: info.createdAt,
  };
}
