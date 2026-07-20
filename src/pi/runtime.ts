import fs from "node:fs/promises";
import path from "node:path";
import type { Api } from "grammy";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import { renderThreadSystemPrompt } from "../ai/prompt.js";
import type { CreatedFileAttachment, PendingCreatedFile, ToolBuildInput } from "../ai/tools/types.js";
import type { TextEmbedder } from "../memory/embeddings.js";
import type { Logger } from "../logger.js";
import { detectImageMediaType, imageMediaTypeFromName } from "../files/mediaType.js";
import { createGenerateImagePiTool, type ChatImageBridge } from "./imageExtension.js";
import { registerPiProviderRouter, type PiProviderRouter, type PiProviderStreamOverrides } from "./provider.js";
import { createPiToolAdapters, type PiToolBridge } from "./toolAdapter.js";
import type { ResolvedChatFile } from "../files/source.js";
import { chatFileIdsFromText } from "../files/contextMarker.js";
import { threadChainScope } from "../memory/retrieval.js";
import { refreshExtractedFileBytes } from "../files/ingest.js";
import {
  buildThreadTitlePrompt,
  THREAD_TITLE_SYSTEM_PROMPT,
  type ThreadTitlePromptInput,
} from "./threadTitle.js";

const MAX_CACHED_RUNTIMES = 32;

export interface PiTurnTransport {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile>;
  currentFileIds?: number[];
}

export interface PiThreadRuntime {
  session: AgentSession;
  bridge: ThreadBridge;
  lastUsedAt: number;
}

export interface PiRuntimeService {
  runtime(thread: ThreadRow, user: UserRow): Promise<PiThreadRuntime>;
  compact(thread: ThreadRow, user: UserRow): Promise<number>;
  fork(source: ThreadRow, target: ThreadRow, user: UserRow, entryId?: string | null): Promise<void>;
  captionImage(bytes: Buffer, mimeType: string, userCaption?: string): Promise<string>;
  generateThreadTitle(input: ThreadTitlePromptInput): Promise<string>;
  abort(threadId: number): Promise<boolean>;
  dispose(): Promise<void>;
}

export class PiRuntimeManager implements PiRuntimeService {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly providerRouter: PiProviderRouter;
  readonly agentDir: string;
  private readonly runtimes = new Map<number, PiThreadRuntime>();

  constructor(private readonly input: {
    config: AppConfig;
    db: AppDatabase;
    repos: Repos;
    logger: Logger;
    embedder?: TextEmbedder;
    providerStreams?: PiProviderStreamOverrides;
  }) {
    this.agentDir = path.resolve(input.config.PI_CODING_AGENT_DIR);
    this.authStorage = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    this.authStorage.setRuntimeApiKey("openrouter", input.config.OPENROUTER_API_KEY);
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.agentDir, "models.json"));
    this.providerRouter = registerPiProviderRouter({
      config: input.config,
      modelRegistry: this.modelRegistry,
      logger: input.logger,
      streams: input.providerStreams,
    });
  }

  async runtime(thread: ThreadRow, user: UserRow): Promise<PiThreadRuntime> {
    const cached = this.runtimes.get(thread.id);
    if (cached) {
      cached.bridge.user = user;
      cached.bridge.thread = thread;
      cached.lastUsedAt = Date.now();
      return cached;
    }
    const systemPrompt = await renderThreadSystemPrompt({ repos: this.input.repos, user, thread });
    const bridge = new ThreadBridge({
      ...this.input,
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
      extensionFactories: [createChatFileContextExtension(bridge)],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();
    const sessionManager = await this.openSessionManager(thread);
    const customTools = [
      ...createPiToolAdapters(bridge),
      createGenerateImagePiTool(bridge),
    ];
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
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
    });
    return runtime;
  }

  async compact(thread: ThreadRow, user: UserRow): Promise<number> {
    const runtime = await this.runtime(thread, user);
    const before = runtime.session.getSessionStats().totalMessages;
    await runtime.session.compact();
    const after = runtime.session.getSessionStats().totalMessages;
    return Math.max(0, before - after);
  }

  async fork(source: ThreadRow, target: ThreadRow, user: UserRow, entryId?: string | null): Promise<void> {
    const runtime = await this.runtime(source, user);
    const branchPoint = entryId ?? runtime.session.sessionManager.getLeafId();
    if (!branchPoint) return;
    const sessionFile = runtime.session.sessionManager.createBranchedSession(branchPoint);
    if (!sessionFile) throw new Error("Pi could not create a persistent branched session.");
    const branch = SessionManager.open(sessionFile, path.dirname(sessionFile), process.cwd());
    await this.input.repos.threads.setPiSession(target.id, sessionFile, branch.getSessionId());
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
    for (const runtime of this.runtimes.values()) runtime.session.dispose();
    this.runtimes.clear();
  }

  private async runIsolatedHelper(input: {
    systemPrompt: string;
    prompt: string;
    images?: ImageContent[];
    timeoutMs: number;
  }): Promise<string> {
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
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
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
      victim[1].session.dispose();
      this.runtimes.delete(victim[0]);
    }
  }
}

