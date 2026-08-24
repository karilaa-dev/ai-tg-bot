import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Api } from "grammy";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import { renderSystemPrompt, renderThreadSessionContext } from "../ai/prompt.js";
import type { CreatedFileAttachment, PendingCreatedFile, ToolBuildInput } from "../ai/tools/types.js";
import type { Logger } from "../logger.js";
import { detectImageMediaType, imageMediaTypeFromName } from "../files/mediaType.js";
import { createGenerateImagePiTool, type ChatImageBridge } from "./imageExtension.js";
import { registerPiProviderRouter, type PiProviderRouter, type PiProviderStreamOverrides } from "./provider.js";
import { createPiToolAdapters, type PiToolBridge } from "./toolAdapter.js";
import type { ResolvedChatFile } from "../files/source.js";
import type { CommandRuntime, PublishedWebsite, SandboxActivityLease } from "../sandbox/types.js";
import { chatFileIdsFromText } from "../files/contextMarker.js";
import { threadChainScope } from "../memory/retrieval.js";
import { refreshExtractedFileBytes } from "../files/ingest.js";
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
  createOfficeSkillReadTool,
  validateApprovedSkills,
} from "./officeSkills.js";
import { createTurnPromptContextExtension, type TurnPromptContextSource } from "./turnContext.js";
import {
  CODEX_PROVIDER_ID,
  discoverCodexCliCredentials,
  isOAuthCredential,
  resolveCodexAuthFile,
} from "./codexCliCredentials.js";
import { createTurnBudgetExtension, TurnBudget, type TurnBudgetSource } from "./turnBudget.js";

const MAX_CACHED_RUNTIMES = 32;

export interface PiTurnTransport {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile>;
  currentFileIds?: number[];
  userMessageId?: number;
}

