import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { isBrowserUseConfigured } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { CommandRuntime } from "../sandbox/types.js";
import type { AgentRuntimeService } from "../ai/runtime.js";
import { buildThreadTitlePrompt, THREAD_TITLE_SYSTEM_PROMPT, type ThreadTitlePromptInput } from "../ai/threadTitle.js";
import { renderSystemPrompt } from "../ai/prompt.js";
import { BrowserUseRuntimeManager } from "../browserUse/runtime.js";
import { resolveThreadFileDescriptors } from "../e2b/threadFiles.js";
import { threadFilesRevision } from "../e2b/telegramFileMaterializer.js";
import { E2B_WORKSPACE } from "../e2b/paths.js";
import { asRecord, safeJson } from "../util/records.js";
import { CodexAppServer, type CodexClient, type RpcNotification } from "./appServer.js";
import { expandPath, prepareCodexAuth } from "./auth.js";
import { CodexCircuitBreaker, retryableCodexError } from "./circuit.js";
import { codexRolloutHistory, loadThreadHistory, type CodexHistoryItem, type CodexRolloutHistory } from "./history.js";
import { LazyCodexExecutor } from "./lazyExecutor.js";
import { CodexSession } from "./session.js";
import { ThreadBridge } from "./threadBridge.js";
import { nativeToolSpecs } from "./tools.js";
import { skillInstructions, validateSkills } from "./skills.js";
import { runOpenRouterTurn, type OpenRouterMessage } from "./openrouter.js";

interface ThreadRuntime {
  session: CodexSession;
  bridge: ThreadBridge;
  lastUsedAt: number;
  adapter?: LazyCodexExecutor;
  nativeId?: string;
  registered: boolean;
  resumed: boolean;
  uncertainHistory: boolean;
  historyCheckpoint?: number;
  pendingSessionCheckpoint?: number | null;
  filesRevision?: string;
  rawEventsEnabled?: boolean;
  initializing?: Promise<string>;
  historySources?: NativeHistorySource[];
}
interface NativeHistorySource { nativeId: string; rolloutPath: string; turnIds: string[] }
interface RuntimeInput {
  config: AppConfig; db: AppDatabase; repos: Repos; logger: Logger; commandRuntime?: CommandRuntime;
  client?: CodexClient;
  auth?: () => Promise<{ home: string; configured: boolean }>;
}

/** Owns persistent Codex threads, one local app-server, and the rare provider fallback. */
export class CodexRuntimeManager implements AgentRuntimeService {
  readonly client: CodexClient;
  readonly circuit = new CodexCircuitBreaker();
  private readonly runtimes = new Map<number, ThreadRuntime>();
  private readonly opening = new Map<number, Promise<ThreadRuntime>>();
  private readonly browserRuntime?: BrowserUseRuntimeManager;
  private initialization?: Promise<void>;
  private configured = false;
  private instructions = "";
  private disposed = false;
  private readonly home: string;
  private readonly disconnect: () => void;

