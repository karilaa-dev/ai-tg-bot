import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { raceWithAbort } from "../files/cancel.js";
import type { Logger } from "../logger.js";
import { CODEX_EXECUTOR_VERSION, type RemoteExecutorEndpoint } from "../e2b/remoteExecutor.js";
import { E2B_WORKSPACE } from "../e2b/paths.js";

type Rpc = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
type CachedResponse = { result?: unknown; error?: Rpc["error"] };
type PendingRpc = { resolve(value: Rpc): void; reject(error: Error): void; timeout: NodeJS.Timeout };

export type LocalArtifactOperation = "fs/readFile" | "fs/getMetadata";
export type LocalArtifactResult = { dataBase64: string } | {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  createdAtMs: number;
  modifiedAtMs: number;
};

export interface LazyCodexExecutorInput {
  prepareExecutor(onExecutorReady: (endpoint: RemoteExecutorEndpoint) => Promise<void>, signal: AbortSignal, options: { allowRotation: boolean }): Promise<unknown>;
  /** Only registered native image outputs may resolve here; all other paths return undefined. */
  resolveLocalArtifact?(fileUrl: string, operation: LocalArtifactOperation, signal: AbortSignal): Promise<LocalArtifactResult | undefined>;
  cachePath?: string;
  logger?: Logger;
  connectTimeoutMs?: number;
}

const fileUrl = (location: string) => `file://${location}`;
const environmentInfo = {
  shell: { name: "bash", path: "/bin/bash" }, executorVersion: CODEX_EXECUTOR_VERSION,
  cwd: fileUrl(E2B_WORKSPACE), userHomeDir: "file:///home/user", platformOs: "linux", temporaryDirectories: [], tempDir: "file:///tmp",
  capabilities: {
    networkProxyLaunch: true, capabilityDiscoverySandbox: true, capabilityDiscoveryV2: true, environmentConfigRead: true,
    httpHeaderEnvVars: true, sandboxedFileStreaming: true, shellSnapshotV2: true, windowsMxc: false,
    linuxRootWritePreservesDevices: true, linuxApprovedRootWritePreservesRestrictions: true,
  },
};
const metadataPaths = ["/home/user/workspace/.git", "/home/user/.git", "/home/.git", "/.git",
  "/home/user/workspace/.agents/skills", "/home/user/workspace/AGENTS.override.md", "/home/user/workspace/AGENTS.md"];
const bootstrapRequests: Rpc[] = [
  { method: "environment/info" },
  ...metadataPaths.map(location => ({ method: "fs/getMetadata", params: { path: fileUrl(location), sandbox: null } })),
  { method: "environmentConfig/read", params: { cwd: fileUrl(E2B_WORKSPACE), configPaths: [["mcp_servers"]], requirementsPaths: [["mcp_servers"]] } },
];
const key = (request: Rpc) => JSON.stringify([request.method, request.params ?? null]);
const bootstrapKeys = new Set(bootstrapRequests.map(key));

/** A local, authenticated native executor endpoint. Connection alone never starts E2B. */
export class LazyCodexExecutor {
  readonly authBearerToken = randomBytes(32).toString("hex");
  private readonly sessionId = randomUUID();
  private readonly server = http.createServer((_request, response) => { response.writeHead(404).end(); });
  private readonly gateway = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private readonly abort = new AbortController();
  private readonly bootstrap = new Map<string, CachedResponse>();
  private readonly pending = new Map<string, PendingRpc>();
  private readonly forwarded = new Map<string, { peer: WebSocket; id: string | number }>();
  private readonly forwardedDrainers = new Set<() => void>();
  private peer?: WebSocket;
  private readonly clientInitialized = new WeakSet<WebSocket>();
  private upstream?: WebSocket;
  private preparation?: Promise<void>;
  private ready = false;
  private operationDispatched = false;
  private initialized = false;
  private disposed = false;
  private nextRpc = 0;
  private persistTail: Promise<void> = Promise.resolve();
  private endpointUrl = "";

