import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { ThreadBridge, createChatFileContextExtension } from "./threadBridge.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, readStoredCredential, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
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
  discoverCodexCliCredentials,
  isOAuthCredential,
  resolveCodexAuthFile,
} from "./codexCliCredentials.js";
import { createTurnBudgetExtension } from "./turnBudget.js";

const MAX_CACHED_RUNTIMES = 32;

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
  captionImage(bytes: Buffer, mimeType: string, userCaption?: string): Promise<string>;
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
    const cliCredentials = isOAuthCredential(piCodexCredential)
      ? undefined
      : await discoverCodexCliCredentials({
          authFile: resolveCodexAuthFile(this.input.config),
          onPersistenceError: (errorCode) => {
            this.input.logger.warn(
              "Codex OAuth refresh could not be persisted; continuing with the refreshed in-memory credential",
              { errorCode },
            );
          },
        });
    this.modelRuntime = await ModelRuntime.create({
      ...(cliCredentials?.store ? { credentials: cliCredentials.store } : { authPath: piAuthPath }),
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
        : cliCredentials?.status === "available"
          ? "codex-cli"
          : "none",
    });
    if (!codexConfigured) {
      this.input.logger.warn("Codex OAuth is unavailable; Pi inference will use OpenRouter until Codex is configured", {
        codexCredentialStatus: cliCredentials?.status ?? "missing",
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

  async runtime(thread: ThreadRow, user: UserRow): Promise<PiThreadRuntime> {
    await this.initialize();
    const cached = this.runtimes.get(thread.id);
    if (cached) {
      cached.bridge.user = user;
      cached.bridge.thread = thread;
      cached.lastUsedAt = Date.now();
      return cached;
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
        createFinishResponseGuard(),
        createTurnBudgetExtension(bridge),
        createTurnPromptContextExtension(bridge),
        createChatFileContextExtension(bridge),
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
    const sessionManager = await this.openSessionManager(thread);
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
    const before = runtime.session.getSessionStats().totalMessages;
    const compaction = runtime.session.compact();
    const onAbort = () => runtime.session.abortCompaction();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      await compaction;
      signal?.throwIfAborted();
      const after = runtime.session.getSessionStats().totalMessages;
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
    const branchPoint = entryId ?? runtime.session.sessionManager.getLeafId();
    if (!branchPoint) return;
    const sessionFile = runtime.session.sessionManager.createBranchedSession(branchPoint);
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

  async captionImage(bytes: Buffer, mimeType: string, userCaption?: string): Promise<string> {
    const prompt = userCaption?.trim()
      ? `Describe this image. The Telegram caption was: ${userCaption.trim()}`
      : "Describe this image for later conversation recall.";
    return this.runIsolatedHelper({
      systemPrompt: "Describe the supplied image accurately in one compact paragraph for durable conversation memory. Mention visible text and details likely to matter later. Return only the description.",
      prompt,
      images: [{ type: "image", data: bytes.toString("base64"), mimeType }],
      timeoutMs: this.input.config.PI_TURN_TIMEOUT_MS,
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
  }): Promise<string> {
    await this.initialize();
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
        session.prompt(input.prompt, {
          images: input.images,
          expandPromptTemplates: false,
          source: "extension",
        }),
        input.timeoutMs,
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

function normalizeThinkingLevel(level: AppConfig["PI_THINKING_LEVEL"]): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return level === "off" ? "minimal" : level;
}

async function withSessionTimeout<T>(session: AgentSession, promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void session.abort().catch(() => undefined);
          reject(new Error(`Pi turn timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