export interface PiThreadRuntime {
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
      throw new Error(`OfficeCLI skill loading failed: ${JSON.stringify(loadedSkills.diagnostics)}`);
    }
    const expectedSkillNames = APPROVED_PI_SKILLS.map((skill) => skill.name).sort();
    const loadedSkillNames = loadedSkills.skills.map((skill) => skill.name).sort();
    if (JSON.stringify(loadedSkillNames) !== JSON.stringify(expectedSkillNames)) {
      throw new Error(`Unexpected Pi skills: expected ${expectedSkillNames.join(", ")}; loaded ${loadedSkillNames.join(", ") || "none"}.`);
    }
    const sessionManager = await this.openSessionManager(thread);
    const customTools = [
      createOfficeSkillReadTool(),
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

export class ThreadBridge implements PiToolBridge, ChatImageBridge, TurnPromptContextSource, TurnBudgetSource {
  user: UserRow;
  thread: ThreadRow;
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly repos: Repos;
  readonly logger: Logger;
  readonly commandRuntime?: CommandRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly providerRouter: PiProviderRouter;
  attachments: CreatedFileAttachment[] = [];
  pendingCreatedFiles: PendingCreatedFile[] = [];
  publishedWebsites: PublishedWebsite[] = [];
  activeMessageId?: number;
  private transport?: PiTurnTransport;
  private readonly turnFileCache = new Map<number, ResolvedChatFile>();
  private readonly contextFileIds = new Set<number>();
  private readonly durableContextFileIds = new Set<number>();
  private commandActivityLease?: SandboxActivityLease;
  private turnActive = false;
  private turnSystemPrompt?: string;
  private turnSessionContext?: string;
  private readonly browserRuntime?: BrowserUseRuntimeManager;
  private turnBudget?: TurnBudget;

  constructor(input: {
    config: AppConfig;
    db: AppDatabase;
    repos: Repos;
    logger: Logger;
    commandRuntime?: CommandRuntime;
    user: UserRow;
    thread: ThreadRow;
    modelRegistry: ModelRegistry;
    providerRouter: PiProviderRouter;
    browserRuntime?: BrowserUseRuntimeManager;
  }) {
    Object.assign(this, input);
    this.user = input.user;
    this.thread = input.thread;
    this.config = input.config;
    this.db = input.db;
    this.repos = input.repos;
    this.logger = input.logger;
    this.commandRuntime = input.commandRuntime;
    this.modelRegistry = input.modelRegistry;
    this.providerRouter = input.providerRouter;
    this.browserRuntime = input.browserRuntime;
  }

  async beginTurn(input: PiTurnTransport): Promise<void> {
    if (this.turnActive) await this.endTurn();
    const [turnSystemPrompt, turnSessionContext] = await Promise.all([
      renderSystemPrompt({ user: this.user, config: this.config }),
      renderThreadSessionContext({
        repos: this.repos,
        user: this.user,
        thread: this.thread,
        maxMessageId: input.userMessageId,
      }),
    ]);
    await this.browserRuntime?.beginTurn(this.user.tg_id, this.thread.id);
    this.turnActive = true;
    this.turnSystemPrompt = turnSystemPrompt;
    this.turnSessionContext = turnSessionContext;
    this.transport = input;
    this.activeMessageId = input.userMessageId;
    this.attachments = [];
    this.pendingCreatedFiles = [];
    this.publishedWebsites = [];
    this.turnBudget = new TurnBudget({
      maxModelCycles: this.config.PI_MAX_MODEL_CYCLES,
      maxToolCalls: this.config.PI_MAX_TOOL_CALLS,
      maxConsecutiveToolFailures: this.config.PI_MAX_CONSECUTIVE_TOOL_FAILURES,
      maxIdenticalToolFailures: this.config.PI_MAX_IDENTICAL_TOOL_FAILURES,
    });
    this.turnFileCache.clear();
    this.contextFileIds.clear();
    this.durableContextFileIds.clear();
    for (const fileId of input.currentFileIds ?? []) this.contextFileIds.add(fileId);
  }

  holdCommandActivity(): void {
    if (this.commandActivityLease || !this.commandRuntime?.acquireActivityLease) return;
    this.commandActivityLease = this.commandRuntime.acquireActivityLease(this.user.tg_id, this.thread.id);
  }

  async endTurn(): Promise<void> {
    const lease = this.commandActivityLease;
    this.commandActivityLease = undefined;
    lease?.release();
    const wasActive = this.turnActive;
    this.turnActive = false;
    this.turnSystemPrompt = undefined;
    this.turnSessionContext = undefined;
    this.transport = undefined;
    this.activeMessageId = undefined;
    if (wasActive) await this.browserRuntime?.endTurn(this.user.tg_id, this.thread.id);
  }

  currentTurnSystemPrompt(): string | undefined {
    return this.turnSystemPrompt;
  }

  currentTurnSessionContext(): string | undefined {
    return this.turnSessionContext;
  }

  currentTurnBudget(): TurnBudget | undefined {
    return this.turnBudget;
  }

  buildInput(): ToolBuildInput {
    return {
      config: this.config,
      db: this.db,
      repos: this.repos,
      user: this.user,
      thread: this.thread,
      maxMessageId: this.activeMessageId,
      logger: this.logger,
      commandRuntime: this.commandRuntime,
      browserRuntime: this.browserRuntime?.forThread(this.user.tg_id, this.thread.id),
      resolveFile: (file, signal) => this.resolveFile(file, signal),
      selectContextFiles: (fileIds) => this.selectContextFiles(fileIds),
      selectDurableContextFiles: (fileIds) => this.selectDurableContextFiles(fileIds),
      createdFiles: this.attachments,
      pendingCreatedFiles: this.pendingCreatedFiles,
      publishedWebsites: this.publishedWebsites,
      registerPublishedWebsite: (website) => {
        if (!this.publishedWebsites.some((existing) => existing.url === website.url)) {
          this.publishedWebsites.push(website);
        }
      },
    };
  }

  async resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const cached = this.turnFileCache.get(file.id);
    if (cached) return cached;
    const currentAttachment = this.attachments.find((attachment) =>
      attachment.fileId === file.id && attachment.data);
    if (currentAttachment?.data) {
      const bytes = Buffer.from(currentAttachment.data);
      const resolved: ResolvedChatFile = {
        bytes,
        mimeType: currentAttachment.mimeType ?? file.mime_type,
        size: bytes.length,
        contentSha256: file.content_sha256 ?? createHash("sha256").update(bytes).digest("hex"),
        source: {
          transport: "memory",
          connectionKey: "current-turn",
          remoteKey: String(file.id),
          locator: {},
          mimeType: currentAttachment.mimeType ?? file.mime_type,
        },
      };
      this.turnFileCache.set(file.id, resolved);
      return resolved;
    }
    if (!this.transport) throw new Error(`File #${file.id} has no active chat transport resolver.`);
    const loaded = await this.transport.resolveFile(file, signal);
    const resolved: ResolvedChatFile = {
      ...loaded,
      mimeType: file.type === "image"
        ? detectImageMediaType(loaded.bytes) ?? loaded.mimeType ?? imageMediaTypeFromName(file.name) ?? "image/jpeg"
        : loaded.mimeType,
    };
    this.turnFileCache.set(file.id, resolved);
    return resolved;
  }

  async resolveImage(file: FileRow, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
    const resolved = await this.resolveFile(file, signal);
    return { bytes: resolved.bytes, mimeType: resolved.mimeType ?? "image/jpeg" };
  }

  selectContextFiles(fileIds: number[]): void {
    for (const fileId of fileIds) this.contextFileIds.add(fileId);
  }

  selectDurableContextFiles(fileIds: number[]): void {
    for (const fileId of fileIds) {
      this.contextFileIds.add(fileId);
      this.durableContextFileIds.add(fileId);
    }
  }

  selectedContextFileIds(): ReadonlySet<number> {
    return this.contextFileIds;
  }

  selectedDurableContextFileIds(): ReadonlySet<number> {
    return this.durableContextFileIds;
  }
}

