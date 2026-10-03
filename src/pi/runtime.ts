import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type OAuthCredential, type TextContent } from "@earendil-works/pi-ai";
import { ThreadBridge, createChatFileContextExtension } from "./threadBridge.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRegistry, ModelRuntime, readStoredCredential, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow, UserRow } from "../db/types.js";
import { renderSystemPrompt } from "../ai/prompt.js";
import type { Logger } from "../logger.js";
import { createGenerateImagePiTool } from "./imageExtension.js";
import { registerPiProviderRouter, type PiProviderRouter, type PiProviderStreamOverrides } from "./provider.js";
import { createPiToolAdapters, createFinishResponseGuard } from "./toolAdapter.js";
import type { CommandRuntime } from "../sandbox/types.js";
import {
  buildThreadTitlePrompt,
  THREAD_TITLE_SYSTEM_PROMPT,
  type ThreadTitlePromptInput,
} from "./threadTitle.js";
import { isBrowserUseConfigured } from "../config.js";
import { BrowserUseRuntimeManager } from "../browserUse/runtime.js";
import {
  APPROVED_PI_SKILLS,
  approvedSkillPaths,
  createApprovedSkillReadTool,
  validateApprovedSkills,
} from "./officeSkills.js";
import { createTurnPromptContextExtension } from "./turnContext.js";
import {
  CODEX_PROVIDER_ID,
  CodexCliCredentialStore,
  isOAuthCredential,
  resolveCodexAuthFile,
} from "./codexCliCredentials.js";
import { createTurnBudgetExtension } from "./turnBudget.js";
import { createBotToolSearchExtension } from "./toolPolicy.js";
import { createContextPruningExtension } from "./contextPruning.js";
import { createCodexCompactionExtension } from "./codexCompaction.js";
import { raceWithAbort } from "../files/cancel.js";

const MAX_CACHED_RUNTIMES = 32;
const INITIAL_ACTIVE_TOOL_NAMES = ["read", "bash", "finish_response", "codemode", "tool_search"];

interface PiThreadRuntime {
  session: AgentSession;
  bridge: ThreadBridge;
  lastUsedAt: number;
}

export interface PiRuntimeService {
  runtime(thread: ThreadRow, user: UserRow): Promise<PiThreadRuntime>;
  compact(thread: ThreadRow, user: UserRow, signal?: AbortSignal): Promise<number>;
  fork(
    source: ThreadRow,
    target: ThreadRow,
    user: UserRow,
    entryId?: string | null,
    signal?: AbortSignal,
  ): Promise<void>;
  captionImage(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<string>;
  generateThreadTitle(input: ThreadTitlePromptInput): Promise<string>;
  abort(threadId: number): Promise<boolean>;
  dispose(): Promise<void>;
}

export class PiRuntimeManager implements PiRuntimeService {
  modelRuntime!: ModelRuntime;
  modelRegistry!: ModelRegistry;
  providerRouter!: PiProviderRouter;
  readonly agentDir: string;
  private readonly runtimes = new Map<number, PiThreadRuntime>();
  private readonly browserRuntime?: BrowserUseRuntimeManager;
  private initialization?: Promise<void>;
  private codexCredentials!: CodexCliCredentialStore;

  constructor(private readonly input: {
    config: AppConfig;
    db: AppDatabase;
    repos: Repos;
    logger: Logger;
    commandRuntime?: CommandRuntime;
    providerStreams?: PiProviderStreamOverrides;
  }) {
    this.agentDir = path.resolve(input.config.PI_CODING_AGENT_DIR);
    if (isBrowserUseConfigured(input.config)) {
      this.browserRuntime = new BrowserUseRuntimeManager({
        config: input.config,
        repos: input.repos,
        logger: input.logger,
      });
    }
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeModelRuntime();
    await this.initialization;
  }