  constructor(private readonly input: RuntimeInput) {
    this.home = expandPath(input.config.CODEX_HOME);
    this.input = { ...input, config: { ...input.config, CODEX_HOME: this.home } };
    this.client = input.client ?? new CodexAppServer({ home: this.home, executable: input.config.CODEX_EXECUTABLE, requestTimeoutMs: input.config.CODEX_REQUEST_TIMEOUT_MS, logger: input.logger });
    if (isBrowserUseConfigured(input.config)) this.browserRuntime = new BrowserUseRuntimeManager({ config: input.config, repos: input.repos, logger: input.logger });
    this.disconnect = this.client.onDisconnect(() => {
      for (const runtime of this.runtimes.values()) { runtime.registered = false; runtime.resumed = false; runtime.rawEventsEnabled = false; runtime.initializing = undefined; }
    });
  }

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await validateSkills();
      this.instructions = await skillInstructions();
      const auth = await this.prepareAuth();
      this.configured = auth.configured;
      await fs.mkdir(path.join(this.home, "executor-metadata"), { recursive: true, mode: 0o700 });
      try { await this.client.initialize(); }
      catch (error) { this.recordUnavailable(error); this.input.logger.warn("Codex app-server unavailable; OpenRouter fallback remains available"); }
      this.input.logger.info("Inference runtime initialized", { primary: "codex", fallback: "openrouter", codexConfigured: this.configured });
    })();
    return this.initialization;
  }

  private prepareAuth(): Promise<{ home: string; configured: boolean }> {
    return this.input.auth?.() ?? prepareCodexAuth({ config: this.input.config, logger: this.input.logger });
  }

  async runtime(thread: ThreadRow, user: UserRow): Promise<ThreadRuntime> {
    await this.initialize();
    if (this.disposed) throw new Error("Inference runtime is closed.");
    const cached = this.runtimes.get(thread.id);
    if (cached) { cached.bridge.thread = thread; cached.bridge.user = user; cached.lastUsedAt = Date.now(); return cached; }
    let opening = this.opening.get(thread.id);
    if (!opening) {
      opening = this.createRuntime(thread, user);
      this.opening.set(thread.id, opening);
      void opening.finally(() => this.opening.delete(thread.id)).catch(() => undefined);
    }
    return opening;
  }

  private async createRuntime(thread: ThreadRow, user: UserRow): Promise<ThreadRuntime> {
    const bridge = new ThreadBridge({ ...this.input, thread, user, browserRuntime: this.browserRuntime });
    const state = { bridge, lastUsedAt: Date.now(), nativeId: thread.codex_thread_id ?? undefined, registered: false, resumed: false, uncertainHistory: false } as ThreadRuntime;
    const checkpoint = await this.readCheckpoint(thread.id);
    if (checkpoint && checkpoint.updatedAt >= (thread.codex_migrated_at ?? 0)) {
      state.nativeId = checkpoint.nativeId;
      state.historyCheckpoint = checkpoint.historyMessageId ?? undefined;
      state.pendingSessionCheckpoint = checkpoint.historyMessageId;
      state.historySources = checkpoint.historySources;
    }
    state.session = new CodexSession({
      client: this.client, bridge, config: this.input.config,
      ensureThread: () => this.ensureThread(state),
      nativeRawEventsEnabled: () => state.rawEventsEnabled === true,
      chooseCodex: async () => {
        this.configured = (await this.prepareAuth()).configured;
        return this.configured && this.circuit.acquire().allowed;
      },
      codexSucceeded: () => this.circuit.recordSuccess(),
      codexUnavailable: error => this.recordUnavailable(error),
      getFallbackHistory: async () => historyToOpenRouter((await loadThreadHistory({ repos: this.input.repos, thread: bridge.thread, maxMessageId: bridge.activeMessageId === undefined ? undefined : bridge.activeMessageId - 1 })).items),
      onArtifact: () => state.adapter?.invalidateFiles(),
      onNativeHistoryUncertain: () => { state.uncertainHistory = true; state.resumed = false; },
      onTurnFinished: async () => {
        await state.adapter?.refreshBootstrap();
        if (bridge.activeMessageId !== undefined) await this.checkpointHistory(state, bridge.activeMessageId);
      },
      onDelivery: messageId => this.checkpointHistory(state, messageId),
    });
    this.runtimes.set(thread.id, state);
    for (const old of [...this.runtimes.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
      if (this.runtimes.size <= 32) break;
      if (old === state || old.session.isStreaming) continue;
      this.runtimes.delete(old.bridge.thread.id);
      await old.session.dispose();
      await old.adapter?.dispose();
      if (old.nativeId) await this.client.request("thread/unsubscribe", { threadId: old.nativeId }).catch(() => undefined);
    }
    return state;
  }

  private ensureThread(state: ThreadRuntime): Promise<string> {
    if (state.initializing) return state.initializing;
    const operation = this.prepareThread(state);
    state.initializing = operation;
    void operation.finally(() => { if (state.initializing === operation) state.initializing = undefined; }).catch(() => undefined);
    return operation;
  }

  private async prepareThread(state: ThreadRuntime): Promise<string> {
    const { bridge } = state;
    if (!this.input.commandRuntime?.prepareRemoteExecutor) throw new Error("Native Codex executor runtime is unavailable.");
    state.adapter ??= await LazyCodexExecutor.create({
      cachePath: path.join(this.home, "executor-metadata", `${bridge.user.tg_id}-${bridge.thread.id}.json`),
      logger: this.input.logger,
      resolveLocalArtifact: (fileUrl, operation, signal) => bridge.resolveLocalArtifact(fileUrl, operation, signal),
      prepareExecutor: async (onExecutorReady, signal, options) => {
        bridge.holdCommandActivity(true);
        const files = await resolveThreadFileDescriptors(bridge.buildInput(), signal);
        const artifacts = await bridge.nativeArtifactFiles(signal);
        return this.input.commandRuntime!.prepareRemoteExecutor!({ userId: bridge.user.tg_id, threadId: bridge.thread.id, files, artifacts, artifactRoot: path.join(this.home, "generated_images"), signal, onExecutorReady, allowRotation: options.allowRotation });
      },
    });
    state.adapter.beginTurn();
    // Synchronize changed attachment manifests; ordinary warm turns keep their connection ready.
    const revision = threadFilesRevision(await resolveThreadFileDescriptors(bridge.buildInput()));
    if (state.filesRevision !== revision || this.input.commandRuntime.needsRemoteExecutorRefresh?.(bridge.user.tg_id, bridge.thread.id)) {
      state.adapter.invalidateFiles();
      state.filesRevision = revision;
    }
    const environmentId = `telegram:${bridge.user.tg_id}:${bridge.thread.id}`;
    if (!state.registered) {
      await this.client.request("environment/add", { environmentId, execServerUrl: state.adapter.url, authBearerToken: state.adapter.authBearerToken });
      state.registered = true;
    }
    const current = await this.input.repos.threads.get(bridge.thread.id) ?? bridge.thread;
    if (state.nativeId && state.pendingSessionCheckpoint !== undefined) {
      await this.input.repos.threads.setCodexSession(current.id, state.nativeId, Date.now(), state.pendingSessionCheckpoint);
      state.pendingSessionCheckpoint = undefined;
    }
    const maxMessageId = bridge.activeMessageId === undefined ? undefined : bridge.activeMessageId - 1;
    const developerInstructions = `${await renderSystemPrompt({ user: bridge.user, config: this.input.config })}\n\n${this.instructions}`;
    const settings = { model: this.input.config.CODEX_MODEL, cwd: E2B_WORKSPACE, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions, serviceTier: this.input.config.CODEX_FAST_MODE ? "priority" : null,
      config: { "features.deferred_executor": true, "features.unified_exec": true, "features.shell_snapshot": false, "skills.include_instructions": false, web_search: "live", model_context_window: this.input.config.MODEL_CONTEXT_TOKENS } };
    if (!state.nativeId) state.nativeId = current.codex_thread_id ?? undefined;
    if (state.nativeId && !state.uncertainHistory) {
      if (!state.resumed) {
        try {
          const stored = await this.client.request("thread/read", { threadId: state.nativeId });
          const rolloutPath = asRecord(stored.thread)?.path;
          const history = typeof rolloutPath === "string" ? await this.readNativeHistory(rolloutPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }) : undefined;
          if (history?.invalidCallIds) {
            const previousId = state.nativeId;
            const started = await this.client.request("thread/start", { ...settings, dynamicTools: nativeToolSpecs(bridge), environments: [{ environmentId, cwd: E2B_WORKSPACE }], experimentalRawEvents: true, ephemeral: false });
            const id = String(asRecord(started.thread)?.id ?? "");
            if (!id) throw new Error("Codex did not return a repaired thread id.");
            try { await this.client.request("thread/inject_items", { threadId: id, items: history.items }); }
            catch (error) { await this.client.request("thread/unsubscribe", { threadId: id }).catch(() => undefined); throw error; }
            const sources = [...state.historySources ?? [], { nativeId: previousId, rolloutPath: rolloutPath as string, turnIds: history.turnIds }];
            const checkpoint = state.historyCheckpoint ?? current.codex_history_message_id ?? null;
            await this.writeCheckpoint(current.id, id, checkpoint, sources);
            state.nativeId = id; state.resumed = true; state.rawEventsEnabled = true; state.historySources = sources;
            state.pendingSessionCheckpoint = checkpoint;
            for (const filePath of history.artifactPaths) bridge.registerNativeArtifact(filePath);
            await this.input.repos.threads.setCodexSession(current.id, id, Date.now(), checkpoint);
            state.pendingSessionCheckpoint = undefined;
            await this.client.request("thread/unsubscribe", { threadId: previousId }).catch(() => undefined);
            this.input.logger.info("Repaired legacy Codex conversation call ids", { threadId: current.id, repairedCallIds: history.invalidCallIds, retainedItems: history.items.length });
          } else {
            const resumed = await this.client.request("thread/resume", { threadId: state.nativeId, ...settings });
            this.recoverArtifacts(state, resumed);
            state.resumed = true; state.rawEventsEnabled = false;
          }
          for (const source of state.historySources ?? []) {
            try {
              const original = await this.readNativeHistory(source.rolloutPath, source.turnIds.at(-1));
              for (const filePath of original.artifactPaths) bridge.registerNativeArtifact(filePath);
            } catch {
              // A missing audit source must not prevent continuing the valid
              // replacement. Exact historical forks still require that source.
              this.input.logger.warn("Preserved Codex artifact history is unavailable", { threadId: current.id, sourceNativeId: source.nativeId });
            }
          }
        } catch (error) {
          if (!/thread.*(not found|does not exist|missing)|no rollout|unable to find.*thread/i.test(String(error))) throw error;
          this.input.logger.warn("Codex session missing; rebuilding from durable conversation history", { threadId: current.id });
          state.nativeId = undefined;
        }
      }
      if (state.nativeId) {
        const catchup = await loadThreadHistory({ repos: this.input.repos, thread: current, maxMessageId, afterMessageId: Math.max(state.historyCheckpoint ?? 0, current.codex_history_message_id ?? 0), skipNativeLinkedMessages: true });
        if (catchup.items.length) await this.client.request("thread/inject_items", { threadId: state.nativeId, items: catchup.items });
        state.historyCheckpoint = catchup.snapshotMessageId ?? state.historyCheckpoint;
        if (catchup.snapshotMessageId !== null) await this.checkpointHistory(state, catchup.snapshotMessageId);
        return state.nativeId;
      }
    }
    const history = await loadThreadHistory({ repos: this.input.repos, thread: current, maxMessageId });
    const started = await this.client.request("thread/start", { ...settings, dynamicTools: nativeToolSpecs(bridge), environments: [{ environmentId, cwd: E2B_WORKSPACE }], experimentalRawEvents: true, ephemeral: false });
    const id = String(asRecord(started.thread)?.id ?? "");
    if (!id) throw new Error("Codex did not return a persistent thread id.");
    if (history.items.length) await this.client.request("thread/inject_items", { threadId: id, items: history.items });
    state.nativeId = id; state.resumed = true; state.rawEventsEnabled = true; state.uncertainHistory = false;
    state.historyCheckpoint = history.snapshotMessageId ?? undefined;
    state.pendingSessionCheckpoint = history.snapshotMessageId;
    await this.writeCheckpoint(current.id, id, history.snapshotMessageId, state.historySources);
    await this.input.repos.threads.setCodexSession(current.id, id, Date.now(), history.snapshotMessageId);
    state.pendingSessionCheckpoint = undefined;
    this.input.logger.info("Codex conversation ready", { threadId: current.id, importedFrom: history.source, importedItems: history.items.length });
    return id;
  }

  private recoverArtifacts(state: ThreadRuntime, result: unknown): void {
    const thread = asRecord(asRecord(result)?.thread);
    if (!Array.isArray(thread?.turns)) return;
    for (const turn of thread.turns) {
      const items = asRecord(turn)?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const record = asRecord(item);
        if (record?.type === "imageGeneration" && typeof record.savedPath === "string") state.bridge.registerNativeArtifact(record.savedPath);
      }
    }
  }

  private async readNativeHistory(rolloutPath: string, lastTurnId?: string): Promise<CodexRolloutHistory> {
    const [canonical, home] = await Promise.all([fs.realpath(rolloutPath), fs.realpath(this.home)]);
    const relative = path.relative(home, canonical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Codex rollout is outside the configured conversation directory.");
    return codexRolloutHistory(await fs.readFile(canonical, "utf8"), { lastTurnId });
  }

  private recordUnavailable(error: unknown): boolean {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const info = asRecord(record?.codexErrorInfo);
    const httpInfo = asRecord(info?.httpConnectionFailed) ?? asRecord(info?.responseStreamDisconnected) ?? asRecord(info?.responseStreamConnectionFailed) ?? asRecord(info?.responseTooManyFailedAttempts);
    const message = error instanceof Error ? error.message : safeJson(error);
    const retryable = retryableCodexError({ message, status: typeof record?.status === "number" ? record.status : typeof data?.httpStatusCode === "number" ? data.httpStatusCode : typeof httpInfo?.httpStatusCode === "number" ? httpInfo.httpStatusCode : undefined })
      || /usageLimitExceeded|rateLimitExceeded|serverOverloaded|internalServerError|flexUnavailable|unauthorized|authentication|not logged in|login required|app-server.*(?:exited|disconnect)|enoent/i.test(message + safeJson(data) + safeJson(record?.codexErrorInfo));
    if (retryable) this.circuit.recordFailure(); else this.circuit.releaseProbe();
    return retryable;
  }

  async compact(thread: ThreadRow, user: UserRow, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const runtime = await this.runtime(thread, user);
    if (!(await this.prepareAuth()).configured || !this.circuit.acquire().allowed) throw new Error("Codex memory compaction is temporarily unavailable.");
    const id = await this.ensureThread(runtime);
    const before = await this.client.request("thread/read", { threadId: id, includeTurns: true }, signal);
    try {
      await this.waitForThread(id, event => {
        const turn = asRecord(event.params.turn);
        if (event.method === "error" && event.params.willRetry !== true || event.method === "turn/completed" && (turn?.status === "failed" || turn?.status === "interrupted")) {
          const error = asRecord(turn?.error) ?? asRecord(event.params.error);
          throw Object.assign(new Error(String(error?.message ?? "Codex memory compaction failed.")), { codexErrorInfo: error?.codexErrorInfo });
        }
        return event.method === "thread/compacted" || event.method === "item/completed" && asRecord(event.params.item)?.type === "contextCompaction";
      }, () => this.client.request("thread/compact/start", { threadId: id }, signal), signal);
      this.circuit.recordSuccess();
    } catch (error) { this.recordUnavailable(error); throw error; }
    const after = await this.client.request("thread/read", { threadId: id, includeTurns: true }, signal);
    const count = (value: unknown) => { const turns = asRecord(asRecord(value)?.thread)?.turns; return Array.isArray(turns) ? turns.reduce((sum, turn) => sum + (Array.isArray(asRecord(turn)?.items) ? (asRecord(turn)!.items as unknown[]).length : 0), 0) : 0; };
    return Math.max(0, count(before) - count(after));
  }

  async fork(source: ThreadRow, target: ThreadRow, user: UserRow, entryId?: string | null, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.initialize();
    if (!(await this.prepareAuth()).configured || entryId && !entryId.startsWith("codex:")) {
      // Preserve old Pi branch fidelity for import on first resume; the DB chain is already forked.
      if (source.pi_session_file) await this.input.repos.threads.setPiSession(target.id, source.pi_session_file, source.pi_session_id ?? "legacy");
      return;
    }
    const runtime = await this.runtime(source, user);
    const id = await this.ensureThread(runtime);
    const oldTurnId = entryId?.startsWith("codex:") ? entryId.slice(6) : undefined;
    const original = oldTurnId ? runtime.historySources?.find(history => history.turnIds.includes(oldTurnId)) : undefined;
    let forked: Record<string, unknown>;
    let historySources = runtime.historySources;
    if (original && oldTurnId) {
      const history = await this.readNativeHistory(original.rolloutPath, oldTurnId);
      const bridge = new ThreadBridge({ ...this.input, thread: target, user, browserRuntime: this.browserRuntime });
      forked = await this.client.request("thread/start", { model: this.input.config.CODEX_MODEL, cwd: E2B_WORKSPACE, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: `${await renderSystemPrompt({ user, config: this.input.config })}\n\n${this.instructions}`, serviceTier: this.input.config.CODEX_FAST_MODE ? "priority" : null,
        config: { "features.deferred_executor": true, "features.unified_exec": true, "features.shell_snapshot": false, "skills.include_instructions": false, web_search: "live", model_context_window: this.input.config.MODEL_CONTEXT_TOKENS },
        dynamicTools: nativeToolSpecs(bridge), environments: [], experimentalRawEvents: true, ephemeral: false }, signal);
      const forkId = String(asRecord(forked.thread)?.id ?? "");
      if (!forkId) throw new Error("Codex did not return a forked thread id.");
      await this.client.request("thread/inject_items", { threadId: forkId, items: history.items }, signal);
      historySources = [...runtime.historySources!.slice(0, runtime.historySources!.indexOf(original)), { ...original, turnIds: history.turnIds }];
    } else {
      forked = await this.client.request("thread/fork", { threadId: id, ...(oldTurnId ? { lastTurnId: oldTurnId } : {}), cwd: E2B_WORKSPACE, approvalPolicy: "never", sandbox: "danger-full-access", config: { "features.shell_snapshot": false, "skills.include_instructions": false } }, signal);
    }
    const forkId = String(asRecord(forked.thread)?.id ?? "");
    if (!forkId) throw new Error("Codex did not return a forked thread id.");
    const chain = await this.input.repos.threads.chain(target);
    const rows = await this.input.repos.messages.listForThreadChain(chain);
    const checkpoint = rows.at(-1)?.id ?? null;
    await this.writeCheckpoint(target.id, forkId, checkpoint, historySources);
    await this.input.repos.threads.setCodexSession(target.id, forkId, Date.now(), checkpoint);
  }

  async abort(threadId: number): Promise<boolean> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.session.isStreaming) return false;
    await runtime.session.abort(); return true;
  }

  captionImage(bytes: Buffer, mimeType: string, userCaption?: string): Promise<string> {
    return this.helper({ system: "Describe the supplied image accurately in one compact paragraph for durable conversation memory. Mention visible text and details likely to matter later. Return only the description.",
      prompt: userCaption?.trim() ? `Describe this image. Telegram caption: ${userCaption.trim()}` : "Describe this image for later conversation recall.", image: { bytes, mimeType }, timeoutMs: this.input.config.CODEX_TURN_TIMEOUT_MS ?? this.input.config.PI_TURN_TIMEOUT_MS });
  }
  generateThreadTitle(input: ThreadTitlePromptInput): Promise<string> {
    return this.helper({ system: THREAD_TITLE_SYSTEM_PROMPT, prompt: buildThreadTitlePrompt(input), timeoutMs: this.input.config.THREAD_TITLE_TIMEOUT_MS });
  }

  private async helper(input: { system: string; prompt: string; image?: { bytes: Buffer; mimeType: string }; timeoutMs: number }): Promise<string> {
    await this.initialize();
    const signal = input.timeoutMs > 0 ? AbortSignal.timeout(input.timeoutMs) : undefined;
    const auth = await this.prepareAuth();
    if (auth.configured && this.circuit.acquire().allowed) {
      let id: string | undefined;
      try {
        const started = await this.client.request("thread/start", { model: this.input.config.CODEX_HELPER_MODEL, developerInstructions: `${input.system}\nUse no tools.`, environments: [], ephemeral: true, approvalPolicy: "never", config: { "features.shell_snapshot": false, "skills.include_instructions": false, web_search: "disabled" } }, signal);
        id = String(asRecord(started.thread)?.id ?? "");
        let text = "";
        await this.waitForThread(id, event => {
          if (event.method === "item/agentMessage/delta") text += String(event.params.delta ?? "");
          if (event.method === "item/completed" && asRecord(event.params.item)?.type === "agentMessage" && typeof asRecord(event.params.item)?.text === "string") text = String(asRecord(event.params.item)!.text);
          if (event.method !== "turn/completed") return false;
          const turn = asRecord(event.params.turn);
          if (turn?.status === "failed") {
            const failure = asRecord(turn.error);
            throw Object.assign(new Error(String(failure?.message ?? "Codex helper failed.")), { codexErrorInfo: failure?.codexErrorInfo, additionalDetails: failure?.additionalDetails });
          }
          return true;
        }, () => this.client.request("turn/start", { threadId: id, input: [{ type: "text", text: input.prompt }, ...(input.image ? [{ type: "image", url: `data:${input.image.mimeType};base64,${input.image.bytes.toString("base64")}` }] : [])], environments: [], effort: "low" }, signal), signal);
        this.circuit.recordSuccess(); return text.trim();
      } catch (error) { if (signal?.aborted || !this.recordUnavailable(error)) throw error; }
      finally { if (id) await this.client.request("thread/unsubscribe", { threadId: id }).catch(() => undefined); }
    }
    const result = await runOpenRouterTurn({ apiKey: this.input.config.OPENROUTER_API_KEY, model: this.input.config.OPENROUTER_HELPER_MODEL, signal, requestTimeoutMs: this.input.config.CODEX_REQUEST_TIMEOUT_MS,
      messages: [{ role: "system", content: input.system }, { role: "user", content: [{ type: "text", text: input.prompt }, ...(input.image ? [{ type: "image_url" as const, image_url: { url: `data:${input.image.mimeType};base64,${input.image.bytes.toString("base64")}` } }] : [])] }] });
    return result.text.trim();
  }

  private async waitForThread(threadId: string, done: (event: RpcNotification) => boolean, start: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // A disconnect can reject completion while start() is still pending.
    void completion.catch(() => undefined);
    const unsub = this.client.onNotification(event => {
      if (event.params.threadId !== threadId) return;
      try { if (done(event)) resolve(); } catch (error) { reject(error); }
    });
    const offDisconnect = this.client.onDisconnect(() => reject(new Error("Codex app-server is disconnected.")));
    const aborted = () => reject(signal?.reason ?? new Error("Codex operation cancelled."));
    signal?.addEventListener("abort", aborted, { once: true });
    const timeout = setTimeout(() => reject(new Error("Codex operation timed out.")), this.input.config.CODEX_REQUEST_TIMEOUT_MS); timeout.unref();
    try { await start(); await completion; }
    finally { clearTimeout(timeout); unsub(); offDisconnect(); signal?.removeEventListener("abort", aborted); }
  }

  private checkpointPath(threadId: number): string { return path.join(this.home, "executor-metadata", `conversation-${threadId}.json`); }

  private async readCheckpoint(threadId: number): Promise<{ nativeId: string; historyMessageId: number | null; updatedAt: number; historySources?: NativeHistorySource[] } | undefined> {
    try {
      const value = asRecord(JSON.parse(await fs.readFile(this.checkpointPath(threadId), "utf8")));
      if (typeof value?.nativeId !== "string" || !value.nativeId || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return;
      if (value.historyMessageId !== null && (typeof value.historyMessageId !== "number" || !Number.isSafeInteger(value.historyMessageId) || value.historyMessageId < 0)) return;
      const historySources = Array.isArray(value.historySources) ? value.historySources.flatMap(source => {
        const record = asRecord(source);
        return typeof record?.nativeId === "string" && typeof record.rolloutPath === "string" && Array.isArray(record.turnIds) && record.turnIds.every(id => typeof id === "string")
          ? [{ nativeId: record.nativeId, rolloutPath: record.rolloutPath, turnIds: record.turnIds as string[] }] : [];
      }) : undefined;
      return { nativeId: value.nativeId, historyMessageId: value.historyMessageId as number | null, updatedAt: value.updatedAt, historySources };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.input.logger.warn("Codex checkpoint metadata could not be read", { threadId }); }
  }

  private async writeCheckpoint(threadId: number, nativeId: string, historyMessageId: number | null, historySources?: NativeHistorySource[]): Promise<void> {
    const destination = this.checkpointPath(threadId);
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ nativeId, historyMessageId, updatedAt: Date.now(), ...(historySources?.length ? { historySources } : {}) }), { mode: 0o600 });
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async checkpointHistory(state: ThreadRuntime, messageId: number): Promise<void> {
    state.historyCheckpoint = Math.max(state.historyCheckpoint ?? 0, messageId);
    if (state.nativeId) await this.writeCheckpoint(state.bridge.thread.id, state.nativeId, state.historyCheckpoint, state.historySources);
    await this.input.repos.threads.setCodexHistoryMessageId(state.bridge.thread.id, state.historyCheckpoint);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const runtime of this.runtimes.values()) { await runtime.session.dispose(); await runtime.bridge.endTurn(); await runtime.adapter?.dispose(); }
    this.runtimes.clear(); this.disconnect();
    await this.browserRuntime?.dispose(); await this.client.dispose();
  }
}

export function historyToOpenRouter(items: readonly CodexHistoryItem[]): OpenRouterMessage[] {
  return items.map((item): OpenRouterMessage => {
    if (item.type === "function_call") return { role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] };
    if (item.type === "function_call_output") return { role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : safeJson(item.output) };
    return { role: item.role, content: item.content.map(part => part.type === "input_image" ? { type: "image_url" as const, image_url: { url: part.image_url } } : { type: "text" as const, text: part.text }) };
  });
}