export class ThreadBridge implements PiToolBridge, ChatImageBridge {
  user: UserRow;
  thread: ThreadRow;
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly repos: Repos;
  readonly logger: Logger;
  readonly embedder?: TextEmbedder;
  readonly modelRegistry: ModelRegistry;
  readonly providerRouter: PiProviderRouter;
  attachments: CreatedFileAttachment[] = [];
  pendingCreatedFiles: PendingCreatedFile[] = [];
  private transport?: PiTurnTransport;
  private readonly turnFileCache = new Map<number, ResolvedChatFile>();
  private readonly contextFileIds = new Set<number>();
  private readonly durableContextFileIds = new Set<number>();

  constructor(input: {
    config: AppConfig;
    db: AppDatabase;
    repos: Repos;
    logger: Logger;
    embedder?: TextEmbedder;
    user: UserRow;
    thread: ThreadRow;
    modelRegistry: ModelRegistry;
    providerRouter: PiProviderRouter;
  }) {
    Object.assign(this, input);
    this.user = input.user;
    this.thread = input.thread;
    this.config = input.config;
    this.db = input.db;
    this.repos = input.repos;
    this.logger = input.logger;
    this.embedder = input.embedder;
    this.modelRegistry = input.modelRegistry;
    this.providerRouter = input.providerRouter;
  }

  beginTurn(input: PiTurnTransport): void {
    this.transport = input;
    this.attachments = [];
    this.pendingCreatedFiles = [];
    this.turnFileCache.clear();
    this.contextFileIds.clear();
    this.durableContextFileIds.clear();
    for (const fileId of input.currentFileIds ?? []) this.contextFileIds.add(fileId);
  }

  buildInput(): ToolBuildInput {
    return {
      config: this.config,
      db: this.db,
      repos: this.repos,
      user: this.user,
      thread: this.thread,
      logger: this.logger,
      embedder: this.embedder,
      resolveFile: (file, signal) => this.resolveFile(file, signal),
      selectContextFiles: (fileIds) => this.selectContextFiles(fileIds),
      selectDurableContextFiles: (fileIds) => this.selectDurableContextFiles(fileIds),
      createdFiles: this.attachments,
      pendingCreatedFiles: this.pendingCreatedFiles,
    };
  }

  async resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const cached = this.turnFileCache.get(file.id);
    if (cached) return cached;
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

function createChatFileContextExtension(bridge: ThreadBridge): InlineExtension {
  return {
    name: "chat-file-context",
    factory: (pi) => {
      pi.on("context", async (event) => {
        const messages = event.messages.map((message) => cloneMessage(message));
        const scope = await threadChainScope(bridge.repos, bridge.thread);
        const allowedIds = new Set(scope.fileIds);
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
              const needsExtractionRetry = file.type !== "image" && file.extraction_status !== "ready";
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
                    embeddings: bridge.repos.embeddings,
                    embedder: bridge.embedder,
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
  if (file.is_inline && file.content_md) {
    return { type: "text", text: `\n\n<attachment id="${file.id}" name="${file.name}">\n${file.content_md}\n</attachment>` };
  }
  return {
    type: "text",
    text: `\n\n[Attachment #${file.id} ${file.name} is indexed. ${file.summary ?? ""} Use search_in_file or read_file_section for its full extracted content.]`,
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