  private constructor(private readonly input: LazyCodexExecutorInput) {
    this.bootstrap.set(key({ method: "environment/info" }), { result: environmentInfo });
    for (const request of bootstrapRequests.filter(request => request.method === "fs/getMetadata")) {
      // These paths are absent in the immutable v3 image. After execution,
      // refreshBootstrap records the actual workspace's startup probes.
      this.bootstrap.set(key(request), { error: { code: -32004, message: "No such file or directory (os error 2)" } });
    }
    this.bootstrap.set(key(bootstrapRequests.at(-1)!), { result: {
      userHomeDir: "file:///home/user", codexHomeDir: "file:///home/user/.codex", hostname: "e2b",
      config: { layers: [], cloudInsertionIndex: 0 }, requirements: { layers: [], cloudInsertionIndex: 0 },
    } });
    this.server.on("upgrade", (request, socket, head) => {
      const actual = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this.authBearerToken}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || this.disposed) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
      }
      this.gateway.handleUpgrade(request, socket, head, peer => {
        this.peer?.close(1000, "Executor client replaced");
        this.peer = peer;
        peer.on("message", (data, binary) => { void this.onMessage(peer, data, binary); });
        peer.on("error", () => undefined);
        peer.on("close", () => { if (this.peer === peer) this.peer = undefined; });
      });
    });
  }

  static async create(input: LazyCodexExecutorInput): Promise<LazyCodexExecutor> {
    const adapter = new LazyCodexExecutor(input);
    await adapter.loadBootstrap();
    await new Promise<void>((resolve, reject) => {
      adapter.server.once("error", reject);
      adapter.server.listen(0, "127.0.0.1", () => { adapter.server.off("error", reject); resolve(); });
    });
    const address = adapter.server.address();
    if (!address || typeof address === "string") throw new Error("Executor adapter did not acquire a local port");
    adapter.endpointUrl = `ws://127.0.0.1:${address.port}`;
    return adapter;
  }

  get url(): string { return this.endpointUrl; }
  get hasConnectedExecutor(): boolean { return this.ready; }

  /** Mark a new native turn; only its first remote operation may rotate E2B. */
  beginTurn(): void { this.operationDispatched = false; }

  /** Call when the conversation's visible attachment descriptor revision changes. */
  invalidateFiles(): void {
    this.ready = false;
    this.preparation = undefined;
  }

  private async onMessage(peer: WebSocket, data: RawData, binary: boolean): Promise<void> {
    let decoded: Rpc | undefined;
    if (!this.clientInitialized.has(peer)) {
      try { decoded = JSON.parse(data.toString()) as Rpc; }
      catch { peer.close(1003, "Expected a JSON RPC message"); return; }
      if (decoded.method === "initialize") {
        this.reply(peer, { id: decoded.id, result: { sessionId: this.sessionId, environmentInfo: this.bootstrap.get(key({ method: "environment/info" }))?.result ?? environmentInfo } });
        return;
      }
      this.clientInitialized.add(peer);
      if (decoded.method === "initialized") return;
    }
    // Codex saves generated images on its host, but native image edits and
    // view_image read through the selected executor. Keep those registered
    // outputs local without decoding unrelated warm command/file payloads.
    if (this.input.resolveLocalArtifact && (isLocalArtifactOperation(decoded?.method) || localArtifactOperation(data))) {
      try { decoded ??= JSON.parse(data.toString()) as Rpc; }
      catch { peer.close(1003, "Expected a JSON RPC message"); return; }
      if (await this.replyWithLocalArtifact(peer, decoded)) return;
    }
    if (this.ready && this.upstream?.readyState === WebSocket.OPEN) {
      this.forward(peer, data, binary);
      return;
    }
    let request: Rpc;
    try { request = decoded ?? JSON.parse(data.toString()) as Rpc; }
    catch { peer.close(1003, "Expected a JSON RPC message"); return; }
    if (!this.preparation) {
      if (request.method === "initialized") return;
      const cached = this.bootstrap.get(key(request));
      if (cached && request.id !== undefined) { this.reply(peer, { ...cached, id: request.id }); return; }
    }
    try {
      await this.ensureExecutor();
      if (peer.readyState === WebSocket.OPEN && this.upstream?.readyState === WebSocket.OPEN) this.forward(peer, data, binary);
    } catch (error) {
      if (request.id !== undefined) this.reply(peer, { id: request.id, error: { code: -32000, message: String(error) } });
      this.input.logger?.warn("Codex remote executor preparation failed", { error: String(error) });
    }
  }

  private async replyWithLocalArtifact(peer: WebSocket, request: Rpc): Promise<boolean> {
    if (!isLocalArtifactOperation(request.method) || typeof request.params?.path !== "string" || request.id === undefined) return false;
    try {
      const result = await raceWithAbort(this.input.resolveLocalArtifact!(request.params.path, request.method, this.abort.signal), this.abort.signal);
      if (result === undefined) return false;
      this.reply(peer, { id: request.id, result });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? -32004 : -32000;
      this.reply(peer, { id: request.id, error: { code, message: String(error) } });
      this.input.logger?.warn("Could not read a native Codex image artifact", { error: String(error) });
    }
    return true;
  }

  private ensureExecutor(): Promise<void> {
    if (this.ready && this.upstream?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.preparation) return this.preparation;
    const allowRotation = !this.operationDispatched;
    const preparation = raceWithAbort((async () => {
      // A generated artifact can invalidate the adapter while another native
      // operation is still running. Its response must arrive before a new
      // preparation may pause/reconnect E2B at the operation boundary.
      if (allowRotation) await this.waitForForwarded();
      await this.input.prepareExecutor(async endpoint => {
        if (this.upstream?.readyState !== WebSocket.OPEN || !this.initialized) await this.connect(endpoint);
      }, this.abort.signal, { allowRotation });
    })(), this.abort.signal).then(() => {
      if (this.disposed) throw new Error("Codex executor adapter is disposed");
      if (this.upstream?.readyState !== WebSocket.OPEN || !this.initialized) throw new Error("Codex remote executor disconnected during preparation");
      this.ready = true;
    });
    this.preparation = preparation;
    void preparation.catch(() => { if (this.preparation === preparation) this.preparation = undefined; });
    return preparation;
  }

  private async waitForForwarded(): Promise<void> {
    if (this.forwarded.size === 0) return;
    let completed!: () => void;
    const drained = new Promise<void>(resolve => { completed = resolve; this.forwardedDrainers.add(completed); });
    try { await raceWithAbort(drained, this.abort.signal); }
    finally { this.forwardedDrainers.delete(completed); }
  }

  private resolveForwardedDrainers(): void {
    if (this.forwarded.size > 0) return;
    for (const complete of this.forwardedDrainers) complete();
    this.forwardedDrainers.clear();
  }

  private async connect(endpoint: RemoteExecutorEndpoint): Promise<void> {
    const previous = this.upstream;
    this.upstream = undefined;
    previous?.terminate();
    const deadline = Date.now() + (this.input.connectTimeoutMs ?? 30_000);
    let lastError: unknown;
    while (!this.abort.signal.aborted && Date.now() < deadline) {
      const socket = new WebSocket(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.authBearerToken}` }, handshakeTimeout: Math.min(5_000, Math.max(1, deadline - Date.now())), maxPayload: 64 * 1024 * 1024 });
      socket.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { socket.terminate(); reject(this.abort.signal.reason); };
          const opened = () => { cleanup(); resolve(); };
          const failed = (error: Error) => { cleanup(); reject(error); };
          const cleanup = () => { this.abort.signal.removeEventListener("abort", aborted); socket.off("open", opened); socket.off("error", failed); };
          this.abort.signal.addEventListener("abort", aborted, { once: true }); socket.once("open", opened); socket.once("error", failed);
        });
        this.upstream = socket;
        this.initialized = false;
        socket.on("message", (raw, binary) => this.onUpstream(socket, raw, binary));
        socket.on("close", () => {
          if (this.upstream !== socket) return;
          const wasReady = this.ready;
          this.upstream = undefined; this.initialized = false; this.ready = false;
          // A previous socket can close while a replacement is being prepared.
          // Keep that preparation and the virtual client endpoint alive.
          if (wasReady) this.preparation = undefined;
          for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("Remote executor disconnected")); }
          this.pending.clear();
          // Operations already delivered to E2B have an uncertain outcome.
          // Return an error rather than replaying them. Idle pause/recreation
          // leaves the model's virtual executor connection uninterrupted.
          for (const request of this.forwarded.values()) this.reply(request.peer, { id: request.id, error: { code: -32000, message: "Remote executor disconnected; the operation was not replayed." } });
          this.forwarded.clear();
          this.resolveForwardedDrainers();
        });
        const response = await this.upstreamRpc("initialize", { clientName: "ai-tg-bot-lazy-executor", resumeSessionId: null });
        if (response.error) throw new Error(response.error.message);
        const result = response.result as { environmentInfo?: unknown } | undefined;
        if (result?.environmentInfo) this.bootstrap.set(key({ method: "environment/info" }), { result: result.environmentInfo });
        socket.send(JSON.stringify({ method: "initialized", params: {} }));
        this.initialized = true;
        return;
      } catch (error) {
        lastError = error;
        if (this.upstream === socket) this.upstream = undefined;
        socket.terminate();
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); timer.unref(); });
      }
    }
    throw new Error(`Could not connect to the native E2B executor: ${String(lastError ?? "cancelled")}`);
  }

  private onUpstream(socket: WebSocket, data: RawData, binary: boolean): void {
    if (this.upstream !== socket) return;
    // Warm messages pass through without decoding unless the adapter has its
    // own handshake/checkpoint requests outstanding.
    if (this.pending.size > 0) {
      try {
        const response = JSON.parse(data.toString()) as Rpc;
        if (typeof response.id === "string") {
          const pending = this.pending.get(response.id);
          if (pending) { this.pending.delete(response.id); clearTimeout(pending.timeout); pending.resolve(response); return; }
        }
      } catch { /* Forward native messages unchanged. */ }
    }
    const responseId = rpcId(data);
    if (responseId !== undefined) this.forwarded.delete(`${typeof responseId}:${responseId}`);
    this.resolveForwardedDrainers();
    if (this.peer?.readyState === WebSocket.OPEN) this.peer.send(data, { binary });
  }

  private forward(peer: WebSocket, data: RawData, binary: boolean): void {
    const id = rpcId(data);
    // Client replies to executor callbacks have IDs but await no further reply.
    // Inspect just the native request header, preserving the payload verbatim.
    if (id !== undefined && /"method"\s*:/u.test(rpcPrefix(data))) {
      this.operationDispatched = true;
      this.forwarded.set(`${typeof id}:${id}`, { peer, id });
    }
    this.upstream!.send(data, { binary });
  }

  private upstreamRpc(method: string, params?: Record<string, unknown>): Promise<Rpc> {
    const id = `ai-tg-adapter-${++this.nextRpc}`;
    return new Promise<Rpc>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Remote executor RPC timed out: ${method}`)); }, this.input.connectTimeoutMs ?? 30_000);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      if (this.upstream?.readyState !== WebSocket.OPEN) { clearTimeout(timeout); this.pending.delete(id); reject(new Error("Remote executor is disconnected")); return; }
      this.upstream.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    });
  }

  /** Capture startup probes while E2B is already awake, before its idle pause. */
  async refreshBootstrap(): Promise<void> {
    if (!this.ready || !this.initialized || this.upstream?.readyState !== WebSocket.OPEN) return;
    const responses = await Promise.all(bootstrapRequests.map(async request => {
      const response = await this.upstreamRpc(request.method!, request.params);
      return [key(request), { ...(response.error ? { error: response.error } : { result: response.result }) }] as const;
    }));
    for (const [requestKey, response] of responses) this.bootstrap.set(requestKey, response);
    // Cache small startup instruction/config reads only if their metadata says
    // they exist. Attachment reads are never cached on the bot host.
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      const location = fileUrl(`${E2B_WORKSPACE}/${name}`);
      const metadata = this.bootstrap.get(key({ method: "fs/getMetadata", params: { path: location, sandbox: null } }));
      const size = (metadata?.result as { size?: unknown } | undefined)?.size;
      if (metadata?.error || typeof size !== "number" || size > 64 * 1024) continue;
      const request = { method: "fs/readFile", params: { path: location, sandbox: null } };
      const response = await this.upstreamRpc(request.method, request.params);
      this.bootstrap.set(key(request), response.error ? { error: response.error } : { result: response.result });
    }
    await this.persistBootstrap();
  }

  private async loadBootstrap(): Promise<void> {
    if (!this.input.cachePath) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.input.cachePath, "utf8")) as { version?: string; responses?: Array<[string, CachedResponse]> };
      if (parsed.version !== CODEX_EXECUTOR_VERSION || !Array.isArray(parsed.responses)) return;
      for (const [requestKey, response] of parsed.responses) {
        const request = JSON.parse(requestKey) as [string, Record<string, unknown>];
        const allowedInstructionRead = request[0] === "fs/readFile" && ["AGENTS.md", "AGENTS.override.md"].some(name => request[1]?.path === fileUrl(`${E2B_WORKSPACE}/${name}`));
        if (bootstrapKeys.has(requestKey) || allowedInstructionRead) this.bootstrap.set(requestKey, response);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.input.logger?.warn("Could not read Codex executor startup metadata", { error: String(error) });
    }
  }

  private persistBootstrap(): Promise<void> {
    if (!this.input.cachePath) return Promise.resolve();
    const cachePath = this.input.cachePath;
    const payload = JSON.stringify({ version: CODEX_EXECUTOR_VERSION, responses: [...this.bootstrap] });
    this.persistTail = this.persistTail.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      const staging = `${cachePath}.${randomUUID()}.tmp`;
      try { await fs.writeFile(staging, payload, { mode: 0o600 }); await fs.rename(staging, cachePath); }
      finally { await fs.rm(staging, { force: true }); }
    });
    return this.persistTail;
  }

  private reply(peer: WebSocket, response: Rpc): void {
    if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(response));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort(new Error("Codex executor adapter is disposed"));
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("Codex executor adapter is disposed")); }
    this.pending.clear();
    this.upstream?.terminate();
    for (const client of this.gateway.clients) client.terminate();
    await Promise.allSettled([this.preparation, this.persistTail]);
    await new Promise<void>(resolve => { this.gateway.close(() => resolve()); });
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
}

