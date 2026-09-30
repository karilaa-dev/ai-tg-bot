import { sha256Hex } from "../files/hash.js";

import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import { renderSystemPrompt, renderThreadSessionContext } from "../ai/prompt.js";
import type { ToolBuildInput } from "../ai/tools/types.js";
import type { CreatedFileAttachment } from "../files/types.js";
import type { Logger } from "../logger.js";
import { detectImageMediaType, imageMediaTypeFromName } from "../files/mediaType.js";
import type { ResolvedChatFile } from "../files/source.js";
import type { CommandRuntime, PublishedWebsite, SandboxActivityLease } from "../sandbox/types.js";
import { threadVisibilityScope, type ThreadScope } from "../memory/retrieval.js";
import { BrowserUseRuntimeManager } from "../browserUse/runtime.js";
import { TurnBudget } from "../ai/turnBudget.js";
import { OutgoingFiles } from "../files/outgoingFiles.js";
import { OfficeValidation } from "../office/validation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { resolveThreadFileDescriptors } from "../e2b/threadFiles.js";
import type { LocalArtifactOperation, LocalArtifactResult } from "./lazyExecutor.js";

interface TurnTransport {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile>;
  currentFileIds?: number[];
  userMessageId?: number;
}

export class ThreadBridge {
  user: UserRow;
  thread: ThreadRow;
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly repos: Repos;
  readonly logger: Logger;
  readonly commandRuntime?: CommandRuntime;
  publishedWebsites: PublishedWebsite[] = [];
  activeMessageId?: number;
  outgoingFiles: OutgoingFiles;
  readonly officeValidation: OfficeValidation;
  get attachments(): CreatedFileAttachment[] { return this.outgoingFiles.items; }
  get outgoingBuffers() { return this.outgoingFiles.buffers; }
  private visibilityScope?: ThreadScope;
  private transport?: TurnTransport;
  private readonly turnFileCache = new Map<number, ResolvedChatFile>();
  private readonly contextFileIds = new Set<number>();
  private readonly durableContextFileIds = new Set<number>();
  private commandActivityLease?: SandboxActivityLease;
  private nativeActivityLease?: SandboxActivityLease;
  private turnActive = false;
  private turnSystemPrompt?: string;
  private turnSessionContext?: string;
  private readonly browserRuntime?: BrowserUseRuntimeManager;
  private turnBudget?: TurnBudget;
  private responseDraft = { text: "" };
  private readonly nativeArtifacts = new Set<string>();
  private filePreparation?: Promise<void>;

  constructor(input: {
    config: AppConfig;
    db: AppDatabase;
    repos: Repos;
    logger: Logger;
    commandRuntime?: CommandRuntime;
    user: UserRow;
    thread: ThreadRow;
    browserRuntime?: BrowserUseRuntimeManager;
  }) {
    this.user = input.user;
    this.thread = input.thread;
    this.config = input.config;
    this.db = input.db;
    this.repos = input.repos;
    this.logger = input.logger;
    this.commandRuntime = input.commandRuntime;
    this.browserRuntime = input.browserRuntime;
    this.officeValidation = new OfficeValidation({runtime: this.commandRuntime, config: this.config, userId: this.user.tg_id, threadId: this.thread.id});
    this.outgoingFiles = this.createOutgoingFiles();
  }

  private createOutgoingFiles(): OutgoingFiles {
    return new OutgoingFiles({
      config: this.config, repos: this.repos, user: this.user, thread: this.thread,
      commandRuntime: this.commandRuntime, logger: this.logger,
      officeValidation: this.officeValidation,
      selectContextFiles: (ids) => this.selectContextFiles(ids),
      isNativeArtifact: (filePath) => this.nativeArtifacts.has(filePath),
      readNativeArtifact: (filePath, signal) => this.readNativeArtifact(filePath, signal),
    });
  }

