import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyCodexExecutor } from "../../src/codex/lazyExecutor.js";
import { deferred } from "../helpers/async.js";

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.allSettled(disposals.splice(0).reverse().map(dispose => dispose())); });

async function executor(handler?: (request: Rpc, socket: WebSocket) => boolean) {
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  const received: string[] = [];
  const peers: WebSocket[] = [];
  ws.on("connection", peer => {
    peers.push(peer);
    peer.on("message", raw => {
      received.push(raw.toString());
      const request = JSON.parse(raw.toString()) as Rpc;
      if (handler?.(request, peer) || request.id === undefined) return;
      const result = request.method === "initialize" ? { sessionId: "native-session", environmentInfo: { platformOs: "linux", executorVersion: "0.159.2", cwd: "file:///home/user/workspace" } }
        : request.method === "fs/getMetadata" ? { isDirectory: false, isFile: true, isSymlink: false, size: 10, createdAtMs: 0, modifiedAtMs: 0 }
        : { echoed: request.method };
      peer.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  disposals.push(async () => { for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${address.port}`, received, peers };
}

async function client(adapter: LazyCodexExecutor) {
  const peer = new WebSocket(adapter.url, { headers: { Authorization: `Bearer ${adapter.authBearerToken}` } });
  await new Promise<void>((resolve, reject) => { peer.once("open", resolve); peer.once("error", reject); });
  const pending = new Map<number | string, (response: Rpc) => void>();
  peer.on("message", raw => { const response = JSON.parse(raw.toString()) as Rpc; if (response.id !== undefined) { pending.get(response.id)?.(response); pending.delete(response.id); } });
  disposals.push(async () => peer.terminate());
  return {
    peer,
    rpc(request: Rpc): Promise<Rpc> { return new Promise(resolve => { pending.set(request.id!, resolve); peer.send(JSON.stringify(request)); }); },
    rawRpc(raw: string, id: number): Promise<Rpc> { return new Promise(resolve => { pending.set(id, resolve); peer.send(raw); }); },
  };
}

async function adapter(input: Parameters<typeof LazyCodexExecutor.create>[0]) {
  const instance = await LazyCodexExecutor.create({ connectTimeoutMs: 1_000, ...input });
  disposals.push(() => instance.dispose());
  return instance;
}

describe("lazy native Codex executor", () => {
  it("answers initialization and exact startup probes without creating a sandbox", async () => {
    const prepareExecutor = vi.fn(async () => undefined);
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    expect((await connection.rpc({ id: 1, method: "initialize", params: { clientName: "codex" } })).result).toMatchObject({ environmentInfo: { cwd: "file:///home/user/workspace", executorVersion: "0.159.2" } });
    connection.peer.send(JSON.stringify({ method: "initialized", params: {} }));
    expect((await connection.rpc({ id: 2, method: "environment/info" })).result).toMatchObject({ platformOs: "linux" });
    expect((await connection.rpc({ id: 3, method: "fs/getMetadata", params: { path: "file:///home/user/workspace/.git", sandbox: null } })).error).toMatchObject({ code: -32004 });
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(gateway.hasConnectedExecutor).toBe(false);
  });

  it("serves registered native images for edits and view_image without creating a sandbox or caching bytes", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-images-"));
    disposals.push(() => fs.rm(temp, { recursive: true, force: true }));
    const imagePath = path.join(temp, "generated_images", "image.png");
    const imageUrl = pathToFileURL(imagePath).href;
    await fs.mkdir(path.dirname(imagePath));
    await fs.writeFile(imagePath, Buffer.from("native-image-first"));
    const prepareExecutor = vi.fn(async () => undefined);
    const resolveLocalArtifact = vi.fn(async (fileUrl: string, operation: "fs/readFile" | "fs/getMetadata") => {
      if (fileUrl !== imageUrl) return undefined;
      if (operation === "fs/readFile") return { dataBase64: (await fs.readFile(imagePath)).toString("base64") };
      const stat = await fs.stat(imagePath);
      return { isDirectory: false, isFile: true, isSymlink: false, size: stat.size, createdAtMs: Math.trunc(stat.birthtimeMs), modifiedAtMs: Math.trunc(stat.mtimeMs) };
    });
    const gateway = await adapter({ prepareExecutor, resolveLocalArtifact });
    const connection = await client(gateway);
    await connection.rpc({ id: 1, method: "initialize" });
    connection.peer.send(JSON.stringify({ method: "initialized", params: {} }));
    // Native image generation reads a reference directly; view_image first
    // checks metadata. Both carry the selected environment's sandbox policy.
    const params = { path: imageUrl, followSymlinks: true, sandbox: { cwd: "file:///home/user/workspace", filesystemPolicy: {} } };
    expect((await connection.rpc({ id: 2, method: "fs/readFile", params })).result).toEqual({ dataBase64: Buffer.from("native-image-first").toString("base64") });
    expect((await connection.rpc({ id: 3, method: "fs/getMetadata", params })).result).toMatchObject({ isDirectory: false, isFile: true, isSymlink: false, size: 18 });
    await fs.writeFile(imagePath, Buffer.from("native-image-second"));
    expect((await connection.rpc({ id: 4, method: "fs/readFile", params })).result).toEqual({ dataBase64: Buffer.from("native-image-second").toString("base64") });
    expect(resolveLocalArtifact).toHaveBeenCalledTimes(3);
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(gateway.hasConnectedExecutor).toBe(false);
  });

  it("returns local artifact errors without starting E2B and sends unregistered Telegram paths to E2B", async () => {
    const missing = "file:///private/codex/generated_images/missing.png";
    const resolveLocalArtifact = vi.fn(async (fileUrl: string) => {
      if (fileUrl !== missing) return undefined;
      throw Object.assign(new Error("Native image no longer exists"), { code: "ENOENT" });
    });
    const prepareExecutor = vi.fn(async () => { throw new Error("E2B expected for Telegram files"); });
    const gateway = await adapter({ prepareExecutor, resolveLocalArtifact });
    const connection = await client(gateway);
    expect((await connection.rpc({ id: 1, method: "fs/readFile", params: { path: missing, sandbox: null } })).error).toMatchObject({ code: -32004, message: "Error: Native image no longer exists" });
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect((await connection.rpc({ id: 2, method: "fs/readFile", params: { path: "file:///home/user/telegram-files/photo.png", sandbox: null } })).error).toMatchObject({ message: "Error: E2B expected for Telegram files" });
    expect(prepareExecutor).toHaveBeenCalledOnce();
  });

  it("reads native artifacts through an idle pause and preserves raw forwarding for warm ordinary requests", async () => {
    const imageUrl = "file:///private/codex/generated_images/image.png";
    const native = await executor();
    const prepareExecutor = vi.fn(async (onExecutorReady: Parameters<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>[0]) => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const resolveLocalArtifact = vi.fn(async (fileUrl: string) => fileUrl === imageUrl ? { dataBase64: "aW1hZ2U=" } : undefined);
    const gateway = await adapter({ prepareExecutor, resolveLocalArtifact });
    const connection = await client(gateway);
    await connection.rpc({ id: 1, method: "process/start" });
    const raw = `{ "id" : 2, "method" : "process/start", "params" : {"command":${JSON.stringify("a".repeat(512 * 1024))}} }`;
    await connection.rawRpc(raw, 2);
    expect(native.received.at(-1)).toBe(raw);
    expect(resolveLocalArtifact).not.toHaveBeenCalled();
    const receivedBeforeImage = native.received.length;
    expect((await connection.rpc({ id: 3, method: "fs/readFile", params: { path: imageUrl } })).result).toEqual({ dataBase64: "aW1hZ2U=" });
    expect(native.received).toHaveLength(receivedBeforeImage);
    const remoteRead = '{ "id" : 4, "method" : "fs/readFile", "params" : {"path":"file:///home/user/workspace/output.png"} }';
    await connection.rawRpc(remoteRead, 4);
    expect(native.received.at(-1)).toBe(remoteRead);
    native.peers[0]!.terminate();
    await vi.waitFor(() => expect(gateway.hasConnectedExecutor).toBe(false));
    expect((await connection.rpc({ id: 5, method: "fs/readFile", params: { path: imageUrl } })).result).toEqual({ dataBase64: "aW1hZ2U=" });
    expect(prepareExecutor).toHaveBeenCalledOnce();
    expect(connection.peer.readyState).toBe(WebSocket.OPEN);
    await connection.rpc({ id: 6, method: "process/start" });
    expect(prepareExecutor).toHaveBeenCalledTimes(2);
  });

  it("initializes the socket while restoration runs, then releases concurrent operations together", async () => {
    const native = await executor();
    const restored = deferred<void>();
    const handshake = deferred<void>();
    const prepareExecutor = vi.fn(async (onExecutorReady: Parameters<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>[0]) => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
      handshake.resolve();
      await restored.promise;
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    const command = connection.rpc({ id: 1, method: "process/start", params: { command: "cat /home/user/telegram-files/document.txt" } });
    const read = connection.rpc({ id: 2, method: "fs/readFile", params: { path: "file:///home/user/workspace/output.txt", sandbox: null } });
    await handshake.promise;
    await vi.waitFor(() => expect(native.received.map(raw => JSON.parse(raw).method)).toEqual(["initialize", "initialized"]));
    expect(prepareExecutor).toHaveBeenCalledOnce();
    restored.resolve();
    expect((await command).result).toEqual({ echoed: "process/start" });
    expect((await read).result).toEqual({ echoed: "fs/readFile" });
    expect(gateway.hasConnectedExecutor).toBe(true);
    const raw = '{ "id" : 3, "method" : "fs/readFile", "params" : {"path":"file:///home/user/workspace/out"} }';
    await connection.rawRpc(raw, 3);
    expect(native.received.at(-1)).toBe(raw);
    expect(prepareExecutor).toHaveBeenCalledOnce();
  });

  it("never treats arbitrary filesystem probes as cached startup responses", async () => {
    const prepareExecutor = vi.fn(async () => { throw new Error("Unavailable sandbox"); });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    const response = await connection.rpc({ id: 1, method: "fs/getMetadata", params: { path: "file:///home/user/workspace/private/.git", sandbox: null } });
    expect(prepareExecutor).toHaveBeenCalledOnce();
    expect(response.error).toMatchObject({ message: "Error: Unavailable sandbox" });
  });

  it("restores a changed file manifest without reopening the persistent socket", async () => {
    const native = await executor();
    const prepareExecutor = vi.fn(async (onExecutorReady: Parameters<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>[0]) => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    await connection.rpc({ id: 1, method: "process/start" });
    gateway.invalidateFiles();
    await connection.rpc({ id: 2, method: "process/start" });
    expect(prepareExecutor).toHaveBeenCalledTimes(2);
    expect(native.received.filter(raw => JSON.parse(raw).method === "initialize")).toHaveLength(1);
  });

  it("forbids mid-turn rotation after a native process starts even when its start RPC already replied", async () => {
    const native = await executor();
    const prepareExecutor = vi.fn<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>(async onExecutorReady => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    gateway.beginTurn();
    await connection.rpc({ id: 1, method: "process/start" });
    expect(prepareExecutor.mock.calls[0]?.[2]).toEqual({ allowRotation: true });
    gateway.invalidateFiles();
    await connection.rpc({ id: 2, method: "fs/readFile", params: { path: "file:///home/user/workspace/new-artifact.png" } });
    expect(prepareExecutor.mock.calls[1]?.[2]).toEqual({ allowRotation: false });
    gateway.beginTurn();
    gateway.invalidateFiles();
    await connection.rpc({ id: 3, method: "process/start" });
    expect(prepareExecutor.mock.calls[2]?.[2]).toEqual({ allowRotation: true });
    expect(native.received.filter(raw => JSON.parse(raw).method === "initialize")).toHaveLength(1);
  });

  it("waits for outstanding native replies before beginning a new turn's rotation boundary", async () => {
    const running = deferred<void>();
    const native = await executor(request => {
      if (request.method === "process/start" && request.id === 1) {
        running.resolve();
        return true;
      }
      return false;
    });
    const prepareExecutor = vi.fn<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>(async onExecutorReady => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    const previous = connection.rpc({ id: 1, method: "process/start" });
    await running.promise;
    gateway.beginTurn();
    gateway.invalidateFiles();
    const next = connection.rpc({ id: 2, method: "process/start" });
    await new Promise(resolve => setImmediate(resolve));
    expect(prepareExecutor).toHaveBeenCalledOnce();
    native.peers[0]!.send(JSON.stringify({ id: 1, result: { processId: "previous" } }));
    await previous;
    expect((await next).result).toEqual({ echoed: "process/start" });
    expect(prepareExecutor).toHaveBeenCalledTimes(2);
    expect(prepareExecutor.mock.calls[1]?.[2]).toEqual({ allowRotation: true });
  });

  it("does not mistake client replies to executor callbacks for outstanding native operations", async () => {
    const acknowledged = deferred<void>();
    const native = await executor(request => {
      if (request.id === -7 && request.method === undefined) { acknowledged.resolve(); return true; }
      return false;
    });
    const prepareExecutor = vi.fn(async (onExecutorReady: Parameters<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>[0]) => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    connection.peer.on("message", raw => {
      const request = JSON.parse(raw.toString()) as Rpc;
      if (request.id === -7 && request.method === "networkProxy/decide") connection.peer.send(JSON.stringify({ id: -7, result: { decision: "allow" } }));
    });
    await connection.rpc({ id: 1, method: "process/start" });
    native.peers[0]!.send(JSON.stringify({ id: -7, method: "networkProxy/decide", params: {} }));
    await acknowledged.promise;
    gateway.beginTurn();
    gateway.invalidateFiles();
    expect((await connection.rpc({ id: 2, method: "process/start" })).result).toEqual({ echoed: "process/start" });
    expect(prepareExecutor).toHaveBeenCalledTimes(2);
  });

  it("keeps the virtual connection open across an idle pause and resumes on the next operation", async () => {
    const native = await executor();
    const prepareExecutor = vi.fn(async (onExecutorReady: Parameters<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>[0]) => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    await connection.rpc({ id: 1, method: "process/start" });
    native.peers[0]!.terminate();
    await vi.waitFor(() => expect(gateway.hasConnectedExecutor).toBe(false));
    expect(connection.peer.readyState).toBe(WebSocket.OPEN);
    const metadata = await connection.rpc({ id: 2, method: "environment/info" });
    expect(metadata.result).toBeTruthy();
    expect(prepareExecutor).toHaveBeenCalledOnce();
    await connection.rpc({ id: 3, method: "process/start" });
    expect(prepareExecutor).toHaveBeenCalledTimes(2);
  });

  it("fails a command already sent when the executor disappears and never replays it", async () => {
    const native = await executor((request, peer) => {
      if (request.method === "process/start") { peer.terminate(); return true; }
      return false;
    });
    const prepareExecutor = vi.fn(async (onExecutorReady: Parameters<Parameters<typeof LazyCodexExecutor.create>[0]["prepareExecutor"]>[0]) => {
      await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" });
    });
    const gateway = await adapter({ prepareExecutor });
    const connection = await client(gateway);
    const response = await connection.rpc({ id: 1, method: "process/start", params: { command: "side effect" } });
    expect(response.error).toMatchObject({ message: expect.stringContaining("not replayed") });
    expect(native.received.filter(raw => JSON.parse(raw).method === "process/start")).toHaveLength(1);
    expect(prepareExecutor).toHaveBeenCalledOnce();
  });

  it("records actual startup metadata and restores that metadata after a bot restart", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-executor-cache-"));
    disposals.push(() => fs.rm(temp, { recursive: true, force: true }));
    const cachePath = path.join(temp, "startup.json");
    const native = await executor((request, peer) => {
      if (request.method === "fs/getMetadata" && String(request.params?.path).endsWith("AGENTS.override.md")) { peer.send(JSON.stringify({ id: request.id, error: { code: -32004, message: "missing" } })); return true; }
      return false;
    });
    const first = await adapter({ cachePath, prepareExecutor: async onExecutorReady => { await onExecutorReady({ sandboxId: "sandbox-1", url: native.url, authBearerToken: "native-secret" }); } });
    const connection = await client(first);
    await connection.rpc({ id: 1, method: "process/start" });
    await first.refreshBootstrap();
    const prepareExecutor = vi.fn(async () => undefined);
    const second = await adapter({ cachePath, prepareExecutor });
    const resumed = await client(second);
    const response = await resumed.rpc({ id: 1, method: "fs/getMetadata", params: { path: "file:///home/user/workspace/AGENTS.md", sandbox: null } });
    expect(response.result).toMatchObject({ isFile: true });
    expect(prepareExecutor).not.toHaveBeenCalled();
    const cache = await fs.readFile(cachePath, "utf8");
    expect(cache).not.toContain("native-secret");
    expect(cache).not.toContain("telegram-files");
  });

  it("rejects clients that do not have the local adapter token", async () => {
    const gateway = await adapter({ prepareExecutor: vi.fn(async () => undefined) });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(gateway.url.replace("ws:", "http:"), { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "YWJjZGVmZ2hpamtsbW5vcA==" } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end();
    });
    expect(status).toBe(401);
  });
});
