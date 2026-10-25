import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Api, GrammyError } from "grammy";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import { messageView } from "../../src/web/message-view.js";
import { workspaceRuntime } from "../helpers/workspaceRuntime.js";
import { deferred } from "../helpers/async.js";
import { asRecord } from "../../src/util/records.js";
import type { TurnDraft, TurnInput } from "../../src/ai/types.js";
import { TurnFinalizer } from "../../src/ai/turnFinalizer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const openui = 'root = Stack([Text("Private response program")])';
const script = 'printf "<report>\\n"\npython report.py --precision 0.000000123456789';
const output = Array.from({ length: 60 }, (_, index) => `measurement ${index}: 0.000000123456789`).join("\n");

describe("website tool activity through real Pi execution and response persistence", () => {
  it.each(["message to edit not found", "message_to_edit_not_found", "Bad Request: message to edit not found"])(
    "replaces a rejected placeholder edit with a final send: %s", async description => {
      const h = await setup([{ name: "finish_response", arguments: { text: "Recovered answer" } }], true);
      let edits = 0;
      h.input.api.config.use((previous, method, payload, signal) => {
        if (method === "editMessageText") {
          edits++;
          throw new GrammyError(description, { ok: false, error_code: 400, description }, method, payload);
        }
        return previous(method, payload, signal);
      });
      const confirmed = vi.fn();
      const unknown = vi.fn();
      await runTurn({ ...h.input, origin: "web", onDeliveryConfirmed: confirmed, onDeliveryUnknown: unknown });
      expect(edits).toBeGreaterThan(0);
      expect(h.sent).toEqual(["Recovered answer"]);
      expect(h.telegramCalls.at(-1)?.method).toBe("deleteMessage");
      expect(confirmed).toHaveBeenCalledOnce();
      expect(unknown).not.toHaveBeenCalled();
      expect(h.drafts).toEqual([]);
    },
  );

  it("does not send a duplicate answer after an ambiguous placeholder edit", async () => {
    const h = await setup([{ name: "finish_response", arguments: { text: "Possibly delivered" } }], true);
    let edits = 0;
    h.input.api.config.use((previous, method, payload, signal) => {
      if (method === "editMessageText") { edits++; throw new Error("ECONNRESET"); }
      return previous(method, payload, signal);
    });
    const unknown = vi.fn();
    await runTurn({ ...h.input, origin: "web", onDeliveryUnknown: unknown });
    expect(edits).toBe(1);
    expect(h.sent).toEqual([]);
    expect(unknown).toHaveBeenCalledOnce();
    expect((await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant")?.text_plain).toBe("Possibly delivered");
  });

  it("shows stopped when durable cancellation wins before delivery, even without an aborted local signal", async () => {
    const h = await setup([{ name: "finish_response", arguments: { text: "Must not deliver" } }], true);
    vi.spyOn(h.repos.turnRuns, "markAwaitingDelivery").mockResolvedValue(false);
    const finalizer = new TurnFinalizer({ repos: h.repos, logger: h.input.logger, turnRunId: 1, threadId: h.thread.id });
    await runTurn({ ...h.input, origin: "web", signal: new AbortController().signal,
      onDeliveryStarting: () => finalizer.beginDelivery(), onAwaitingDelivery: result => finalizer.awaitingDelivery(result),
      onExecutionFailure: async () => finalizer.recordExecutionFailure() });
    expect(finalizer.cancelRequested).toBe(true);
    expect(finalizer.executionFailed).toBe(false);
    expect(h.telegramCalls.map(call => call.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(h.telegramCalls[1]?.payload.text).toBe("🛑 Stopped.");
    expect(h.sent).toEqual([]);
  });

  it.each([false, true])("streams detailed web tools while Telegram uses one static placeholder (stream=%s)", async streaming => {
    const h = await setup([
      { name: "bash", arguments: { script, stdin: "API_KEY=super-private-key" } },
      { name: "finish_response", arguments: { text: "Report ready", openui } },
    ], streaming);
    const started = deferred<void>();
    const release = deferred<void>();
    const execute = h.commandRuntime.execute.getMockImplementation();
    if (!execute) throw new Error("Missing workspace implementation");
    h.commandRuntime.execute.mockImplementation(async request => { started.resolve(); await release.promise; return execute(request); });
    const drafts: TurnDraft[] = [];
    const running = runTurn({ ...h.input, origin: "web", onDraft: value => drafts.push(value) });
    try {
      await started.promise;
      const draft = drafts.at(-1);
      expect(draft?.toolActivity?.calls[0]).toMatchObject({ name: "bash", status: "running" });
      expect(JSON.parse(draft?.toolActivity?.calls[0]?.args?.text ?? "null")).toMatchObject({ script, stdin: "API_KEY=[redacted]" });
      if (!streaming) expect(draft).toMatchObject({ text: "", thinking: "" });
      expect(h.telegramCalls.map(call => call.method)).toEqual(["sendMessage"]);
      expect(h.telegramCalls[0]?.payload.text).toBe("thinking-placeholder");
    } finally { release.resolve(); await running; }
    expect(h.drafts).toEqual([]);
    expect(h.telegramCalls.map(call => call.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(h.telegramCalls[1]?.payload).toMatchObject({ message_id: 1, rich_message: { markdown: "Report ready\n\n🧩 Interactive visualization available on the website." } });
    const completed = drafts.at(-1)?.toolActivity?.calls[0];
    expect(completed?.status).toBe("succeeded");
    expect(completed?.result?.text).toContain("measurement 59");
    expect(JSON.stringify(drafts)).not.toMatch(/super-private-key|unit-provider-credential|Private response program/);
    const assistant = (await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant");
    expect(assistant?.tg_message_id).toBe(1);
    expect(assistant && messageView(assistant, []).toolActivity?.calls[0]?.result).toEqual(completed?.result);
  });

  it("replaces a web thinking placeholder with stopped when cancelled", async () => {
    const h = await setup([{ name: "bash", arguments: { script } }], true);
    const started = deferred<void>();
    h.commandRuntime.execute.mockImplementation(async request => {
      started.resolve();
      await new Promise<void>((_, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }));
      throw new Error("Unexpected completion");
    });
    const controller = new AbortController();
    const running = runTurn({ ...h.input, origin: "web", signal: controller.signal });
    await started.promise;
    controller.abort(new Error("Turn cancelled by user."));
    await running;
    expect(h.telegramCalls.map(call => call.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(h.telegramCalls[1]?.payload).toMatchObject({ message_id: 1, text: "🛑 Stopped." });
    expect(h.drafts).toEqual([]);
  });
  it("keeps raw file decimals and large integers literal through real read execution and persistence", async () => {
    const directory = await fs.mkdtemp(path.resolve("skills/openscad/.tool-precision-"));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const texts = ["0.123456789012345678901234567890", "123.4500", '{ "large": 9007199254740993, "decimal": 123.4500 }'];
    const paths = await Promise.all(texts.map(async (text, index) => {
      const file = path.join(directory, `literal-${index}.txt`);
      await fs.writeFile(file, text);
      return file;
    }));
    const h = await setup([
      ...paths.map(file => ({ name: "read", arguments: { path: file } })),
      { name: "finish_response", arguments: { text: "Read precise values" } },
    ], false);
    await runTurn(h.input);
    const assistant = (await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant");
    if (!assistant) throw new Error("No persisted assistant result");
    const results = texts.map(text => ({ format: "text", text, truncated: false }));
    expect(JSON.parse(assistant.content_json).toolActivity.calls.map((call: { result: unknown }) => call.result)).toEqual(results);
    expect(messageView(assistant, []).toolActivity?.calls.map(call => call.result)).toEqual(results);
  });

  it("persists sanitized codemode source and nested serialized results through the real engine", async () => {
    const code = String.raw`const body = "{\"api_key\":\"invented-code-secret\",\"openui\":\"invented-openui\",\"session_id\":\"invented-session\",\"visible\":0.000000123456789}"; text({stdout:body});`;
    const h = await setup([
      { name: "codemode", arguments: { code } },
      { name: "finish_response", arguments: { text: "Calculated" } },
    ], false);
    await runTurn(h.input);
    const assistant = (await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant");
    if (!assistant) throw new Error("No persisted assistant result");
    expect(assistant.content_json).not.toMatch(/invented-code-secret|invented-openui|invented-session/);
    const activity = messageView(assistant, []).toolActivity;
    expect(activity?.calls).toHaveLength(1);
    expect(activity?.calls[0]?.status).toBe("succeeded");
    const result = JSON.parse(activity?.calls[0]?.result?.text ?? "null");
    expect(JSON.parse(result.stdout)).toEqual({ api_key: "[redacted]", openui: "[details omitted]", session_id: "[details omitted]", visible: 0.000000123456789 });
    expect(JSON.parse(activity?.calls[0]?.args?.text ?? "null").code).toContain(String.raw`\"api_key\":\"[redacted]\"`);
  });

  it("keeps real read and codemode content instead of their execution-only details", async () => {
    const h = await setup([
      { name: "read", arguments: { path: "skills/openscad/SKILL.md", limit: 20 } },
      { name: "codemode", arguments: { code: 'text({rows:[{value:0.000000123456789}], note:"Useful script output"});' } },
      { name: "finish_response", arguments: { text: "Read and calculated" } },
    ], false);
    await runTurn(h.input);
    const assistant = (await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant");
    if (!assistant) throw new Error("No persisted assistant result");
    const activity = messageView(assistant, []).toolActivity;
    expect(activity?.calls.map(call => call.name)).toEqual(["read", "codemode"]);
    expect(activity?.calls[0]?.result?.text).toContain("name: openscad");
    expect(JSON.parse(activity?.calls[1]?.result?.text ?? "null")).toEqual({ rows: [{ value: 0.000000123456789 }], note: "Useful script output" });
    expect(activity?.calls[1]?.status).toBe("succeeded");
    expect(activity?.calls[1]?.result?.text).not.toContain("Wall time");
  });

  it.each([false, true])("retains detailed results with unchanged Telegram summaries (stream=%s)", async streaming => {
    const h = await setup([
      { name: "bash", arguments: { script, cwd: "/", args: ["--report", "precise"], stdin: "API_KEY=super-private-key" } },
      { name: "bash", arguments: { script: "exit 7" } },
      { name: "finish_response", arguments: { text: "Report ready", openui } },
    ], streaming);
    const observed: string[] = [];
    const runtime = await h.pi.runtime(h.thread, h.user);
    const unsubscribe = runtime.session.subscribe(event => { if (event.type.startsWith("tool_execution_")) observed.push(event.type); });
    const inserts: string[] = [];
    const insert = h.repos.messages.insert.bind(h.repos.messages);
    h.repos.messages.insert = async value => { if (value.role === "assistant") inserts.push(JSON.stringify(value.content)); return insert(value); };
    await runTurn({ ...h.input, pi: { runtime: async () => runtime } });
    unsubscribe();
    expect(observed.filter(event => event === "tool_execution_start")).toHaveLength(3);
    expect(observed.filter(event => event === "tool_execution_end")).toHaveLength(3);
    const assistant = (await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant");
    if (!assistant) throw new Error("No persisted assistant result");
    const view = messageView(assistant, []);
    expect(view.text).toBe("Report ready");
    expect(view.toolActivity?.calls.map(call => ({ name: call.name, status: call.status }))).toEqual([
      { name: "bash", status: "succeeded" }, { name: "bash", status: "error" },
    ]);
    const [success, failure] = view.toolActivity?.calls ?? [];
    expect(JSON.parse(success?.args?.text ?? "null")).toMatchObject({ script, cwd: "/", args: ["--report", "precise"], stdin: "API_KEY=[redacted]" });
    expect(JSON.parse(success?.result?.text ?? "null")).toMatchObject({ stdout: `${output}\n[redacted]`, exit_code: 0 });
    expect(success?.result?.text.length).toBeGreaterThan(1800);
    expect(success?.result?.truncated).toBe(false);
    expect(JSON.parse(failure?.result?.text ?? "null")).toMatchObject({ stderr: "Validation failed on row 17", exit_code: 7 });
    expect(JSON.stringify(view.toolActivity)).not.toMatch(/super-private-key|unit-provider-credential|Private response program|finish_response|sandbox-private/);
    expect(inserts).toHaveLength(1);
    expect(JSON.parse(inserts[0]!).toolActivity).toEqual(JSON.parse(assistant.content_json).toolActivity);
    expect(assistant.thinking).toBe('Tool calls: 3\n\n<p>Tools:</p>\n\n- 💻 Running bash: 2\n- 📬 Preparing response: 1');
    expect(h.sent.at(-1)).toBe("Report ready\n\n🧩 Interactive visualization available on the website.");
    expect(h.sent.join("\n")).toContain("Tool calls: 3");
    expect(h.sent.join("\n")).not.toContain("measurement 59");
    expect(h.sent.join("\n")).not.toContain("Private response program");
    expect(h.drafts.join("\n")).not.toContain("Private response program");
    if (streaming) {
      expect(h.drafts.some(text => text.includes("exit 0"))).toBe(true);
      expect(h.drafts.some(text => text.includes("exit 7"))).toBe(true);
    }
  });

  it("persists a cancelled tool with its arguments without adding a Telegram reply", async () => {
    const h = await setup([{ name: "bash", arguments: { script } }], false);
    const started = deferred<void>();
    h.commandRuntime.execute.mockImplementation(async request => {
      started.resolve();
      await new Promise<void>((_, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }));
      throw new Error("Unexpected completion");
    });
    const controller = new AbortController();
    const running = runTurn({ ...h.input, signal: controller.signal });
    await started.promise;
    const sentBeforeCancel = h.sent.length;
    controller.abort(new Error("Turn cancelled by user."));
    await running;
    const assistant = (await h.repos.messages.listThread(h.thread.id)).find(row => row.role === "assistant");
    if (!assistant) throw new Error("Cancelled execution has no persisted activity");
    const activity = messageView(assistant, []).toolActivity;
    expect(activity?.calls).toHaveLength(1);
    expect(activity?.calls[0]).toMatchObject({ name: "bash", status: "cancelled" });
    expect(JSON.parse(activity?.calls[0]?.args?.text ?? "null")).toMatchObject({ script });
    expect(assistant.text_plain).toBe("");
    expect(h.sent).toHaveLength(sentBeforeCancel);
  });
});

async function setup(calls: Array<{ name: string; arguments: JsonObject }>, streaming: boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tool-activity-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "no-auth.json"),
    BROWSER_USE_API_KEY: undefined, OPENROUTER_API_KEY: "unit-provider-credential", LOG_LEVEL: "error" });
  const db = createDatabase(config);
  await db.initialize();
  cleanups.push(() => db.destroy());
  const repos = createRepos(db.db, db.search);
  const storedUser = await repos.users.ensure({ tgId: 91827, firstName: "Test", lang: "en" });
  const user = { ...storedUser, stream_mode: streaming ? 1 : 0 };
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Tool activity", origin: "web" });
  const commandRuntime = workspaceRuntime();
  commandRuntime.execute.mockImplementation(async request => ({ stdout: request.args[1] === "exit 7" ? "" : `${output}\nunit-provider-credential`,
    stderr: request.args[1] === "exit 7" ? "Validation failed on row 17" : "", exitCode: request.args[1] === "exit 7" ? 7 : 0,
    timedOut: false, stdoutTruncated: false, stderrTruncated: false,
    threadFiles: { directory: "/home/user/telegram-files", available: 0, files: [] },
  }));
  const logger = createLogger(config);
  let cycle = 0;
  const pi = new PiRuntimeManager({ config, db, repos, logger, commandRuntime, providerStreams: { openRouter: model => {
    const call = calls[cycle++];
    if (!call) throw new Error("Unexpected extra model cycle");
    const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${cycle}`, ...call }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  } } });
  cleanups.push(() => pi.dispose());
  const sent: string[] = [];
  const drafts: string[] = [];
  const telegramCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api = new Api(config.BOT_TOKEN, { fetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: sent.length + 1 } })) });
  api.config.use(async (previous, method, payload, signal) => {
    telegramCalls.push({ method: String(method), payload: { ...payload } });
    const rich = asRecord(asRecord(payload)?.rich_message);
    const text = typeof rich?.markdown === "string" ? rich.markdown : "";
    if (String(method) === "sendRichMessage") sent.push(text);
    if (String(method) === "sendRichMessageDraft") drafts.push(text);
    return previous(method, payload, signal);
  });
  const t: TurnInput["t"] = (key, params) => {
    switch (key) {
      case "thinking-final-tool-calls": return `Tool calls: ${params?.count}`;
      case "thinking-final-tools": return "Tools:";
      case "thinking-summary-running": return `Thinking for ${params?.time}`;
      case "thinking-summary-final": return `Thought for ${params?.time}`;
      default: return key;
    }
  };
  const input: TurnInput = { config, db, repos, logger, user, thread, api, pi, chatId: user.tg_id, text: "Generate a precise report", t };
  return { input, pi, repos, user, thread, sent, drafts, telegramCalls, commandRuntime };
}