export function createChatFileContextExtension(bridge: ThreadBridge): InlineExtension {
  return {
    name: "chat-file-context",
    factory: (pi) => {
      pi.on("context", async (event) => {
        const messages = event.messages.map((message) => cloneMessage(message));
        const scope = await threadChainScope(bridge.repos, bridge.thread, bridge.activeMessageId);
        const allowedIds = new Set([
          ...scope.fileIds,
          ...bridge.attachments.map((attachment) => attachment.fileId),
        ]);
        let changed = false;
        const injectedIds = new Set<number>();
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (!message || (message.role !== "user" && message.role !== "toolResult")) continue;
          const textParts = messageTextParts(message);
          const fileIds = [...new Set(textParts.flatMap((part) => chatFileIdsFromText(part.text)))]
            .filter((id) => allowedIds.has(id)
              && bridge.selectedContextFileIds().has(id)
              && !injectedIds.has(id));
          if (!fileIds.length) continue;
          const rows = await bridge.repos.files.listByIds(fileIds);
          const byId = new Map(rows.map((file) => [file.id, file]));
          const additions: Array<TextContent | ImageContent> = [];
          for (const fileId of fileIds) {
            let file = byId.get(fileId);
            if (!file) continue;
            if (file.type === "pdf" || file.type === "docx") {
              injectedIds.add(file.id);
              additions.push(sandboxDocumentContext(file));
              continue;
            }
            if (file.is_inline && file.content_md && containsInlineAttachment(textParts, file.id)) {
              injectedIds.add(file.id);
              continue;
            }
            if (file.type !== "image"
              && file.type !== "other"
              && file.extraction_status === "ready"
              && bridge.selectedDurableContextFileIds().has(file.id)) {
              injectedIds.add(file.id);
              additions.push(durableDocumentContext(file));
              continue;
            }
            try {
              injectedIds.add(fileId);
              const resolved = await bridge.resolveFile(file);
              const contentChanged = Boolean(resolved.contentSha256
                && file.content_sha256 !== resolved.contentSha256);
              const needsExtractionRetry = file.type !== "image"
                && file.extraction_status !== "ready"
                && file.extraction_status !== "source_only";
              if (contentChanged || needsExtractionRetry) {
                bridge.logger.warn(contentChanged ? "chat file content hash changed" : "chat file extraction retrying", {
                  fileId: file.id,
                  threadId: bridge.thread.id,
                  extractionStatus: file.extraction_status,
                });
                try {
                  file = await refreshExtractedFileBytes({
                    config: bridge.config,
                    repo: bridge.repos.files,
                    file,
                    bytes: resolved.bytes,
                    mime: resolved.mimeType,
                    logger: bridge.logger,
                  });
                } catch (error) {
                  bridge.logger.warn("chat file extracted content refresh failed", {
                    fileId: file.id,
                    threadId: bridge.thread.id,
                    error: String(error),
                  });
                  additions.push({
                    type: "text",
                    text: `\n\n[Attachment #${file.id} could not be refreshed from its chat source.]`,
                  });
                  continue;
                }
              }
              if (file.type === "image") {
                additions.push({
                  type: "image",
                  data: resolved.bytes.toString("base64"),
                  mimeType: resolved.mimeType ?? "image/jpeg",
                });
              } else {
                additions.push(durableDocumentContext(file));
              }
            } catch (error) {
              bridge.logger.warn("chat file context materialization failed", {
                fileId: file.id,
                threadId: bridge.thread.id,
                error: String(error),
              });
              additions.push(file.type !== "image" && file.extraction_status === "ready"
                ? durableDocumentContext(file)
                : { type: "text", text: `\n\n[Attachment #${file.id} is currently unavailable from its chat source.]` });
            }
          }
          if (!additions.length) continue;
          messages[index] = appendMessageContent(message, additions);
          changed = true;
        }
        return changed ? { messages } : undefined;
      });
    },
  };
}