  private async initializeModelRuntime(): Promise<void> {
    await fs.mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    await validateApprovedSkills();
    const piAuthPath = path.join(this.agentDir, "auth.json");
    const piCodexCredential = readStoredCredential(CODEX_PROVIDER_ID, piAuthPath);
    const usePiCredentials = isOAuthCredential(piCodexCredential);
    this.codexCredentials = new CodexCliCredentialStore(
      usePiCredentials ? piAuthPath : resolveCodexAuthFile(this.input.config),
      (errorCode) => {
        this.input.logger.warn(
          "Codex OAuth refresh could not be persisted; continuing with the refreshed in-memory credential",
          { errorCode },
        );
      },
      usePiCredentials ? "pi" : "codex",
    );
    const credentialStatus = await this.codexCredentials.status();
    this.modelRuntime = await ModelRuntime.create({
      credentials: this.codexCredentials,
      modelsPath: path.join(this.agentDir, "models.json"),
    });
    await this.modelRuntime.setRuntimeApiKey(
      "openrouter",
      this.input.config.OPENROUTER_API_KEY,
    );
    const codexConfigured = this.modelRuntime.hasConfiguredAuth(CODEX_PROVIDER_ID);
    this.input.logger.info("Pi inference providers initialized", {
      primary: "codex",
      fallback: "openrouter",
      codexConfigured,
      codexCredentialSource: isOAuthCredential(piCodexCredential)
        ? "pi"
        : credentialStatus === "available"
          ? "codex-cli"
          : "none",
    });
    if (!codexConfigured) {
      this.input.logger.warn("Codex OAuth is unavailable; Pi inference will use OpenRouter until Codex is configured", {
        codexCredentialStatus: credentialStatus,
      });
    }
    this.modelRegistry = new ModelRegistry(this.modelRuntime);
    this.providerRouter = registerPiProviderRouter({
      config: this.input.config,
      modelRegistry: this.modelRegistry,
      logger: this.input.logger,
      streams: this.input.providerStreams,
    });
  }

  async codexCredentialStatus(): Promise<"available" | "missing" | "invalid"> {
    await this.initialize();
    return this.codexCredentials.status();
  }

  async saveCodexCredentials(credential: OAuthCredential, signal?: AbortSignal): Promise<void> {
    await this.initialize();
    await this.codexCredentials.saveLogin(path.join(this.agentDir, "auth.json"), credential, signal);
    // Keep the runtime and registries shared by existing chat sessions. Refreshing
    // availability enables first-time login without recreating any conversation.
    const result = await this.modelRuntime.refresh({ allowNetwork: false, providers: [CODEX_PROVIDER_ID], signal });
    if (result.errors.size || !this.modelRuntime.hasConfiguredAuth(CODEX_PROVIDER_ID)) {
      throw new Error("Codex credentials were saved but provider availability could not be refreshed.");
    }
    this.providerRouter.circuit.reset();
  }

