import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer, CodexRpcError } from "../../src/codex/appServer.js";
import { createLogger } from "../../src/logger.js";

const roots: string[] = [];
const servers: CodexAppServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.dispose()));
  for (const root of roots.splice(0)) {
    // Clean up fixture children even if a failing lifecycle assertion found an orphan.
    const pids = await fs.readFile(path.join(root, "pids"), "utf8").catch(() => "");
    for (const pid of pids.trim().split("\n").filter(Boolean).map(Number)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setup(requestTimeoutMs = 1000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-test-"));
  roots.push(root);
  const executable = path.join(root, "fixture.ts");
  await fs.writeFile(executable, `#!/usr/bin/env bun
import fs from "node:fs";
import { createInterface } from "node:readline";
fs.appendFileSync(process.env.FIXTURE_PIDS, process.pid + "\\n");
const calls = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (!request.method) {
    const original = calls.get(request.id);
    if (original) { calls.delete(request.id); send({id:original,result:request.result ?? request.error}); }
    return;
  }
  if (!request.id) return;
  if (request.method === "initialize") {
    process.stderr.write("fake-provider-secret-never-log\\n");
    send({id:request.id,result:{clientInfo:request.params.clientInfo,capabilities:request.params.capabilities,pid:process.pid}});
  } else if (request.method === "echo") send({id:request.id,result:request.params});
  else if (request.method === "error") send({id:request.id,error:{code:-32001,message:"Fixture error",data:{kind:"fixture"}}});
  else if (request.method === "notify") { send({method:"fixture/event",params:request.params}); send({id:request.id,result:{}}); }
  else if (request.method === "clientRequest") { const id="server-"+request.id; calls.set(id,request.id); send({id,method:"item/tool/call",params:request.params}); }
  else if (request.method === "crash") process.exit(7);
  else if (request.method === "malformed") process.stdout.write("invalid JSON\\n");
  else if (request.method === "malformedThenNotify") process.stdout.write("invalid JSON\\n"+JSON.stringify({method:"fixture/stale",params:{oldProcess:true}})+"\\n");
  else if (request.method === "never") { /* intentionally unresponsive */ }
});
`, { mode: 0o700 });
  const logger = createLogger({ LOG_LEVEL: "error" });
  const server = new CodexAppServer({ home: root, executable, requestTimeoutMs, logger, env: { FIXTURE_PIDS: path.join(root, "pids") } });
  servers.push(server);
  return { server, root, logger };
}

describe("persistent Codex app-server transport", () => {
  it("shares initialization and one process across concurrent RPC calls", async () => {
    const { server, root, logger } = await setup();
    const info = vi.spyOn(logger, "info");
    await Promise.all([server.initialize(), server.initialize(), server.initialize()]);
    expect(await Promise.all([server.request("echo", { value: 1 }), server.request("echo", { value: 2 })])).toEqual([{ value: 1 }, { value: 2 }]);
    expect((await fs.readFile(path.join(root, "pids"), "utf8")).trim().split("\n")).toHaveLength(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain("fake-provider-secret");
  });

  it("dispatches notifications and dynamic tool requests with isolated subscriptions", async () => {
    const { server } = await setup();
    const notify = vi.fn();
    const off = server.onNotification(notify);
    const skip = server.onRequest(async () => undefined);
    const handler = server.onRequest(async event => event.params.tool === "test" ? { contentItems: [{ type: "inputText", text: "Tool result" }], success: true } : undefined);
    await server.request("notify", { threadId: "thread-1" });
    expect(notify).toHaveBeenCalledExactlyOnceWith({ method: "fixture/event", params: { threadId: "thread-1" } });
    off();
    await server.request("notify", {});
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await server.request("clientRequest", { tool: "test" })).toEqual({ contentItems: [{ type: "inputText", text: "Tool result" }], success: true });
    handler(); skip();
    expect(await server.request("clientRequest", { tool: "unknown" })).toEqual({ code: -32601, message: "Unsupported client request." });
  });

  it("propagates structured RPC errors while retaining the connection", async () => {
    const { server } = await setup();
    await expect(server.request("error")).rejects.toBeInstanceOf(CodexRpcError);
    await expect(server.request("error")).rejects.toMatchObject({ code: -32001, message: "Fixture error", data: { kind: "fixture" } });
    expect(await server.request("echo", { stillAlive: true })).toEqual({ stillAlive: true });
  });

  it("cancels individual RPC waits and times out unresponsive calls without losing the process", async () => {
    const { server } = await setup(100);
    await server.initialize();
    const controller = new AbortController();
    const pending = server.request("never", {}, controller.signal);
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Cancelled" });
    await expect(server.request("never")).rejects.toThrow("request timed out");
    expect(await server.request("echo", { recovered: true })).toEqual({ recovered: true });
  });

  it("rejects outstanding calls on disconnect and initializes a replacement process", async () => {
    const { server, root } = await setup();
    const disconnected = vi.fn();
    server.onDisconnect(disconnected);
    await server.initialize();
    const waiting = server.request("never");
    const crashed = server.request("crash");
    await expect(waiting).rejects.toThrow("exited");
    await expect(crashed).rejects.toThrow("exited");
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(await server.request("echo", { replacement: true })).toEqual({ replacement: true });
    expect((await fs.readFile(path.join(root, "pids"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("terminates a child that emits malformed protocol data", async () => {
    const { server, root } = await setup();
    await server.initialize();
    const pid = Number((await fs.readFile(path.join(root, "pids"), "utf8")).trim());
    await expect(server.request("malformed")).rejects.toThrow("invalid protocol message");
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 1000, interval: 20 });
  });

  it("ignores buffered notifications from an already failed process", async () => {
    const { server } = await setup();
    const notified = vi.fn();
    server.onNotification(notified);
    await expect(server.request("malformedThenNotify")).rejects.toThrow("invalid protocol message");
    expect(notified).not.toHaveBeenCalled();
  });

  it("does not start an app-server for a request that was already cancelled", async () => {
    const { server, root } = await setup();
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(server.request("echo", {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(path.join(root, "pids"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disposes the child, rejects pending calls and prevents subsequent restarts", async () => {
    const { server } = await setup();
    await server.initialize();
    const waiting = server.request("never");
    const stopped = server.dispose();
    await expect(waiting).rejects.toThrow();
    await stopped;
    await expect(server.request("echo")).rejects.toThrow("closed");
  });
});
