import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import {
  emptyModelUsage,
  type AgentMessage,
  type AgentSession,
  type AgentSessionEvent,
  type AssistantMessage,
  type ModelUsage,
  type SessionEntry,
} from "../ai/runtime.js";
import type { CodexClient, RpcNotification, RpcRequest } from "./appServer.js";
import type { ThreadBridge } from "./threadBridge.js";
import { dynamicToolSpecs, executeBotTool, type ToolResult } from "./tools.js";
import { OpenRouterError, runOpenRouterTurn, type OpenRouterMessage, type OpenRouterToolCall, type OpenRouterUsage } from "./openrouter.js";
import { asRecord, safeJson } from "../util/records.js";
import { NATIVE_WORKSPACE_GUIDANCE, renderSystemPrompt } from "../ai/prompt.js";

interface Deferred { promise: Promise<void>; resolve(): void; reject(error: unknown): void }
interface ActiveTurn {
  controller: AbortController;
  userEntry: Extract<SessionEntry, { type: "message" }>;
  done: Deferred;
  threadId?: string;
  turnId?: string;
  provider: "codex" | "openrouter";
  activity: boolean;
  finished: boolean;
  text: string;
  finalText?: string;
  cycleText: string;
  reasoning: string;
  cycleReasoning: string;
  reasoningStarted: boolean;
  usage: ModelUsage;
  baseline?: ModelUsage;
  rawUsage: boolean;
  rawResponseIds: Set<string>;
  completedResponses: number;
  toolResponseCycles: Map<string, number>;
  tokenUsageUpdates: number;
  toolUsageVersions: Map<string, number>;
  responseWaiters: Set<() => void>;
  observedModelCycles: number;
  aggregateUsageTotals: Set<string>;
  budgetTerminated?: boolean;
  assistantEntries: Array<Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage }>;
  toolStarts: Set<string>;
  toolEnds: Set<string>;
  pendingTools: Set<Promise<unknown>>;
  terminalResult?: Extract<AgentMessage, { role: "toolResult" }>;
  terminalAckReady?: boolean;
  terminalInterruptTimer?: NodeJS.Timeout;
  error?: unknown;
}

export interface CodexSessionInput {
  client: CodexClient;
  bridge: ThreadBridge;
  config: AppConfig;
  ensureThread: () => Promise<string>;
  chooseCodex: () => Promise<boolean>;
  codexSucceeded: () => void;
  codexUnavailable: (error: unknown) => boolean;
  getFallbackHistory?: () => Promise<OpenRouterMessage[]>;
  onArtifact?: (filePath: string) => void;
  onTurnFinished?: (threadId: string) => Promise<void>;
  onDelivery?: (messageId: number) => Promise<void>;
  onNativeHistoryUncertain?: () => void;
  /** Public resume does not re-enable the experimental per-response events. */
  nativeRawEventsEnabled?: () => boolean;
  runFallback?: typeof runOpenRouterTurn;
}

/** Converts native Codex events into the bot's existing delivery event contract. */
export class CodexSession implements AgentSession {
  private readonly entries: SessionEntry[] = [];
  private lifetimeUsage = emptyModelUsage();
  private lifetimeMessages = 0;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly unsubscribers: Array<() => void>;
  private active?: ActiveTurn;
  private threadId?: string;
  private totalUsage?: ModelUsage;
  private lastProvider: "codex" | "openrouter" = "codex";
  private disposed = false;
  readonly sessionManager = { getEntries: (): SessionEntry[] => [...this.entries] };

  constructor(private readonly input: CodexSessionInput) {
    this.unsubscribers = [
      input.client.onNotification(event => this.notification(event)),
      input.client.onRequest(event => this.clientRequest(event)),
      input.client.onDisconnect(() => this.active?.done.reject(new Error("Codex app-server disconnected."))),
    ];
  }