// Native JSON-RPC serializes its request/response ID before the payload. Read
// that small prefix for disconnect accounting; never decode large warm payloads.
function rpcId(data: RawData): string | number | undefined {
  const prefix = rpcPrefix(data);
  const match = /^\s*\{\s*"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+)/u.exec(prefix);
  if (match) {
    try { return JSON.parse(match[1]!) as string | number; } catch { return undefined; }
  }
  // Native error objects may serialize the error before the ID. Only that rare
  // path needs decoding; successful requests and large file replies stay raw.
  if (/^\s*\{\s*"error"\s*:/u.test(prefix)) {
    try { const id = (JSON.parse(data.toString()) as Rpc).id; return typeof id === "number" || typeof id === "string" ? id : undefined; } catch { return undefined; }
  }
  return undefined;
}

function isLocalArtifactOperation(method: string | undefined): method is LocalArtifactOperation {
  return method === "fs/readFile" || method === "fs/getMetadata";
}

function localArtifactOperation(data: RawData): boolean {
  return /"method"\s*:\s*"fs\/(?:readFile|getMetadata)"/u.test(rpcPrefix(data));
}

function rpcPrefix(data: RawData): string {
  const bytes = Array.isArray(data) ? data[0] : data instanceof ArrayBuffer ? Buffer.from(data) : data;
  return bytes?.subarray(0, 256).toString("utf8") ?? "";
}