function durableDocumentContext(file: FileRow): TextContent {
  if (file.extraction_status === "source_only") return sandboxDocumentContext(file);
  if (file.is_inline && file.content_md) {
    return { type: "text", text: `\n\n<attachment id="${file.id}" name="${file.name}">\n${file.content_md}\n</attachment>` };
  }
  return {
    type: "text",
    text: `\n\n[Attachment #${file.id} ${file.name} is indexed. ${file.summary ?? ""} Use search_in_file or read_file_section for its full extracted content.]`,
  };
}

function sandboxDocumentContext(file: FileRow): TextContent {
  const next = file.type === "pdf"
    ? "Call materialize_chat_files, then use pdf-inspector for native text or render_pdf_pages for vision."
    : "Call materialize_chat_files, read the OfficeCLI DOCX skill, and inspect it with officecli.";
  const fallback = file.extraction_status === "ready"
    ? " If the original source cannot be restored, use search_in_file/read_file_section as a legacy extracted-text fallback."
    : "";
  return {
    type: "text",
    text: `\n\n[Attachment #${file.id} ${file.name} should be inspected in the sandbox. ${next}${fallback}]`,
  };
}

function containsInlineAttachment(parts: TextContent[], fileId: number): boolean {
  return parts.some((part) => part.text.includes(`<attachment id="${fileId}"`));
}

function messageTextParts(message: AgentMessage): TextContent[] {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content.filter((part): part is TextContent => part.type === "text");
  }
  if (message.role === "toolResult") return message.content.filter((part): part is TextContent => part.type === "text");
  return [];
}

function appendMessageContent(
  message: AgentMessage,
  additions: Array<TextContent | ImageContent>,
): AgentMessage {
  if (message.role === "user") {
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return { ...message, content: [...content, ...additions] };
  }
  if (message.role === "toolResult") return { ...message, content: [...message.content, ...additions] };
  return message;
}

function cloneMessage(message: AgentMessage): AgentMessage {
  if (message.role === "user") {
    return {
      ...message,
      content: typeof message.content === "string" ? message.content : [...message.content],
    };
  }
  if (message.role === "toolResult") return { ...message, content: [...message.content] };
  return { ...message };
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