  get sessionId(): string { return this.threadId ?? `pending:${this.input.bridge.thread.id}`; }
  get model(): { id: string } { return { id: this.lastProvider === "codex" ? this.input.config.CODEX_MODEL : this.input.config.OPENROUTER_MAIN_MODEL }; }
  get isStreaming(): boolean { return this.active !== undefined; }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("Codex session is closed.");
    if (this.active) throw new Error("A turn is already running in this conversation.");
    this.retireEntries();
    const controller = new AbortController();
    const userEntry = { type: "message" as const, id: `pending:${randomUUID()}`, message: { role: "user" as const, content: text, timestamp: Date.now() } };
    const active: ActiveTurn = {
      controller, userEntry, done: deferred(), provider: "codex", activity: false, finished: false,
      text: "", cycleText: "", reasoning: "", cycleReasoning: "", reasoningStarted: false,
      usage: emptyModelUsage(), rawUsage: false, rawResponseIds: new Set(), completedResponses: 0,
      toolResponseCycles: new Map(), tokenUsageUpdates: 0, toolUsageVersions: new Map(), responseWaiters: new Set(), assistantEntries: [],
      observedModelCycles: 1, aggregateUsageTotals: new Set(),
      toolStarts: new Set(), toolEnds: new Set(), pendingTools: new Set(),
    };
    this.active = active;
    this.entries.push(userEntry);
    this.emit({ type: "turn_start" });
    const timeoutMs = this.input.config.CODEX_TURN_TIMEOUT_MS ?? this.input.config.PI_TURN_TIMEOUT_MS;
    const timeout = timeoutMs > 0 ? setTimeout(() => { void this.abort(new Error(`Agent turn timed out after ${timeoutMs} ms.`)); }, timeoutMs) : undefined;
    timeout?.unref();
    try {
      const content = await this.userContent(text, controller.signal);
      if (await this.input.chooseCodex()) {
        try {
          await this.runNative(active, content);
          this.input.codexSucceeded();
          this.lastProvider = "codex";
          if (active.threadId) await this.input.onTurnFinished?.(active.threadId);
          return;
        } catch (error) {
          active.error = error;
          controller.signal.throwIfAborted();
          const unavailable = this.input.codexUnavailable(error);
          if (!unavailable || active.activity || active.terminalResult) throw error;
          // Remove the failed user turn before appending its fallback equivalent later.
          if (active.threadId) {
            if (active.turnId) {
              try { await this.input.client.request("thread/rollback", { threadId: active.threadId, numTurns: 1 }); }
              catch { this.input.onNativeHistoryUncertain?.(); }
            } else this.input.onNativeHistoryUncertain?.();
          }
          this.finalizeAssistant(active, error);
          active.error = undefined;
          active.finished = false;
          active.done = deferred();
          active.assistantEntries = [];
          active.text = ""; active.cycleText = ""; active.reasoning = ""; active.cycleReasoning = "";
          active.usage = emptyModelUsage(); active.rawUsage = false;
        }
      }
      active.provider = "openrouter";
      active.userEntry.id = `openrouter:${randomUUID()}`;
      this.lastProvider = "openrouter";
      await this.runFallback(active, content);
    } catch (error) {
      active.error = error;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (active.terminalInterruptTimer) clearTimeout(active.terminalInterruptTimer);
      await Promise.allSettled([...active.pendingTools]);
      this.finalizeAssistant(active, active.error);
      if (active.terminalResult) this.append(active, active.terminalResult);
      if (active.reasoningStarted) this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
      this.active = undefined;
    }
  }

  private async userContent(text: string, signal: AbortSignal): Promise<Array<{ type: "text"; text: string; textElements: unknown[] } | { type: "image"; url: string }>> {
    const context = this.input.bridge.currentTurnSessionContext();
    const content: Array<{ type: "text"; text: string; textElements: unknown[] } | { type: "image"; url: string }> = [{ type: "text", text: context ? `${context}\n\n${text}` : text, textElements: [] }];
    const ids = [...this.input.bridge.selectedContextFileIds()];
    for (const file of ids.length ? await this.input.bridge.repos.files.listByIds(ids) : []) {
      if (file.type !== "image") continue;
      const image = await this.input.bridge.resolveImage(file, signal);
      content.push({ type: "image", url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` });
    }
    return content;
  }

  private async runNative(active: ActiveTurn, content: Awaited<ReturnType<CodexSession["userContent"]>>): Promise<void> {
    const threadId = await this.input.ensureThread();
    active.controller.signal.throwIfAborted();
    if (threadId !== this.threadId) this.totalUsage = undefined;
    this.threadId = threadId;
    active.threadId = threadId;
    active.baseline = this.totalUsage;
    if (this.input.bridge.currentTurnBudget()?.beforeModelCycle() === false) throw new Error("The model-cycle limit was reached.");
    const response = await this.input.client.request<{ turn: { id: string } }>("turn/start", {
      threadId, input: content.map((part, index) => index === 0 && part.type === "text"
        ? { ...part, text: `${NATIVE_WORKSPACE_GUIDANCE}\n\n${part.text}` } : part), model: this.input.config.CODEX_MODEL,
      effort: nativeEffort(this.input.config.CODEX_THINKING_LEVEL ?? this.input.config.PI_THINKING_LEVEL),
      serviceTier: this.input.config.CODEX_FAST_MODE ? "priority" : null,
      environments: [{ environmentId: `telegram:${this.input.bridge.user.tg_id}:${this.input.bridge.thread.id}`, cwd: "/home/user/workspace" }],
      approvalPolicy: "never",
    }, active.controller.signal);
    this.setTurnId(active, response.turn.id);
    await active.done.promise;
    await Promise.allSettled([...active.pendingTools]);
    if (!active.budgetTerminated) active.controller.signal.throwIfAborted();
  }

  private notification(event: RpcNotification): void {
    const active = this.active;
    if (!active || active.provider !== "codex" || !active.threadId || event.params.threadId !== active.threadId) return;
    const params = event.params;
    const turn = asRecord(params.turn);
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : undefined;
    // Resume can replay the previous turn's totals before turn/start returns.
    if (event.method === "thread/tokenUsage/updated" && !active.turnId) return;
    if (eventTurnId && active.turnId && eventTurnId !== active.turnId) return;
    if (eventTurnId && !active.turnId) this.setTurnId(active, eventTurnId);
    try {
      if (event.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        active.activity ||= params.delta.length > 0;
        active.text += params.delta; active.cycleText += params.delta;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: params.delta } });
      } else if ((event.method === "item/reasoning/summaryTextDelta" || event.method === "item/reasoning/textDelta") && typeof params.delta === "string") {
        if (!active.reasoningStarted) { active.reasoningStarted = true; this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }); }
        active.reasoning += params.delta; active.cycleReasoning += params.delta;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: params.delta } });
      } else if (event.method === "thread/tokenUsage/updated") {
        const usage = asRecord(params.tokenUsage);
        const total = nativeUsage(asRecord(usage?.total));
        const last = nativeUsage(asRecord(usage?.last));
        active.baseline ??= subtractUsage(total, last);
        this.totalUsage = total;
        if (!active.rawUsage) active.usage = subtractUsage(total, active.baseline);
        active.tokenUsageUpdates++;
        for (const waiter of active.responseWaiters) waiter();
        this.interruptAfterTerminalUsage(active);
        if (this.input.nativeRawEventsEnabled?.() === false) {
          active.aggregateUsageTotals.add(`${total.input}:${total.output}:${total.cacheRead}:${total.cacheWrite}`);
          this.observeModelCycles(active, active.aggregateUsageTotals.size);
        }
      } else if (event.method === "rawResponse/completed") {
        const id = typeof params.responseId === "string" ? params.responseId : randomUUID();
        if (active.rawResponseIds.has(id)) return;
        active.rawResponseIds.add(id); active.completedResponses++;
        if (asRecord(params.usage)) {
          active.rawUsage = true;
          const usage = nativeUsage(asRecord(params.usage));
          active.usage = addUsage(active.assistantEntries.reduce((sum, entry) => addUsage(sum, entry.message.usage), emptyModelUsage()), usage);
          this.recordAssistant(active, active.cycleText, usage);
          active.cycleText = ""; active.cycleReasoning = "";
        }
        for (const waiter of active.responseWaiters) waiter();
        this.interruptAfterTerminalUsage(active);
        this.emit({ type: "turn_start" });
        this.observeModelCycles(active, active.rawResponseIds.size);
      } else if (event.method === "rawResponseItem/completed") {
        const item = asRecord(params.item);
        if (item?.type === "function_call" && typeof item.call_id === "string") {
          active.toolResponseCycles.set(item.call_id, active.completedResponses);
          active.toolUsageVersions.set(item.call_id, active.tokenUsageUpdates);
        }
      } else if (event.method === "item/started" || event.method === "item/completed") {
        this.nativeItem(active, asRecord(params.item), event.method === "item/completed");
      } else if (event.method === "error") {
        if (params.willRetry !== true) active.error = nativeError(asRecord(params.error) ?? params);
      } else if (event.method === "turn/completed") {
        active.finished = true;
        for (const waiter of active.responseWaiters) waiter();
        if ((active.terminalResult || active.budgetTerminated) && turn?.status === "interrupted") active.done.resolve();
        else if (turn?.status === "failed") active.done.reject(nativeError(asRecord(turn.error) ?? asRecord(active.error) ?? {}));
        else if (turn?.status === "interrupted") active.done.reject(active.controller.signal.reason ?? new Error("Codex turn interrupted."));
        else active.done.resolve();
      }
    } catch (error) { active.error = error; active.done.reject(error); }
  }

  private nativeItem(active: ActiveTurn, item: Record<string, unknown> | undefined, completed: boolean): void {
    if (!item || typeof item.type !== "string") return;
    if (item.type === "agentMessage") {
      if (completed && typeof item.text === "string") {
        active.activity ||= item.text.length > 0;
        if (item.phase === "final_answer" || active.finalText === undefined) active.finalText = item.text;
        if (!active.text && item.text) {
          active.text = item.text; active.cycleText = item.text;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: item.text } });
        }
      }
      return;
    }
    if (item.type === "reasoning" && completed && !active.reasoning && Array.isArray(item.summary)) {
      const summary = item.summary.filter((part): part is string => typeof part === "string").join("\n");
      if (summary) {
        active.reasoningStarted = true; active.reasoning = summary; active.cycleReasoning = summary;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: summary } });
      }
      return;
    }
    if (item.type === "dynamicToolCall") {
      if (!completed && typeof item.id === "string" && !active.toolResponseCycles.has(item.id)) {
        active.toolResponseCycles.set(item.id, active.completedResponses);
        active.toolUsageVersions.set(item.id, active.tokenUsageUpdates);
      }
      return;
    }
    const names: Record<string, string> = { commandExecution: "bash", fileChange: "apply_patch", webSearch: "web_search", imageView: "inspect_workspace_images", imageGeneration: "generate_image", mcpToolCall: String(item.tool ?? "mcp_tool") };
    const name = names[item.type];
    if (!name || typeof item.id !== "string") return;
    if (completed && active.toolEnds.has(item.id)) return;
    if (["commandExecution", "fileChange", "imageView"].includes(item.type)) this.input.bridge.holdCommandActivity(true);
    const args = item.type === "commandExecution" ? { command: item.command, cwd: item.cwd } : item;
    if (!completed) {
      const fresh = !active.toolStarts.has(item.id);
      this.toolStart(active, item.id, name, args);
      if (fresh && this.input.bridge.currentTurnBudget()?.beforeToolCall(item.id, name, args).block) this.terminateBudget(active);
    }
    else {
      if (!active.toolStarts.has(item.id)) {
        this.toolStart(active, item.id, name, args);
        this.input.bridge.currentTurnBudget()?.beforeToolCall(item.id, name, args);
      }
      if (item.type === "imageGeneration" && typeof item.savedPath === "string") {
        this.input.bridge.registerNativeArtifact(item.savedPath);
        this.input.onArtifact?.(item.savedPath);
      }
      const isError = item.status === "failed" || item.status === "declined" || item.error != null || typeof item.exitCode === "number" && item.exitCode !== 0;
      const details = item.type === "imageGeneration" ? { generated_image: !isError, status: item.status, savedPath: item.savedPath, failure: item.failure } : item;
      this.toolEnd(active, item.id, name, { content: [{ type: "text", text: safeJson(details) }], details, isError });
      if (this.input.bridge.currentTurnBudget()?.afterToolResult(item.id, isError)) this.terminateBudget(active);
    }
  }

  private observeModelCycles(active: ActiveTurn, count: number): void {
    while (!active.budgetTerminated && active.observedModelCycles < count) {
      active.observedModelCycles++;
      const allowed = this.input.bridge.currentTurnBudget()?.beforeModelCycle();
      if (allowed === false || this.input.config.PI_MAX_MODEL_CYCLES > 0 && active.observedModelCycles > this.input.config.PI_MAX_MODEL_CYCLES) this.terminateBudget(active);
    }
  }

  private terminateBudget(active: ActiveTurn): void {
    if (active.budgetTerminated) return;
    active.budgetTerminated = true;
    // A successful terminal result already owns acknowledgement and interruption.
    if (active.terminalResult) return;
    active.controller.abort(new Error("The turn's inference budget was reached."));
    void this.interrupt(active);
  }

  private async clientRequest(event: RpcRequest): Promise<unknown> {
    const active = this.active;
    if (!active || active.provider !== "codex" || event.params.threadId !== active.threadId) return undefined;
    if (event.method !== "item/tool/call") return undefined;
    if (active.turnId && event.params.turnId !== active.turnId) return undefined;
    const name = String(event.params.tool ?? "");
    const id = String(event.params.callId ?? "");
    const args = event.params.arguments;
    const operation = this.executeTool(active, name, args, id);
    active.pendingTools.add(operation);
    try {
      const result = await operation;
      if (result.completed && !result.isError) {
        if (this.input.nativeRawEventsEnabled?.() !== false) {
          // Dynamic tools can finish before their streamed model response. Hold
          // the result until exact usage arrives, preventing another model cycle.
          await this.waitForModelResponse(active, id);
          // The app-server sends this RPC response before this timer runs.
          setTimeout(() => { if (this.active === active && !active.finished) void this.interrupt(active); }, 0);
        } else {
          // Resume emits aggregate usage only after pending tool responses are
          // drained. Acknowledge first, then interrupt on that usage notification.
          active.terminalAckReady = true;
          active.terminalInterruptTimer = setTimeout(() => { if (this.active === active && !active.finished) void this.interrupt(active); }, 5_000);
          active.terminalInterruptTimer.unref();
        }
      }
      return { contentItems: result.content.map(part => part.type === "text" ? { type: "inputText", text: part.text } : { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` }), success: !result.isError };
    } finally { active.pendingTools.delete(operation); }
  }

  private interruptAfterTerminalUsage(active: ActiveTurn): void {
    if (!active.terminalAckReady || !active.terminalResult || active.finished) return;
    active.terminalAckReady = false;
    if (active.terminalInterruptTimer) clearTimeout(active.terminalInterruptTimer);
    void this.interrupt(active);
  }

  private async waitForModelResponse(active: ActiveTurn, callId: string): Promise<void> {
    const cycle = active.toolResponseCycles.get(callId) ?? Math.max(0, active.completedResponses - 1);
    const usageVersion = active.toolUsageVersions.get(callId) ?? Math.max(0, active.tokenUsageUpdates - 1);
    const responseReady = () => active.completedResponses > cycle || active.tokenUsageUpdates > usageVersion || active.finished || active.controller.signal.aborted;
    if (responseReady()) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        if (!responseReady()) return;
        cleanup(); resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout); active.responseWaiters.delete(finish);
        active.controller.signal.removeEventListener("abort", finish);
      };
      // A malformed stream must not keep Telegram delivery pending indefinitely.
      const timeout = setTimeout(() => { cleanup(); resolve(); }, Math.min(5_000, this.input.config.CODEX_REQUEST_TIMEOUT_MS));
      timeout.unref();
      active.responseWaiters.add(finish);
      active.controller.signal.addEventListener("abort", finish, { once: true });
      finish();
    });
  }

  private async executeTool(active: ActiveTurn, name: string, args: unknown, id: string): Promise<ToolResult> {
    this.toolStart(active, id, name, args);
    let result: ToolResult;
    const decision = this.input.bridge.currentTurnBudget()?.beforeToolCall(id, name, args);
    try {
      // Let requests in one incoming batch register before admitting its terminal call.
      await Promise.resolve();
      if (active.terminalResult) throw new Error("The response is already complete; no further tools may run.");
      if (name === "finish_response" && active.pendingTools.size > 1) throw new Error("finish_response must be the sole tool call. Finish other work first.");
      if (decision?.block) throw new Error(decision.reason);
      result = await executeBotTool(this.input.bridge, name, args, id, active.controller.signal);
    } catch (error) {
      result = { content: [{ type: "text", text: safeJson({ error: error instanceof Error ? error.message : String(error) }) }], details: { error: error instanceof Error ? error.message : String(error) }, isError: true };
    }
    this.toolEnd(active, id, name, result);
    if (decision?.terminate || this.input.bridge.currentTurnBudget()?.afterToolResult(id, result.isError)) {
      setTimeout(() => { if (this.active === active && !active.finished) {
        if (active.provider === "codex") this.terminateBudget(active);
        else void this.abort(new Error("The turn's tool budget was reached."));
      } }, 10);
    }
    return result;
  }

  private toolStart(active: ActiveTurn, id: string, name: string, args: unknown): void {
    if (active.toolStarts.has(id)) return;
    active.toolStarts.add(id); active.activity = true;
    this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
  }

  private toolEnd(active: ActiveTurn, id: string, name: string, result: ToolResult): void {
    if (active.toolEnds.has(id)) return;
    active.toolEnds.add(id);
    const message: Extract<AgentMessage, { role: "toolResult" }> = { role: "toolResult", toolCallId: id, toolName: name, content: result.content, details: result.details, isError: result.isError, timestamp: Date.now() };
    if (name === "finish_response" && result.completed && !result.isError) active.terminalResult = message;
    else this.append(active, message);
    this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: result.isError });
  }

  private async runFallback(active: ActiveTurn, content: Awaited<ReturnType<CodexSession["userContent"]>>): Promise<void> {
    const history = await this.input.getFallbackHistory?.() ?? [];
    const systemPrompt = await renderSystemPrompt({ user: this.input.bridge.user, config: this.input.config, harness: "openrouter" });
    const specs = dynamicToolSpecs(this.input.bridge, true);
    const lastText = { value: "" };
    let reportedCalls = 0;
    const trackUsage = (usage: OpenRouterUsage) => {
      for (const call of usage.calls.slice(reportedCalls)) {
        const normalized = emptyModelUsage();
        normalized.input = call.inputTokens; normalized.output = call.outputTokens; normalized.cacheRead = call.cacheReadTokens; normalized.cacheWrite = call.cacheWriteTokens;
        normalized.totalTokens = normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite;
        normalized.reasoning = call.reasoningTokens;
        if (call.cost) normalized.cost = call.cost;
        this.recordAssistant(active, active.text.slice(lastText.value.length), normalized, call.model);
        this.emit({ type: "turn_start" });
        lastText.value = active.text;
      }
      reportedCalls = usage.calls.length;
      active.usage = active.assistantEntries.reduce((sum, entry) => addUsage(sum, entry.message.usage), emptyModelUsage());
    };
    try {
      const result = await (this.input.runFallback ?? runOpenRouterTurn)({
        apiKey: this.input.config.OPENROUTER_API_KEY, model: this.input.config.OPENROUTER_MAIN_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: content.map(part => part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image_url" as const, image_url: { url: part.url } }) },
        ],
        tools: specs.map(spec => ({ name: spec.name, description: spec.description, parameters: spec.inputSchema,
          execute: async (args, _signal, callId) => {
            const result = await this.executeTool(active, spec.name, args, callId ?? randomUUID());
            return { ...result, content: result.content.map(part => part.type === "text" ? part : { type: "image_url" as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` } }) };
          },
        })),
        signal: active.controller.signal,
        maxModelCycles: this.input.config.PI_MAX_MODEL_CYCLES,
        maxToolCalls: this.input.config.PI_MAX_TOOL_CALLS,
        requestTimeoutMs: this.input.config.CODEX_REQUEST_TIMEOUT_MS,
        reasoningEffort: this.input.config.CODEX_THINKING_LEVEL ?? this.input.config.PI_THINKING_LEVEL,
        onText: delta => { active.text += delta; this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }); },
        onToolCall: (call: OpenRouterToolCall) => { let args: unknown = {}; try { args = JSON.parse(call.function.arguments); } catch { /* runner returns invalid args */ } this.toolStart(active, call.id, call.function.name, args); },
        onToolResult: (call, result) => { if (!active.toolEnds.has(call.id)) this.toolEnd(active, call.id, call.function.name, { content: result.content.flatMap(part => part.type === "text" ? [part] : []), details: result.details, isError: result.isError === true, completed: result.completed }); },
        onUsage: trackUsage,
      });
      trackUsage(result.usage);
      active.finalText = result.text;
    } catch (error) {
      if (error instanceof OpenRouterError && error.partial) trackUsage(error.partial.usage);
      throw error;
    }
  }

  private setTurnId(active: ActiveTurn, id: string): void { active.turnId = id; active.userEntry.id = `codex:${id}`; }

  private recordAssistant(active: ActiveTurn, text: string, usage: ModelUsage, model?: string, error?: unknown): void {
    const message: AssistantMessage = {
      role: "assistant", content: [...(active.cycleReasoning ? [{ type: "thinking" as const, thinking: active.cycleReasoning }] : []), ...(text ? [{ type: "text" as const, text }] : [])],
      provider: active.provider === "codex" ? "openai-codex" : "openrouter", model: model ?? (active.provider === "codex" ? this.input.config.CODEX_MODEL : this.input.config.OPENROUTER_MAIN_MODEL),
      usage, stopReason: error ? active.controller.signal.aborted ? "aborted" : "error" : "stop",
      errorMessage: error ? error instanceof Error ? error.message : String(error) : undefined,
      timestamp: Date.now(),
    };
    const entry = this.append(active, message) as Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage };
    active.assistantEntries.push(entry);
  }

  private finalizeAssistant(active: ActiveTurn, error?: unknown): void {
    const last = active.assistantEntries.at(-1);
    const text = active.finalText ?? (active.cycleText || active.text);
    if (!last) this.recordAssistant(active, text, active.usage, undefined, error);
    const message = active.assistantEntries.at(-1)!.message;
    if (!active.terminalResult && text) message.content = [...(active.reasoning ? [{ type: "thinking" as const, thinking: active.reasoning }] : []), { type: "text", text }];
    if (error) { message.stopReason = active.controller.signal.aborted ? "aborted" : "error"; message.errorMessage = error instanceof Error ? error.message : String(error); }
    else message.stopReason = active.budgetTerminated ? "aborted" : "stop";
  }

  private append(active: ActiveTurn, message: AgentMessage): Extract<SessionEntry, { type: "message" }> {
    const entry = { type: "message" as const, id: active.provider === "codex" ? `codex:${active.turnId ?? randomUUID()}` : `openrouter:${randomUUID()}`, message };
    this.entries.push(entry);
    this.emit({ type: "message_end", message });
    return entry;
  }

  private emit(event: AgentSessionEvent): void { for (const listener of this.listeners) listener(event); }

  async acknowledgeDelivery(messageId: number): Promise<void> { if (this.lastProvider === "codex") await this.input.onDelivery?.(messageId); }

  async abort(reason: unknown = new Error("Agent turn cancelled.")): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort(reason);
    active.done.reject(reason);
    await this.interrupt(active);
  }

  private async interrupt(active: ActiveTurn): Promise<void> {
    if (!active.threadId || !active.turnId || active.finished) return;
    await this.input.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }).catch(() => undefined);
  }

  getSessionStats(): { totalMessages: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } {
    const usage = this.entries.reduce((sum, entry) => entry.type === "message" && entry.message.role === "assistant" ? addUsage(sum, entry.message.usage) : sum, this.lifetimeUsage);
    return { totalMessages: this.lifetimeMessages + this.entries.filter(entry => entry.type === "message").length, tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens } };
  }

  private retireEntries(): void {
    for (const entry of this.entries) {
      if (entry.type !== "message") continue;
      this.lifetimeMessages++;
      if (entry.message.role === "assistant") this.lifetimeUsage = addUsage(this.lifetimeUsage, entry.message.usage);
    }
    this.entries.length = 0;
  }

  async dispose(): Promise<void> { this.disposed = true; await this.abort(); for (const unsubscribe of this.unsubscribers) unsubscribe(); this.listeners.clear(); }
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0; }
function nativeUsage(value: Record<string, unknown> | undefined): ModelUsage {
  const usage = emptyModelUsage();
  const input = count(value?.inputTokens ?? value?.input_tokens);
  usage.cacheRead = Math.min(input, count(value?.cachedInputTokens ?? value?.cached_input_tokens));
  usage.cacheWrite = Math.min(input - usage.cacheRead, count(value?.cacheWriteInputTokens ?? value?.cache_write_input_tokens));
  usage.input = input - usage.cacheRead - usage.cacheWrite;
  usage.output = count(value?.outputTokens ?? value?.output_tokens);
  usage.reasoning = count(value?.reasoningOutputTokens ?? value?.reasoning_output_tokens);
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}
function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return { ...emptyModelUsage(), input: left.input + right.input, output: left.output + right.output, cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, totalTokens: left.totalTokens + right.totalTokens, reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0), cost: { input: left.cost.input + right.cost.input, output: left.cost.output + right.cost.output, cacheRead: left.cost.cacheRead + right.cost.cacheRead, cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite, total: left.cost.total + right.cost.total } };
}
function subtractUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return { ...emptyModelUsage(), input: Math.max(0, left.input - right.input), output: Math.max(0, left.output - right.output), cacheRead: Math.max(0, left.cacheRead - right.cacheRead), cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite), totalTokens: Math.max(0, left.totalTokens - right.totalTokens), reasoning: Math.max(0, (left.reasoning ?? 0) - (right.reasoning ?? 0)) };
}
function nativeEffort(value: string): string { return value === "off" ? "minimal" : value === "max" ? "xhigh" : value; }
function nativeError(value: Record<string, unknown>): Error {
  const error = new Error(typeof value.message === "string" ? value.message : "Codex generation failed.");
  Object.assign(error, { codexErrorInfo: value.codexErrorInfo, additionalDetails: value.additionalDetails });
  return error;
}
