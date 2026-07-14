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
import { createGenerateImagePiTool, type TelegramImageBridge } from "./imageExtension.js";
import { registerPiProviderRouter, type PiProviderRouter, type PiProviderStreamOverrides } from "./provider.js";
import { createPiToolAdapters, type PiToolBridge } from "./toolAdapter.js";

const MAX_CACHED_RUNTIMES = 32;

export interface PiTurnTransport {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  redownloadFile(file: FileRow, signal?: AbortSignal): Promise<Buffer>;
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
      extensionFactories: [createTelegramImageContextExtension(bridge)],
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
      systemPrompt: "Describe the supplied image accurately in one compact paragraph for durable conversation memory. Mention visible text and details likely to matter later. Return only the description.",
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
      const prompt = userCaption?.trim()
        ? `Describe this image. The Telegram caption was: ${userCaption.trim()}`
        : "Describe this image for later conversation recall.";
      await withSessionTimeout(
        session,
        session.prompt(prompt, {
          images: [{ type: "image", data: bytes.toString("base64"), mimeType }],
          expandPromptTemplates: false,
          source: "extension",
        }),
        this.input.config.PI_TURN_TIMEOUT_MS,
      );
      return lastAssistantText(session.messages).trim();
    } finally {
      session.dispose();
    }
  }

  async dispose(): Promise<void> {
    for (const runtime of this.runtimes.values()) runtime.session.dispose();
    this.runtimes.clear();
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

export class ThreadBridge implements PiToolBridge, TelegramImageBridge {
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
  private readonly stagedImageIds = new Set<number>();
  private readonly turnImageCache = new Map<number, ImageContent>();

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
    this.stagedImageIds.clear();
    this.turnImageCache.clear();
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
      redownloadFile: async (file) => (await this.resolveImage(file)).bytes,
      createdFiles: this.attachments,
      pendingCreatedFiles: this.pendingCreatedFiles,
    };
  }

  stageImages(fileIds: number[]): void {
    for (const fileId of fileIds) this.stagedImageIds.add(fileId);
  }

  async takeStagedImages(): Promise<ImageContent[]> {
    const ids = [...this.stagedImageIds];
    const missingIds = ids.filter((id) => !this.turnImageCache.has(id));
    const files = await this.repos.files.listByIds(missingIds);
    const byId = new Map(files.map((file) => [file.id, file]));
    for (const id of missingIds) {
      const file = byId.get(id);
      if (!file || file.type !== "image") continue;
      const resolved = await this.resolveImage(file);
      this.turnImageCache.set(id, { type: "image", data: resolved.bytes.toString("base64"), mimeType: resolved.mimeType });
    }
    return ids.flatMap((id) => {
      const image = this.turnImageCache.get(id);
      return image ? [image] : [];
    });
  }

  async resolveImage(file: FileRow, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
    let bytes: Buffer;
    if (file.telegram_file_id && this.transport) {
      bytes = await this.transport.redownloadFile(file, signal);
    } else if (file.telegram_file_id) {
      throw new Error(`Image #${file.id} has no active Telegram transport for redownload.`);
    } else if (file.path) {
      bytes = await fs.readFile(file.path);
    } else {
      throw new Error(`Image #${file.id} has no Telegram file_id.`);
    }
    const mimeType = detectImageMediaType(bytes) ?? imageMediaTypeFromName(file.name) ?? "image/jpeg";
    return { bytes, mimeType };
  }
}

function createTelegramImageContextExtension(bridge: ThreadBridge): InlineExtension {
  return {
    name: "telegram-image-context",
    factory: (pi) => {
      pi.on("context", async (event) => {
        const images = await bridge.takeStagedImages();
        if (!images.length) return;
        const messages = event.messages.map((message) => cloneMessage(message));
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message?.role !== "user") continue;
          const textParts: TextContent[] = typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.filter((part): part is TextContent => part.type === "text");
          messages[index] = { ...message, content: [...textParts, ...images] };
          return { messages };
        }
        throw new Error("Telegram image context could not find a user message for transient injection.");
      });
    },
  };
}

function cloneMessage(message: AgentMessage): AgentMessage {
  if (message.role === "user") {
    return {
      ...message,
      content: typeof message.content === "string" ? message.content : [...message.content],
    };
  }
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
