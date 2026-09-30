import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import path from "node:path";
import type { Logger } from "../logger.js";
import { asRecord } from "../util/records.js";
import { APP_VERSION } from "../version.js";

export const CODEX_HARNESS_VERSION = "0.159.2";
export interface RpcNotification { method: string; params: Record<string, unknown> }
export interface RpcRequest extends RpcNotification { id: string | number }
export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = "CodexRpcError"; }
}
export interface CodexClient {
  initialize(): Promise<void>;
  request<T = Record<string, unknown>>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  onNotification(listener: (event: RpcNotification) => void): () => void;
  onRequest(handler: (event: RpcRequest) => Promise<unknown>): () => void;
  onDisconnect(listener: () => void): () => void;
  dispose(): Promise<void>;
}

/** One persistent local control connection. Model and executor traffic stay in Codex. */
export class CodexAppServer implements CodexClient {
  private process?: ChildProcessWithoutNullStreams;
  private initialization?: Promise<void>;
  private disposed = false;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private readonly notifications = new Set<(event: RpcNotification) => void>();
  private readonly requests = new Set<(event: RpcRequest) => Promise<unknown>>();
  private readonly disconnects = new Set<() => void>();
  constructor(private readonly input: { home: string; executable?: string; requestTimeoutMs: number; logger: Logger; env?: NodeJS.ProcessEnv }) {}

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Codex app-server is closed."));
    this.initialization ??= this.start().catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  }

  private async start(): Promise<void> {
    const bundled = path.resolve("node_modules/@openai/codex/bin/codex.js");
    const proc = spawn(this.input.executable ?? process.execPath,
      [...(this.input.executable ? [] : [bundled]), "app-server", "--listen", "stdio://", "-c", "features.deferred_executor=true", "-c", "features.unified_exec=true", "-c", "features.shell_snapshot=false", "-c", 'web_search="live"', "-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"'], {
        cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.input.env, CODEX_HOME: this.input.home },
      });
    this.process = proc;
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", line => {
      if (this.process !== proc) return;
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error("Codex app-server returned an invalid protocol message."), proc); }
    });
    // Never log raw stderr: provider diagnostics may contain request payloads or credentials.
    proc.stderr.on("data", () => {});
    proc.stdin.on("error", error => this.fail(error, proc));
    proc.on("error", error => this.fail(error, proc));
    proc.on("exit", (code, signal) => {
      lines.close();
      this.fail(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`), proc);
    });
    await this.sendRequest("initialize", { clientInfo: { name: "ai_tg_bot", title: "Telegram assistant", version: APP_VERSION }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
    this.input.logger.info("Codex app-server ready", { version: CODEX_HARNESS_VERSION });
  }

  async request<T = Record<string, unknown>>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const initializing = this.initialize();
    if (signal) await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new Error("Codex request cancelled."));
      signal.addEventListener("abort", aborted, { once: true });
      initializing.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
    else await initializing;
    return this.sendRequest(method, params, signal) as Promise<T>;
  }

  private sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => { const call = this.pending.get(id); if (call) { this.pending.delete(id); call.cleanup(); reject(signal?.reason ?? new Error("Codex request cancelled.")); } };
      const timeout = setTimeout(() => {
        const call = this.pending.get(id); if (call) { this.pending.delete(id); call.cleanup(); reject(new Error(`Codex ${method} request timed out.`)); }
      }, this.input.requestTimeoutMs);
      timeout.unref();
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  private send(message: unknown): void {
    const proc = this.process;
    if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded) throw new Error("Codex app-server is disconnected.");
    proc.stdin.write(JSON.stringify(message) + "\n", error => { if (error) this.fail(error, proc); });
  }

  private receive(value: unknown): void {
    const message = asRecord(value);
    if (!message) throw new Error("Invalid RPC message.");
    if (typeof message.method === "string") {
      const event = { method: message.method, params: asRecord(message.params) ?? {} };
      if (typeof message.id === "string" || typeof message.id === "number") {
        void this.dispatchRequest({ ...event, id: message.id });
      } else for (const listener of this.notifications) listener(event);
      return;
    }
    if (typeof message.id !== "number") return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id); call.cleanup();
    const error = asRecord(message.error);
    if (error) call.reject(new CodexRpcError(Number(error.code), String(error.message), error.data));
    else call.resolve(message.result);
  }

  private async dispatchRequest(event: RpcRequest): Promise<void> {
    try {
      for (const handler of this.requests) {
        const result = await handler(event);
        if (result !== undefined) { this.send({ id: event.id, result }); return; }
      }
      this.send({ id: event.id, error: { code: -32601, message: "Unsupported client request." } });
    } catch {
      // Tool errors are returned in content by the owning thread. Protocol failures stay opaque.
      try { this.send({ id: event.id, error: { code: -32603, message: "Client request failed." } }); } catch { /* disconnected */ }
    }
  }

  private fail(error: Error, proc: ChildProcessWithoutNullStreams): void {
    if (this.process !== proc) return;
    this.process = undefined; this.initialization = undefined;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const timer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); }, 5_000);
      timer.unref(); proc.once("exit", () => clearTimeout(timer));
    }
    for (const call of this.pending.values()) { call.cleanup(); call.reject(error); }
    this.pending.clear();
    if (!this.disposed) for (const listener of this.disconnects) listener();
  }
  onNotification(listener: (event: RpcNotification) => void): () => void { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest(handler: (event: RpcRequest) => Promise<unknown>): () => void { this.requests.add(handler); return () => { this.requests.delete(handler); }; }
  onDisconnect(listener: () => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }

  async dispose(): Promise<void> {
    this.disposed = true;
    const proc = this.process;
    if (proc) {
      const exited = once(proc, "exit").catch(() => undefined);
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000); timer.unref();
      proc.kill("SIGTERM");
      await exited; clearTimeout(timer);
    }
    this.notifications.clear(); this.requests.clear(); this.disconnects.clear();
  }
}