  async beginTurn(input: TurnTransport): Promise<void> {
    if (this.turnActive) await this.endTurn();
    this.officeValidation.clear();
    this.visibilityScope = await threadVisibilityScope(this.repos, this.thread, input.userMessageId);
    this.visibilityScope.fileIds = [...new Set([...this.visibilityScope.fileIds, ...(input.currentFileIds ?? [])])];
    const fileIds = await this.repos.files.listRecoverableIds(this.visibilityScope.fileIds);
    const [turnSystemPrompt, turnSessionContext] = await Promise.all([
      renderSystemPrompt({ user: this.user, config: this.config }),
      renderThreadSessionContext({
        repos: this.repos,
        user: this.user,
        thread: this.thread,
        maxMessageId: input.userMessageId,
        fileIds,
      }),
    ]);
    await this.browserRuntime?.beginTurn(this.user.tg_id, this.thread.id);
    this.turnActive = true;
    this.turnSystemPrompt = turnSystemPrompt;
    this.turnSessionContext = turnSessionContext;
    this.transport = input;
    this.activeMessageId = input.userMessageId;
    this.outgoingFiles = this.createOutgoingFiles();
    this.publishedWebsites = [];
    this.responseDraft = { text: "" };
    this.turnBudget = new TurnBudget({
      maxModelCycles: this.config.PI_MAX_MODEL_CYCLES,
      maxToolCalls: this.config.PI_MAX_TOOL_CALLS,
      maxConsecutiveToolFailures: this.config.PI_MAX_CONSECUTIVE_TOOL_FAILURES,
      maxIdenticalToolFailures: this.config.PI_MAX_IDENTICAL_TOOL_FAILURES,
    });
    this.turnFileCache.clear();
    this.contextFileIds.clear();
    this.durableContextFileIds.clear();
    this.filePreparation = undefined;
    for (const fileId of input.currentFileIds ?? []) this.contextFileIds.add(fileId);
  }

  holdCommandActivity(native = false): void {
    if (!this.commandRuntime?.acquireActivityLease) return;
    if (native) {
      this.nativeActivityLease ??= this.commandRuntime.acquireActivityLease(this.user.tg_id, this.thread.id, { native: true });
      return;
    }
    if (this.commandActivityLease || this.nativeActivityLease) return;
    this.commandActivityLease = this.commandRuntime.acquireActivityLease(this.user.tg_id, this.thread.id);
  }

  async prepareCommandFiles(signal?: AbortSignal): Promise<void> {
    this.holdCommandActivity();
    if (!this.commandRuntime) throw new Error("E2B command runtime is unavailable.");
    this.filePreparation ??= (async () => {
      const files = await resolveThreadFileDescriptors(this.buildInput(), signal);
      await this.commandRuntime!.materializeFiles({ userId: this.user.tg_id, threadId: this.thread.id, files, signal });
    })().catch(error => { this.filePreparation = undefined; throw error; });
    await this.filePreparation;
  }