  async runtime(thread: ThreadRow, user: UserRow): Promise<PiThreadRuntime> {
    await this.initialize();
    const cached = this.runtimes.get(thread.id);
    // Active sessions own their in-flight state. Durable thread ownership
    // serializes ordinary turns and barrier operations before this idle path.
    if (cached && !cached.session.isIdle) {
      cached.lastUsedAt = Date.now();
      return cached;
    }
    // A barrier caller may have captured its row before another worker created
    // the transcript. Always use the current persisted session pointer.
    thread = await this.input.repos.threads.get(thread.id) ?? thread;
    let persistedSession: SessionManager | undefined;
    if (cached) {
      persistedSession = await this.openSessionManager(thread);
      if (persistedSession.getSessionFile() === cached.session.sessionFile
        && persistedSession.getSessionId() === cached.session.sessionId
        && persistedSession.getLeafId() === cached.session.sessionManager.getLeafId()) {
        cached.bridge.user = user;
        cached.bridge.thread = thread;
        cached.lastUsedAt = Date.now();
        return cached;
      }
      // Another owner appended or compacted this session while our cache was
      // idle. Rebuild Pi's agent state and active tools from that transcript.
      await cached.bridge.endTurn();
      cached.session.dispose();
      this.runtimes.delete(thread.id);
    }
    const systemPrompt = await renderSystemPrompt({
      user,
      config: this.input.config,
    });
    const bridge = new ThreadBridge({
      ...this.input,
      browserRuntime: this.browserRuntime,
      user,
      thread,
      modelRegistry: this.modelRegistry,
      providerRouter: this.providerRouter,
    });
    const settingsManager = SettingsManager.create(process.cwd(), this.agentDir, { projectTrusted: true });
    settingsManager.applyOverrides({
      compaction: { enabled: true },
      retry: { enabled: false },
      defaultThinkingLevel: normalizeThinkingLevel(this.input.config.PI_THINKING_LEVEL),
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [
        createCodexCompactionExtension(bridge),
        createFinishResponseGuard(),
        createTurnBudgetExtension(bridge),
        createTurnPromptContextExtension(bridge),
        createChatFileContextExtension(bridge),
        createCodemodeExtension({ mode: "on", inlineBudget: 0, models: false }),
        createBotToolSearchExtension(),
        createContextPruningExtension(),
      ],
      additionalSkillPaths: approvedSkillPaths(),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();
    const loadedSkills = resourceLoader.getSkills();
    if (loadedSkills.diagnostics.length) {
      throw new Error(`Approved Pi skill loading failed: ${JSON.stringify(loadedSkills.diagnostics)}`);
    }
    const expectedSkillNames = APPROVED_PI_SKILLS.map((skill) => skill.name).sort();
    const loadedSkillNames = loadedSkills.skills.map((skill) => skill.name).sort();
    if (JSON.stringify(loadedSkillNames) !== JSON.stringify(expectedSkillNames)) {
      throw new Error(`Unexpected Pi skills: expected ${expectedSkillNames.join(", ")}; loaded ${loadedSkillNames.join(", ") || "none"}.`);
    }
    const sessionManager = persistedSession ?? await this.openSessionManager(thread);
    const customTools = [
      createApprovedSkillReadTool(),
      ...createPiToolAdapters(bridge),
      createGenerateImagePiTool(bridge),
    ];
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      model: this.providerRouter.mainModel,
      thinkingLevel: normalizeThinkingLevel(this.input.config.PI_THINKING_LEVEL),
      noTools: "builtin",
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    // The SDK's noTools selection overrides transcript restoration. Restore the
    // branch's declared tools explicitly, retaining only bot-approved tools.
    const persistedSystem = getCurrentSystemMessage(sessionManager.buildSessionContext().messages);
    const approvedToolNames = new Set([...INITIAL_ACTIVE_TOOL_NAMES, ...customTools.map((tool) => tool.name)]);
    const activeToolNames = persistedSystem
      ? (persistedSystem.toolsAdded ?? []).map((tool) => tool.name).filter((name) => approvedToolNames.has(name))
      : INITIAL_ACTIVE_TOOL_NAMES;
    session.setActiveToolsByName(activeToolNames);
    const sessionFile = session.sessionFile;
    if (!sessionFile) throw new Error("Pi persistent session did not return a session file.");
    await this.input.repos.threads.setPiSession(thread.id, sessionFile, session.sessionId);
    const runtime = { session, bridge, lastUsedAt: Date.now() };
    this.runtimes.set(thread.id, runtime);
    await this.evictIdleRuntimes(thread.id);
    this.input.logger.info("Pi thread session ready", {
      threadId: thread.id,
      sessionId: session.sessionId,
      resumed: Boolean(thread.pi_session_file),
      skills: loadedSkillNames,
    });
    return runtime;
  }

  async compact(thread: ThreadRow, user: UserRow, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const runtime = await this.runtime(thread, user);
    signal?.throwIfAborted();
    const before = contextMessageCount(runtime.session);
    const compaction = runtime.session.compact();
    const onAbort = () => runtime.session.abortCompaction();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      await compaction;
      signal?.throwIfAborted();
      const after = contextMessageCount(runtime.session);
      return Math.max(0, before - after);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async fork(
    source: ThreadRow,
    target: ThreadRow,
    user: UserRow,
    entryId?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const runtime = await this.runtime(source, user);
    signal?.throwIfAborted();
    const sourceManager = runtime.session.sessionManager;
    const branchPoint = entryId ?? sourceManager.getLeafId();
    if (!branchPoint) return;
    const entries = sourceManager.getBranch(branchPoint);
    if (!entries.length) throw new Error(`Pi fork entry ${branchPoint} was not found.`);
    // Pi does not write a session file until its first conversation message.
    if (!entries.some(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))) return;
    const sourceFile = sourceManager.getSessionFile();
    if (!sourceFile) throw new Error("Pi source session has no persistent file.");
    // createBranchedSession switches its manager to the new branch. Use a
    // detached manager so continuing the original chat keeps its own history.
    const detached = SessionManager.open(sourceFile, path.dirname(sourceFile), process.cwd());
    const sessionFile = detached.createBranchedSession(branchPoint);
    if (!sessionFile) throw new Error("Pi could not create a persistent branched session.");
    signal?.throwIfAborted();
    const branch = SessionManager.open(sessionFile, path.dirname(sessionFile), process.cwd());
    signal?.throwIfAborted();
    await this.input.repos.threads.setPiSession(target.id, sessionFile, branch.getSessionId());
    signal?.throwIfAborted();
    this.input.logger.info("Pi thread session forked", {
      sourceThreadId: source.id,
      targetThreadId: target.id,
      sessionId: branch.getSessionId(),
    });
  }

  async abort(threadId: number): Promise<boolean> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.session.isStreaming) return false;
    void runtime.session.abort().catch((error) => {
      this.input.logger.warn("Pi turn abort failed", { threadId, error: String(error) });
    });
    return true;
  }

