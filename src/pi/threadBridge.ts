import { sha256Hex } from "../files/hash.js";

import type { Api } from "grammy";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ModelRegistry, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import { renderSystemPrompt, renderThreadSessionContext } from "../ai/prompt.js";
import type { ToolBuildInput } from "../ai/tools/types.js";
import type { CreatedFileAttachment } from "../files/types.js";
import type { Logger } from "../logger.js";
import { detectImageMediaType, imageMediaTypeFromName } from "../files/mediaType.js";
import { type ChatImageBridge } from "./imageExtension.js";
import { type PiProviderRouter } from "./provider.js";
import { type PiToolBridge } from "./toolAdapter.js";
import type { ResolvedChatFile } from "../files/source.js";
import type { CommandRuntime, PublishedWebsite, SandboxActivityLease } from "../sandbox/types.js";
import { chatFileIdsFromText } from "../files/contextMarker.js";
import { threadChainScope, threadVisibilityScope, type ThreadScope } from "../memory/retrieval.js";
import { refreshExtractedFileBytes } from "../files/ingest.js";
import { BrowserUseRuntimeManager } from "../browserUse/runtime.js";
import { type TurnPromptContextSource } from "./turnContext.js";
import { TurnBudget, type TurnBudgetSource } from "./turnBudget.js";
import { OutgoingFiles } from "../files/outgoingFiles.js";
import { OfficeValidation } from "../office/validation.js";

interface PiTurnTransport {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile>;
  currentFileIds?: number[];
  userMessageId?: number;
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
  publishedWebsites: PublishedWebsite[] = [];
  activeMessageId?: number;
  outgoingFiles: OutgoingFiles;
  readonly officeValidation: OfficeValidation;
  get attachments(): CreatedFileAttachment[] { return this.outgoingFiles.items; }
  get outgoingBuffers() { return this.outgoingFiles.buffers; }
  private visibilityScope?: ThreadScope;
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
  private responseDraft = { text: "" };

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
    this.officeValidation = new OfficeValidation({runtime: this.commandRuntime, config: this.config, userId: this.user.tg_id, threadId: this.thread.id});
    this.outgoingFiles = this.createOutgoingFiles();
  }

  private createOutgoingFiles(): OutgoingFiles {
    return new OutgoingFiles({
      config: this.config, repos: this.repos, user: this.user, thread: this.thread,
      commandRuntime: this.commandRuntime, logger: this.logger,
      officeValidation: this.officeValidation,
      selectContextFiles: (ids) => this.selectContextFiles(ids),
    });
  }

  async beginTurn(input: PiTurnTransport): Promise<void> {
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
    for (const fileId of input.currentFileIds ?? []) this.contextFileIds.add(fileId);
  }

  holdCommandActivity(): void {
    if (this.commandActivityLease || !this.commandRuntime?.acquireActivityLease) return;
    this.commandActivityLease = this.commandRuntime.acquireActivityLease(this.user.tg_id, this.thread.id);
  }

  async endTurn(): Promise<void> {
    await this.officeValidation.dispose().catch(error => {
      this.logger?.warn("Office preview cleanup failed", {threadId: this.thread.id, error: String(error)});
    });
    const lease = this.commandActivityLease;
    this.commandActivityLease = undefined;
    lease?.release();
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

export function createChatFileContextExtension(bridge: ThreadBridge): InlineExtension {
  return {
    name: "chat-file-context",
    factory: (pi) => {
      pi.on("context", async (event) => {
        const messages = event.messages.map((message) => cloneMessage(message));
        const scope = bridge.currentScope
          ? await bridge.currentScope()
          : await threadChainScope(bridge.repos, bridge.thread, bridge.activeMessageId);
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
            if (file.type === "audio") {
              injectedIds.add(file.id);
              additions.push({
                type: "text",
                text: `\n\n[Audio attachment #${file.id}. Reuse the transcript in the message when present; otherwise call transcribe_audio with file_id: ${file.id}.]`,
              });
              continue;
            }
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
    : "Call materialize_chat_files, read the docx-cli skill, and inspect it with docx.";
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