  registerNativeArtifact(filePath: string): void {
    const root = path.resolve(this.config.CODEX_HOME, "generated_images");
    const requested = path.resolve(filePath);
    const relative = path.relative(root, requested);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Generated image path is outside Codex's artifact directory.");
    }
    this.nativeArtifacts.add(requested);
  }

  isNativeArtifact(filePath: string): boolean { return this.nativeArtifacts.has(filePath); }

  async resolveLocalArtifact(fileUrl: string, operation: LocalArtifactOperation, signal: AbortSignal): Promise<LocalArtifactResult | undefined> {
    let filePath: string;
    try { filePath = fileURLToPath(fileUrl); } catch { return; }
    if (!this.nativeArtifacts.has(filePath)) return;
    if (operation === "fs/readFile") return { dataBase64: (await this.readNativeArtifact(filePath, signal)).bytes.toString("base64") };
    const stat = await this.nativeArtifactStat(filePath, signal);
    return { isDirectory: false, isFile: true, isSymlink: false, size: stat.size, createdAtMs: Math.trunc(stat.birthtimeMs), modifiedAtMs: Math.trunc(stat.mtimeMs) };
  }

  async nativeArtifactFiles(signal?: AbortSignal): Promise<Array<{ path: string; bytes: Buffer }>> {
    const artifacts: Array<{ path: string; bytes: Buffer }> = [];
    for (const filePath of this.nativeArtifacts) {
      const file = await this.readNativeArtifact(filePath, signal);
      artifacts.push({ path: filePath, bytes: file.bytes });
    }
    return artifacts;
  }

  private async readNativeArtifact(filePath: string, signal?: AbortSignal): Promise<{ bytes: Buffer; name: string; mime: string }> {
    await this.nativeArtifactStat(filePath, signal);
    const bytes = await fs.readFile(filePath, { signal });
    signal?.throwIfAborted();
    if (bytes.length > MAX_FILE_BYTES) throw new Error("Generated image exceeds the file delivery limit.");
    return { bytes, name: path.basename(filePath), mime: detectImageMediaType(bytes) ?? "image/png" };
  }

  private async nativeArtifactStat(filePath: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.nativeArtifacts.has(filePath)) throw new Error("Unknown generated image path.");
    const canonical = await fs.realpath(filePath);
    if (canonical !== filePath) throw new Error("Generated image path must not be a symbolic link.");
    const stat = await fs.stat(canonical);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Generated image exceeds the file delivery limit.");
    signal?.throwIfAborted();
    return stat;
  }

  async endTurn(): Promise<void> {
    await this.officeValidation.dispose().catch(error => {
      this.logger?.warn("Office preview cleanup failed", {threadId: this.thread.id, error: String(error)});
    });
    const lease = this.commandActivityLease;
    const nativeLease = this.nativeActivityLease;
    this.commandActivityLease = undefined;
    this.nativeActivityLease = undefined;
    lease?.release();
    nativeLease?.release();
    const wasActive = this.turnActive;
    this.turnActive = false;
    this.turnSystemPrompt = undefined;
    this.turnSessionContext = undefined;
    this.transport = undefined;
    this.activeMessageId = undefined;
    this.visibilityScope = undefined;
    this.turnFileCache.clear();
    this.responseDraft.text = "";
    await this.outgoingFiles?.dispose();
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
      currentScope: () => this.currentScope(),
      outgoingFiles: this.outgoingFiles,
      officeValidation: this.officeValidation,
      responseDraft: this.responseDraft,
      logger: this.logger,
      commandRuntime: this.commandRuntime,
      browserRuntime: this.browserRuntime?.forThread(this.user.tg_id, this.thread.id),
      resolveFile: (file, signal) => this.resolveFile(file, signal),
      selectContextFiles: (fileIds) => this.selectContextFiles(fileIds),
      selectDurableContextFiles: (fileIds) => this.selectDurableContextFiles(fileIds),
      publishedWebsites: this.publishedWebsites,
      registerPublishedWebsite: (website) => {
        if (!this.publishedWebsites.some((existing) => existing.url === website.url)) {
          this.publishedWebsites.push(website);
        }
      },
    };
  }

  async currentScope(): Promise<ThreadScope> {
    const scope = this.visibilityScope ?? await threadVisibilityScope(this.repos, this.thread, this.activeMessageId);
    // Visibility is fixed at acceptance; source recoverability is checked live.
    const fileIds = await this.repos.files.listRecoverableIds(scope.fileIds);
    return { ...scope, fileIds: [...new Set([...fileIds, ...this.attachments.map((file) => file.fileId)])] };
  }

  async resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const cached = this.turnFileCache.get(file.id);
    if (cached) return cached;
    const currentAttachment = this.attachments.find((attachment) => attachment.fileId === file.id);
    const currentBytes = currentAttachment?.data ?? (currentAttachment ? await this.outgoingBuffers.readSpool(currentAttachment, signal) : undefined);
    if (currentAttachment && currentBytes) {
      const bytes = currentBytes;
      const resolved: ResolvedChatFile = {
        bytes,
        mimeType: currentAttachment.mimeType ?? file.mime_type,
        size: bytes.length,
        contentSha256: file.content_sha256 ?? sha256Hex(bytes),
        source: {
          transport: "memory",
          connectionKey: "current-turn",
          remoteKey: String(file.id),
          locator: {},
          mimeType: currentAttachment.mimeType ?? file.mime_type,
        },
      };
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