  async captionImage(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<string> {
    return this.runIsolatedHelper({
      systemPrompt: "Describe the supplied image accurately in one compact paragraph for durable conversation memory. Mention visible text and details likely to matter later. Return only the description.",
      prompt: "Describe this image for later conversation recall.",
      images: [{ type: "image", data: bytes.toString("base64"), mimeType }],
      timeoutMs: this.input.config.PI_TURN_TIMEOUT_MS,
      signal,
    });
  }

  generateThreadTitle(input: ThreadTitlePromptInput): Promise<string> {
    return this.runIsolatedHelper({
      systemPrompt: THREAD_TITLE_SYSTEM_PROMPT,
      prompt: buildThreadTitlePrompt(input),
      timeoutMs: this.input.config.THREAD_TITLE_TIMEOUT_MS,
    });
  }

  async dispose(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.bridge.endTurn();
      runtime.session.dispose();
    }
    this.runtimes.clear();
    await this.browserRuntime?.dispose();
  }

  private async runIsolatedHelper(input: {
    systemPrompt: string;
    prompt: string;
    images?: ImageContent[];
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    input.signal?.throwIfAborted();
    await this.initialize();
    input.signal?.throwIfAborted();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "low",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: input.systemPrompt,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      model: this.providerRouter.helperModel,
      thinkingLevel: "low",
      noTools: "all",
      resourceLoader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
    });
    try {
      await withSessionTimeout(
        session,
        (signal) => session.prompt(input.prompt, {
          images: input.images,
          expandPromptTemplates: false,
          source: "extension",
          // Abort during SDK preflight must prevent a later provider request.
          preflightResult: () => signal.throwIfAborted(),
        }),
        input.timeoutMs,
        input.signal,
      );
      return lastAssistantText(session.messages).trim();
    } finally {
      session.dispose();
    }
  }

  private async openSessionManager(thread: ThreadRow): Promise<SessionManager> {
    if (thread.pi_session_file) {
      try {
        await fs.access(thread.pi_session_file);
        return SessionManager.open(thread.pi_session_file, path.dirname(thread.pi_session_file), process.cwd());
      } catch (error) {
        this.input.logger.warn("Pi session file is missing; starting a fresh session", {
          threadId: thread.id,
          sessionFile: thread.pi_session_file,
          error: String(error),
        });
      }
    }
    const sessionDir = path.join(this.agentDir, "sessions", "telegram");
    await fs.mkdir(sessionDir, { recursive: true });
    return SessionManager.create(process.cwd(), sessionDir);
  }

  private async evictIdleRuntimes(keepThreadId: number): Promise<void> {
    while (this.runtimes.size > MAX_CACHED_RUNTIMES) {
      const candidates = [...this.runtimes.entries()]
        .filter(([threadId, runtime]) => threadId !== keepThreadId && !runtime.session.isStreaming)
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
      const victim = candidates[0];
      if (!victim) return;
      await victim[1].bridge.endTurn();
      victim[1].session.dispose();
      this.runtimes.delete(victim[0]);
    }
  }
}

function contextMessageCount(session: AgentSession): number {
  // Session statistics include compacted history. Count the raw message entries
  // still represented in model context, excluding synthesized summaries.
  return session.sessionManager.buildSessionProjection().entries.reduce((count, entry) =>
    count + (entry.sourceEntry.type === "message" ? entry.messages.length : 0), 0);
}

function normalizeThinkingLevel(level: AppConfig["PI_THINKING_LEVEL"]): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return level === "off" ? "minimal" : level;
}

async function withSessionTimeout<T>(
  session: AgentSession,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  combined.throwIfAborted();
  const onAbort = () => { void session.abort().catch(() => undefined); };
  combined.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs > 0
    ? setTimeout(() => deadline.abort(new Error(`Pi turn timed out after ${timeoutMs} ms.`)), timeoutMs)
    : undefined;
  let promise: Promise<T> | undefined;
  try {
    promise = work(combined);
    return await raceWithAbort(promise, combined);
  } finally {
    if (timer) clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
    // Keep the helper alive until its cancelled prompt finishes unwinding.
    if (combined.aborted) await promise?.catch(() => undefined);
  }
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}
