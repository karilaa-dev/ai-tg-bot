import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
  type ExecutionHandlers,
  type ListSandboxesResponse,
  type NetworkPolicy,
  type RunCommandOpts,
  type SandboxInfo,
  type WriteEntry,
} from "@alibaba-group/opensandbox";
import type { AppConfig } from "../config.js";

export type OpenSandboxState = string;

// The pinned opensandbox/egress:v1.1.4 sidecar supports IPv4/IPv6 CIDR targets
// in dns+nft mode despite stale FQDN-only comments in the lifecycle SDK schema.
// Its nftables rules exempt the loopback interface before consulting deny sets,
// so loopback entries are defense in depth and must not be treated as overriding
// that exemption. Revalidate before changing the image or enforcement mode.
export const PUBLIC_INTERNET_NETWORK_POLICY: NetworkPolicy = {
  defaultAction: "allow",
  egress: [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
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
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "64:ff9b:1::/48",
    "100::/64",
    "100:0:0:1::/64",
    "2001::/32",
    "2001:2::/48",
    "2001:10::/28",
    "2001:20::/28",
    "2001:db8::/32",
    "2002::/16",
    "3fff::/20",
    "5f00::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
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
  mounts: Array<{
    name: string;
    hostPath: string;
    mountPath: string;
    readOnly: boolean;
  }>;
  cpu: string;
  memory: string;
  readyTimeoutMs: number;
  idleReleaseMs: number;
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
  renew(id: string, idleReleaseMs: number): Promise<void>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  close(): Promise<void>;
}

export type OpenSandboxClientProvider = () => Promise<OpenSandboxClient>;

const SANDBOX_LIST_PAGE_SIZE = 100;
const MAX_SANDBOX_LIST_PAGES = 1_000;

export function createOpenSandboxClientProvider(config: AppConfig): OpenSandboxClientProvider {
  return createRetryableOpenSandboxClientProvider(() => createOpenSandboxClient(config));
}

export function createRetryableOpenSandboxClientProvider(
  factory: () => Promise<OpenSandboxClient>,
): OpenSandboxClientProvider {
  // Share concurrent factory work only. The runtime owns the returned client
  // and closes it if later reconciliation fails, so a subsequent attempt must
  // receive a fresh transport instead of the previously resolved client.
  let pending: Promise<OpenSandboxClient> | undefined;
  return () => {
    pending ??= factory();
    const initialization = pending;
    void initialization.finally(() => {
      if (pending === initialization) pending = undefined;
    }).catch(() => undefined);
    return initialization;
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
    for (let page = 1; page <= MAX_SANDBOX_LIST_PAGES; page += 1) {
      const response = await this.manager.listSandboxInfos({
        metadata,
        page,
        pageSize: SANDBOX_LIST_PAGE_SIZE,
      });
      const hasNextPage = assertConsistentPagination(response, page);
      items.push(...response.items.map(toOpenSandboxInfo));
      if (!hasNextPage) return items;
    }
    throw new Error(`OpenSandbox sandbox listing exceeded ${MAX_SANDBOX_LIST_PAGES} pages.`);
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
      timeoutSeconds: Math.max(1, Math.ceil(spec.idleReleaseMs / 1000)),
      networkPolicy: PUBLIC_INTERNET_NETWORK_POLICY,
      volumes: spec.mounts.map((mount) => ({
        name: mount.name,
        host: { path: mount.hostPath },
        mountPath: mount.mountPath,
        readOnly: mount.readOnly,
      })),
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

  renew(id: string, idleReleaseMs: number): Promise<void> {
    return this.manager.renewSandbox(id, Math.max(1, Math.ceil(idleReleaseMs / 1000)));
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

function assertConsistentPagination(
  response: ListSandboxesResponse,
  requestedPage: number,
): boolean {
  const pagination = response.pagination;
  if (!pagination) {
    throw new Error(
      `OpenSandbox returned inconsistent sandbox pagination for requested page ${requestedPage}.`,
    );
  }
  const emptyPageSet = pagination.totalPages === 0
    && requestedPage === 1
    && pagination.hasNextPage === false;
  const expectedHasNextPage = requestedPage < pagination.totalPages;
  if (
    !Number.isSafeInteger(pagination.page)
    || pagination.page !== requestedPage
    || !Number.isSafeInteger(pagination.totalPages)
    || pagination.totalPages < 0
    || (!emptyPageSet && pagination.totalPages < requestedPage)
    || pagination.hasNextPage !== expectedHasNextPage
  ) {
    throw new Error(
      `OpenSandbox returned inconsistent sandbox pagination for requested page ${requestedPage}.`,
    );
  }
  return pagination.hasNextPage;
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
