import { InputFile, type Api } from "grammy";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { MessageKind, MessageRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { DraftStreamer } from "../telegram/draftStreamer.js";
import { renderFinal, variantsForRichRetry } from "../telegram/render.js";
import {
  isRichParseError,
  isThreadNotFound,
  prefixPlainForThreadFallback,
  prefixRichForThreadFallback,
  sendRich,
  withThreadNotFoundFallback,
  type InputRichMessage,
} from "../telegram/richApi.js";
import { MAX_CREATED_FILES_PER_ANSWER } from "../files/limits.js";
import { StreamShaper, type ToolCallMetadata } from "./shaper.js";
import type { FileRow } from "../db/types.js";
import type { CreatedFileAttachment, PendingCreatedFile } from "./tools/index.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import { renderThreadSystemPrompt } from "./prompt.js";
import { asRecord, safeJson } from "../util/records.js";
import { escapeHtml } from "../util/text.js";
import type { ResolvedChatFile } from "../files/source.js";
import { telegramFileSource } from "../files/telegramSource.js";

const TYPING_ACTION_INTERVAL_MS = 5000;
const TG_CAPTION_LIMIT = 1024;
const TG_MESSAGE_LIMIT = 4096;
const MIN_SPLIT_RATIO = 0.5;

export interface TurnInput {
  api: Api;
  chatId: number;
  messageThreadId?: number;
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  logger: Logger;
  user: UserRow;
  thread: ThreadRow;
  text: string;
  userMessageKind?: MessageKind;
  userMessageContent?: unknown;
  onUserMessagePersisted?: (message: MessageRow) => Promise<void>;
  resolveFile?: (file: FileRow, signal?: AbortSignal) => Promise<ResolvedChatFile>;
  pi?: Pick<PiRuntimeService, "runtime">;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export type TurnRunner = (input: TurnInput) => Promise<void>;

export const runTurn: TurnRunner = async (input) => {
  const startedAt = Date.now();
  input.logger.info("turn starting", {
    threadId: input.thread.id,
    userId: input.user.tg_id,
    kind: input.userMessageKind ?? "text",
    textChars: input.text.length,
    streamMode: input.user.stream_mode,
  });
  const shaper = new StreamShaper();
  const { streamer, status, stop } = createTurnPresenter(input, startedAt);
  let generatedImageDelivered = false;

  const piEntries: Array<{ id: string; role: "user" | "assistant" }> = [];
  try {
    if (!input.pi) throw new Error("Pi runtime is not configured.");
    const userMessage = await resolveTurnUserMessage(input);
    const currentFiles = userMessage ? await input.repos.files.listForMessage(userMessage.id) : [];
    const runtime = await input.pi.runtime(input.thread, input.user);
    runtime.bridge.beginTurn({
      api: input.api,
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      resolveFile: async (file, signal) => {
        if (!input.resolveFile) throw new Error("Chat file resolution is unavailable.");
        return input.resolveFile(file, signal);
      },
      currentFileIds: currentFiles.map((file) => file.id),
    });
    runtime.session.agent.state.systemPrompt = await renderThreadSystemPrompt({
      repos: input.repos,
      user: input.user,
      thread: input.thread,
    });
    await status?.start(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
    input.logger.info("Pi turn starting", {
      threadId: input.thread.id,
      model: runtime.session.model?.id,
      sessionId: runtime.session.sessionId,
    });
    streamer?.update({ thinkingMd: "", answerMd: "" });
    const stats = createPiStreamLoop(input, shaper, streamer, status);
    const existingEntryIds = new Set(runtime.session.sessionManager.getEntries().map((entry) => entry.id));
    const unsubscribe = runtime.session.subscribe(stats.onEvent);
    try {
      await runPiPromptWithTimeout(runtime.session, input.text, input.config.PI_TURN_TIMEOUT_MS);
    } finally {
      unsubscribe();
      piEntries.push(...runtime.session.sessionManager.getEntries().flatMap((entry) => {
        if (existingEntryIds.has(entry.id) || entry.type !== "message") return [];
        const role = entry.message.role;
        return role === "user" || role === "assistant" ? [{ id: entry.id, role }] : [];
      }));
      const userEntry = piEntries.find((entry) => entry.role === "user");
      if (userMessage && userEntry) {
        await input.repos.messages.setPiEntryId(userMessage.id, userEntry.id).catch((err) => {
          input.logger.warn("failed to persist Pi entry id for user message", {
            threadId: input.thread.id,
            messageId: userMessage.id,
            err: String(err),
          });
        });
      }
    }
    input.logger.debug("Pi turn complete", {
      threadId: input.thread.id,
      contentEvents: stats.counts.contentEvents,
      toolCalls: stats.counts.toolCalls,
      toolResults: stats.counts.toolResults,
    });
    const pendingFileError = await waitForPendingCreatedFiles(input, runtime.bridge.pendingCreatedFiles);
    const generateImageToolError = pendingFileError ?? stats.counts.generateImageToolError;
    const answer = lastAssistantText(runtime.session.messages) || shaper.finalAnswer();
    if (lastAssistantStopReason(runtime.session.messages) === "aborted") {
      await status?.finish(shaper.toolStatusMd());
      await streamer?.finish();
      input.logger.info("Pi turn cancelled", { threadId: input.thread.id });
      return;
    }
    const assistantError = lastAssistantError(runtime.session.messages);
    if (assistantError && !answer.trim()) throw new Error(assistantError);
    const createdFiles = runtime.bridge.attachments;
    const hasGeneratedImage = createdFiles.some((file) => file.origin === "generated_image");
    if (stats.counts.generateImageToolCalls > 0 && !hasGeneratedImage) {
      throw new Error(`Image generation failed${generateImageToolError ? `: ${generateImageToolError}` : ": no image attachment was produced"}`);
    }
    const finalText = normalizeGeneratedImageFinalText(input.t, hasGeneratedImage ? "" : answer, hasGeneratedImage);
    let finalAnswer = finalText.answer;
    if (!finalAnswer.trim() && !(hasGeneratedImage && createdFiles.length)) {
      input.logger.warn("turn produced empty final answer", {
        threadId: input.thread.id,
        userId: input.user.tg_id,
        toolStatus: shaper.toolStatusMd(),
      });
      finalAnswer = input.t("empty-answer");
    }
    const finalThinking = buildFinalThinkingSummary({
      t: input.t,
      shaper,
      attachments: createdFiles,
      extraReasoning: finalText.demotedReasoning ? [finalText.demotedReasoning] : [],
    });
    if (hasGeneratedImage) {
      const delivered = await sendGeneratedImageAttachmentsEarly(input, createdFiles);
      generatedImageDelivered = delivered > 0;
      streamer?.stop();
      input.logger.info("generated image delivered after tool completion", {
        threadId: input.thread.id,
        images: delivered,
        postToolDeliveryMs: stats.counts.generateImageReadyAt
          ? Math.max(0, Date.now() - stats.counts.generateImageReadyAt)
          : undefined,
      });
    } else {
      await streamer?.finish({ thinkingMd: finalThinking, answerMd: finalAnswer });
    }
    const assistantEntry = [...piEntries].reverse().find((entry) => entry.role === "assistant");
    await sendFinalVisible(input, finalThinking, finalAnswer, Date.now() - startedAt, createdFiles, assistantEntry?.id);
    await status?.finish(shaper.toolStatusMd());
    input.logger.info("turn complete", {
      threadId: input.thread.id,
      answerChars: finalAnswer.length,
      thinkingChars: finalThinking.length,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    input.logger.error("turn failed", { threadId: input.thread.id, err: String(err), ms: Date.now() - startedAt });
    if (generatedImageDelivered) {
      streamer?.stop();
      await status?.finish(shaper.toolStatusMd());
      input.logger.warn("turn finalization failed after generated image delivery; suppressing misleading error reply", {
        threadId: input.thread.id,
        err: String(err),
      });
      return;
    }
    await status?.finish(shaper.toolStatusMd());
    await streamer?.finish();
    await sendFinal(input, "", `${input.t("error-generic")}\n\n<details><summary>Error</summary>\n\n${String(err)}\n\n</details>`);
  } finally {
    stop();
  }
};

async function runPiPromptWithTimeout(
  session: Awaited<ReturnType<PiRuntimeService["runtime"]>>["session"],
  text: string,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return session.prompt(text, { expandPromptTemplates: false, source: "extension" });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.prompt(text, { expandPromptTemplates: false, source: "extension" }),
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
    return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
  }
  return "";
}

function lastAssistantError(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.errorMessage;
  }
  return undefined;
}

function lastAssistantStopReason(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

interface TurnPresenter {
  streamer: DraftStreamer | undefined;
  status: TurnStatusMessage | undefined;
  stop: () => void;
}

function createTurnPresenter(input: TurnInput, startedAt: number): TurnPresenter {
  const streamer = input.user.stream_mode
    ? new DraftStreamer({
        api: input.api,
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        threadTitle: input.thread.title,
        startedAt,
        updateMs: input.config.DRAFT_UPDATE_MS,
        t: input.t,
      })
    : undefined;
  const status = streamer ? undefined : new TurnStatusMessage(input);
  input.logger.debug("turn response mode selected", {
    threadId: input.thread.id,
    streamMode: Boolean(streamer),
    statusMessage: Boolean(status),
  });
  let typingThreadId = input.messageThreadId;
  let typing: NodeJS.Timeout | undefined;
  if (!streamer) {
    typing = setInterval(() => {
      void input.api.sendChatAction(input.chatId, "typing", { message_thread_id: typingThreadId }).catch((err) => {
        if (typingThreadId && isThreadNotFound(err)) {
          input.logger.warn("telegram topic send failed; retrying typing action without message_thread_id", {
            threadId: input.thread.id,
            topicId: typingThreadId,
          });
          typingThreadId = undefined;
        }
      });
    }, TYPING_ACTION_INTERVAL_MS);
  }
  return {
    streamer,
    status,
    stop: () => {
      streamer?.stop();
      if (typing) clearInterval(typing);
    },
  };
}

interface TurnStreamStats {
  contentEvents: number;
  toolCalls: number;
  toolResults: number;
  generateImageToolCalls: number;
  generateImageToolError: string | undefined;
  generateImageReadyAt: number | undefined;
}

function createPiStreamLoop(
  input: TurnInput,
  shaper: StreamShaper,
  streamer: DraftStreamer | undefined,
  status: TurnStatusMessage | undefined,
): { counts: TurnStreamStats; onEvent: (event: AgentSessionEvent) => void } {
  const counts: TurnStreamStats = {
    contentEvents: 0,
    toolCalls: 0,
    toolResults: 0,
    generateImageToolCalls: 0,
    generateImageToolError: undefined,
    generateImageReadyAt: undefined,
  };
  const updatePresenter = () => {
    streamer?.update({
      thinkingMd: shaper.streamingThinkingMd(),
      answerMd: draftAnswerWhileGeneratingImage(shaper.visibleAnswer(), counts.generateImageToolCalls > 0),
    });
  };
  const updateStatus = () => {
    void status?.update(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd())).catch((err) =>
      input.logger.warn("status update failed", { threadId: input.thread.id, err: String(err) }));
  };
  const onEvent = (event: AgentSessionEvent) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        shaper.onTextDelta(update.delta);
        counts.contentEvents += 1;
      } else if (update.type === "thinking_delta") {
        shaper.onReasoningDelta(update.delta);
        counts.contentEvents += 1;
      }
      updatePresenter();
      return;
    }
    if (event.type === "tool_execution_start") {
      shaper.onToolCall(event.toolName, event.args);
      counts.toolCalls += 1;
      if (event.toolName === "generate_image") counts.generateImageToolCalls += 1;
      input.logger.info("Pi tool call started", { threadId: input.thread.id, toolName: event.toolName });
      updatePresenter();
      updateStatus();
      return;
    }
    if (event.type === "tool_execution_end") {
      shaper.onToolResult(event.toolName, summarizeToolOutput(event.toolName, event.result));
      counts.toolResults += 1;
      if (event.toolName === "generate_image") {
        counts.generateImageToolError = toolErrorText(event.result) ?? counts.generateImageToolError;
        if (!event.isError) counts.generateImageReadyAt = Date.now();
      }
      input.logger.info("Pi tool call finished", {
        threadId: input.thread.id,
        toolName: event.toolName,
        error: event.isError || undefined,
      });
      updatePresenter();
      updateStatus();
    }
  };
  return { counts, onEvent };
}

async function waitForPendingCreatedFiles(input: TurnInput, pending: PendingCreatedFile[]): Promise<string | undefined> {
  if (!pending.length) return undefined;
  input.logger.info("waiting for pending created files", {
    threadId: input.thread.id,
    files: pending.length,
  });
  const results = await Promise.all(pending);
  const error = results.find((result) => result.error)?.error;
  input.logger.info("pending created files finished", {
    threadId: input.thread.id,
    files: results.filter((result) => result.attachment).length,
    errors: results.filter((result) => result.error).length,
  });
  return error;
}

async function resolveTurnUserMessage(input: TurnInput): Promise<MessageRow | undefined> {
  const latest = await input.repos.messages.latest(input.thread.id);
  const userMessage = await persistedTurnUserMessage(input, latest);
  if (userMessage?.role === "user") {
    await input.onUserMessagePersisted?.(userMessage);
  }
  return userMessage;
}

async function persistedTurnUserMessage(input: TurnInput, latest: MessageRow | undefined): Promise<MessageRow | undefined> {
  if (latest?.role === "user" && latest.text_plain === input.text) {
    input.logger.debug("latest user message already matches turn text", {
      threadId: input.thread.id,
      messageId: latest.id,
    });
    return latest;
  }
  const retryable = await latestRetryableUserMessage(input, latest);
  if (retryable?.role === "user" && retryable.text_plain === input.text) {
    input.logger.debug("reusing retryable user message for turn", {
      threadId: input.thread.id,
      messageId: retryable.id,
    });
    return retryable;
  }
  const inserted = await input.repos.messages.insert({
    threadId: input.thread.id,
    role: "user",
    kind: input.userMessageKind,
    content: input.userMessageContent ?? { text: input.text },
    textPlain: input.text,
  });
  input.logger.debug("user message persisted for turn", {
    threadId: input.thread.id,
    messageId: inserted.id,
    kind: inserted.kind,
  });
  return inserted;
}

async function latestRetryableUserMessage(input: TurnInput, latest: MessageRow | undefined): Promise<MessageRow | undefined> {
  if (!(latest?.role === "assistant" && !latest.text_plain.trim())) return latest;
  input.logger.debug("latest assistant message is empty; looking for retryable user message", {
    threadId: input.thread.id,
    latestMessageId: latest.id,
  });
  const messages = await input.repos.messages.listThread(input.thread.id);
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.text_plain.trim()) return latest;
    if (message.role === "user") return message;
  }
  return latest;
}

class TurnStatusMessage {
  private messageId?: number;
  private lastText = "";

  constructor(private readonly input: TurnInput) {}

  async start(text: string): Promise<void> {
    try {
      const sent = await sendPlainWithThreadFallback(this.input, text, { parse_mode: "HTML" });
      this.messageId = sent.message_id;
      this.lastText = text;
      this.input.logger.debug("thinking status message sent", {
        threadId: this.input.thread.id,
        telegramMessageId: sent.message_id,
      });
    } catch (err) {
      this.input.logger.warn("failed to send thinking status message", { err: String(err) });
    }
  }

  async update(text: string): Promise<void> {
    if (!this.messageId || text === this.lastText) return;
    try {
      await this.input.api.editMessageText(this.input.chatId, this.messageId, text, { parse_mode: "HTML" });
      this.lastText = text;
      this.input.logger.debug("thinking status message edited", {
        threadId: this.input.thread.id,
        telegramMessageId: this.messageId,
      });
    } catch (err) {
      this.input.logger.warn("failed to edit thinking status message", { err: String(err) });
    }
  }

  async finish(toolStatusMd: string): Promise<void> {
    this.input.logger.debug("thinking status message finishing", { threadId: this.input.thread.id });
    await this.update(buildThinkingStatus(this.input.t("thinking-done"), toolStatusMd));
  }
}

function buildThinkingStatus(heading: string, toolStatusMd: string): string {
  const tools = toolStatusMd.trim();
  return tools ? `${heading}\n\n${tools}` : heading;
}

function buildFinalThinkingSummary(input: {
  t: TurnInput["t"];
  shaper: StreamShaper;
  attachments: CreatedFileAttachment[];
  extraReasoning?: string[];
}): string {
  const summary = input.shaper.runSummary();
  const requestedFiles = input.attachments.length;
  const extraReasoning = (input.extraReasoning ?? []).map((item) => item.trim()).filter(Boolean);
  const reasoningSummaries = [...summary.reasoningSummaries, ...extraReasoning];
  if (!reasoningSummaries.length && !summary.toolCallCount && !requestedFiles) return "";

  const counters = [
    input.t("thinking-final-tool-calls", {
      count: summary.toolCallCount,
    }),
  ];

  if (reasoningSummaries.length) {
    counters.push(input.t("thinking-final-reasoning", { count: reasoningSummaries.length }));
  }

  const sections = [counters.join(" · ")];

  if (reasoningSummaries.length) {
    sections.push(reasoningSummaries.map(formatMarkdownListItem).join("\n\n"));
  }

  if (summary.toolCounts.length) {
    // Telegram can retain the preceding loose reasoning list without an explicit block boundary.
    const toolsHeading = `<p>${escapeHtml(input.t("thinking-final-tools"))}</p>`;
    sections.push([
      toolsHeading,
      summary.toolCounts.map((tool) => `- ${tool.label}: ${tool.count}`).join("\n"),
    ].join("\n\n"));
  }

  if (requestedFiles) {
    const sentFiles = Math.min(requestedFiles, MAX_CREATED_FILES_PER_ANSWER);
    const sentNames = input.attachments
      .slice(0, sentFiles)
      .map((file) => `<code>${escapeHtml(file.name)}</code>`)
      .join(", ");
    const filesLabel =
      requestedFiles > sentFiles
        ? input.t("thinking-final-files-capped", {
            sent: sentFiles,
            requested: requestedFiles,
            limit: MAX_CREATED_FILES_PER_ANSWER,
          })
        : input.t("thinking-final-files", { count: sentFiles });
    sections.push(sentNames ? `${filesLabel}\n\n${sentNames}` : filesLabel);
  }

  return sections.join("\n\n");
}

function formatMarkdownListItem(text: string): string {
  const [firstLine = "", ...continuation] = text.trim().split("\n");
  return [`- ${firstLine}`, ...continuation.map((line) => line ? `  ${line}` : "")].join("\n");
}

function draftAnswerWhileGeneratingImage(answer: string, hasGenerateImageCall: boolean): string {
  return hasGenerateImageCall ? "" : answer;
}

type GeneratedImageFinalText = {
  answer: string;
  demotedReasoning?: string;
};

function normalizeGeneratedImageFinalText(t: TurnInput["t"], answer: string, hasGeneratedImage: boolean): GeneratedImageFinalText {
  if (!hasGeneratedImage) return { answer };
  const trimmed = answer.trim();
  if (!trimmed) return { answer: t("image-generated-done") };
  if (isPendingGeneratedImageAnswer(trimmed)) return { answer: generatedImageReadyText(t) };
  if (isGeneratedImageToolUsageAnswer(trimmed)) {
    return {
      answer: generatedImageReadyText(t),
      demotedReasoning: trimmed,
    };
  }
  return { answer };
}

function generatedImageReadyText(t: TurnInput["t"]): string {
  const text = t("image-generated-ready");
  return text && text !== "image-generated-ready" ? text : t("image-generated-done");
}

function compactAnswerText(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

const IMAGE_TOOL_NAME_SOURCE = "(?:imagegen|generate_image|image generation tool|image generator tool|image tool)";

function isPendingGeneratedImageAnswer(answer: string): boolean {
  const compact = compactAnswerText(answer);
  if (!compact) return false;
  const mentionsImage = /\b(image|photo|picture)\b/.test(compact);
  const inProgressVerb = /\b(generating|creating|making|rendering|drawing)\b/.test(compact);
  if (mentionsImage && /\b(is|still|currently)\b.*\bbeing (generated|created|rendered|made|drawn)\b/.test(compact)) {
    return true;
  }
  if (!inProgressVerb) return false;
  if (/^done\b/.test(compact)) return true;
  if (mentionsImage && /\b(now|currently|still|started|starting|queued|shortly|soon)\b/.test(compact)) return true;
  if (mentionsImage && /\bin progress\b/.test(compact)) return true;
  return false;
}

function isGeneratedImageToolUsageAnswer(answer: string): boolean {
  const compact = compactAnswerText(answer);
  if (!compact) return false;
  const mentionsImageTool = new RegExp(`\\b${IMAGE_TOOL_NAME_SOURCE}\\b`).test(compact);
  if (!mentionsImageTool) return false;
  return /^(?:i(?:'m| am)?\s+)?(?:using|calling|invoking|running|used|called|invoked|ran)\b/.test(compact)
    || new RegExp(`\\b(?:using|calling|invoking|running|used|called|invoked|ran)\\b.{0,40}\\b${IMAGE_TOOL_NAME_SOURCE}\\b`).test(compact)
    || new RegExp(`\\b${IMAGE_TOOL_NAME_SOURCE}\\b.{0,40}\\b(?:tool|to edit|to generate|to create|to draw|to render)\\b`).test(compact);
}

function appendGeneratedImageDemotedThinking(
  t: TurnInput["t"],
  thinking: string,
  demotedReasoning: string | undefined,
): string {
  const note = demotedReasoning?.trim();
  if (!note) return thinking;
  const section = `${t("thinking-final-reasoning", { count: 1 })}\n\n${formatMarkdownListItem(note)}`;
  return thinking.trim() ? `${thinking.trimEnd()}\n\n${section}` : section;
}

export async function sendFinal(
  input: TurnInput,
  thinking: string,
  answer: string,
  elapsedMs = 0,
  attachments: CreatedFileAttachment[] = [],
): Promise<void> {
  const hasGeneratedImageAttachment = attachments
    .slice(0, MAX_CREATED_FILES_PER_ANSWER)
    .some((attachment) => attachment.origin === "generated_image");
  const finalText = normalizeGeneratedImageFinalText(input.t, answer, hasGeneratedImageAttachment);
  const visibleThinking = appendGeneratedImageDemotedThinking(input.t, thinking, finalText.demotedReasoning);
  await sendFinalVisible(input, visibleThinking, finalText.answer, elapsedMs, attachments);
}

async function sendFinalVisible(
  input: TurnInput,
  visibleThinking: string,
  visibleAnswer: string,
  elapsedMs: number,
  attachments: CreatedFileAttachment[],
  piEntryId?: string,
): Promise<void> {
  const outboundAttachments = attachments.slice(0, MAX_CREATED_FILES_PER_ANSWER);
  if (attachments.length > outboundAttachments.length) {
    input.logger.warn("created file attachment limit exceeded before final send; sending capped subset", {
      threadId: input.thread.id,
      requestedFiles: attachments.length,
      sentFiles: outboundAttachments.length,
      limit: MAX_CREATED_FILES_PER_ANSWER,
    });
  }
  const shouldSendFinalMessage = visibleAnswer.trim() || visibleThinking.trim();
  const messages = shouldSendFinalMessage
    ? renderFinal({
        thinkingLog: visibleThinking,
        answerMd: visibleAnswer,
        elapsedMs,
        t: input.t,
      })
    : [];
  const persistedText = visibleAnswer.trim() ? visibleAnswer : attachmentPersistedText(outboundAttachments);
  input.logger.debug("sending final answer", {
    threadId: input.thread.id,
    parts: messages.length,
    answerChars: visibleAnswer.length,
    persistedChars: persistedText.length,
    thinkingChars: visibleThinking.length,
  });
  const ids: number[] = [];
  for (const rich of messages) {
    const sent = await sendRichWithFallback(input, rich);
    ids.push(...sent.map((message) => message.message_id));
  }
  const assistantMessage = await input.repos.messages.insert({
    threadId: input.thread.id,
    role: "assistant",
    content: outboundAttachments.length
      ? {
          text: persistedText,
          files: outboundAttachments.map((file) => ({
            id: file.fileId,
            type: file.type,
            name: file.name,
            inline: file.inline,
            delivery: file.delivery ?? "document",
          })),
        }
      : { text: persistedText },
    textPlain: persistedText,
    thinking: visibleThinking,
    tgMessageId: ids.find((id) => id > 0)
      ?? outboundAttachments.map((attachment) => attachment.telegramDelivery?.messageId).find((id) => typeof id === "number" && id > 0)
      ?? null,
    piEntryId: piEntryId ?? null,
  });
  await sendCreatedFileAttachments(input, assistantMessage, outboundAttachments);
  input.logger.info("assistant message persisted", {
    threadId: input.thread.id,
    messageId: assistantMessage.id,
    telegramMessages: ids.length,
    files: outboundAttachments.length,
  });
}

async function sendCreatedFileAttachments(
  input: TurnInput,
  assistantMessage: MessageRow,
  attachments: CreatedFileAttachment[],
): Promise<void> {
  if (!attachments.length) return;
  const documents = attachments.filter((attachment) => (attachment.delivery ?? "document") === "document");
  const photos = attachments.filter((attachment) => attachment.delivery === "photo");
  await sendAttachmentBatch(input, assistantMessage, documents, documentSendStrategy);
  await sendAttachmentBatch(input, assistantMessage, photos, photoSendStrategy);
}

async function sendGeneratedImageAttachmentsEarly(
  input: TurnInput,
  attachments: CreatedFileAttachment[],
): Promise<number> {
  const generated = attachments
    .slice(0, MAX_CREATED_FILES_PER_ANSWER)
    .filter((attachment) => attachment.origin === "generated_image" && attachment.delivery === "photo");
  let delivered = 0;
  for (const attachment of generated) {
    if (attachment.telegramDelivery) {
      delivered += 1;
      continue;
    }
    try {
      const sent = await sendPhotoWithThreadFallback(input, attachment);
      attachment.telegramDelivery = telegramDeliveryFromSent(sent);
      delivered += 1;
      await rememberTelegramDeliverySource(input, attachment).catch((err: unknown) => {
        input.logger.warn("failed to persist early generated image Telegram reference", {
          threadId: input.thread.id,
          fileId: attachment.fileId,
          telegramMessageId: attachment.telegramDelivery?.messageId,
          err: String(err),
        });
      });
    } catch (err) {
      input.logger.warn("early generated image delivery failed; retrying during final attachment delivery", {
        threadId: input.thread.id,
        fileId: attachment.fileId,
        err: String(err),
      });
    }
  }
  return delivered;
}

interface AttachmentSendStrategy {
  label: string;
  sendOne(input: TurnInput, attachment: CreatedFileAttachment): Promise<SentTelegramFileMessage>;
  sendGroup(input: TurnInput, attachments: CreatedFileAttachment[]): Promise<SentTelegramFileMessage[]>;
}

const documentSendStrategy: AttachmentSendStrategy = {
  label: "created file attachment",
  sendOne: sendDocumentWithThreadFallback,
  sendGroup: sendDocumentMediaGroupWithThreadFallback,
};

const photoSendStrategy: AttachmentSendStrategy = {
  label: "generated image photo",
  sendOne: sendPhotoWithThreadFallback,
  sendGroup: sendPhotoMediaGroupWithThreadFallback,
};

async function sendAttachmentBatch(
  input: TurnInput,
  assistantMessage: MessageRow,
  attachments: CreatedFileAttachment[],
  strategy: AttachmentSendStrategy,
): Promise<void> {
  if (!attachments.length) return;
  const delivered = attachments.filter((attachment) => attachment.telegramDelivery);
  for (const attachment of delivered) {
    await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, undefined);
  }
  const pending = attachments.filter((attachment) => !attachment.telegramDelivery);
  if (!pending.length) return;
  if (pending.length === 1) {
    const attachment = pending[0]!;
    try {
      const sent = await strategy.sendOne(input, attachment);
      await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, sent);
      input.logger.info(`${strategy.label} sent`, {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        fileId: attachment.fileId,
        telegramMessageId: sent.message_id,
        name: attachment.name,
      });
    } catch (err) {
      input.logger.warn(`failed to send ${strategy.label}`, {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        fileId: attachment.fileId,
        name: attachment.name,
        err: String(err),
      });
      await removeUnresolvableUndeliveredAttachment(input, attachment);
    }
    return;
  }

  try {
    const sent = await strategy.sendGroup(input, pending);
    for (let index = 0; index < pending.length; index += 1) {
      const attachment = pending[index]!;
      await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, sent[index]);
    }
    input.logger.info(`${strategy.label} media group sent`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      files: pending.length,
      telegramMessages: sent.map((message) => message.message_id),
    });
  } catch (err) {
    input.logger.warn(`failed to send ${strategy.label} media group`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      files: pending.length,
      fileIds: pending.map((attachment) => attachment.fileId),
      err: String(err),
    });
    for (const attachment of pending) await removeUnresolvableUndeliveredAttachment(input, attachment);
  }
}

async function removeUnresolvableUndeliveredAttachment(
  input: TurnInput,
  attachment: CreatedFileAttachment,
): Promise<void> {
  if (attachment.path || attachment.telegramDelivery?.fileId) return;
  try {
    const stored = await input.repos.files.get(attachment.fileId);
    if (!stored || stored.path) return;
    const sources = await input.repos.files.listSources(attachment.fileId);
    if (sources.length) return;
    const chunkIds = await input.repos.files.deleteFile(attachment.fileId);
    if (chunkIds.length) await input.repos.embeddings.deleteRefs("chunk", chunkIds);
    input.logger.warn("removed undelivered attachment without a durable recovery source", {
      threadId: input.thread.id,
      fileId: attachment.fileId,
      name: attachment.name,
    });
  } catch (error) {
    input.logger.warn("failed to remove unresolvable undelivered attachment", {
      threadId: input.thread.id,
      fileId: attachment.fileId,
      name: attachment.name,
      error: String(error),
    });
  }
}

async function rememberSentCreatedFileAttachment(
  input: TurnInput,
  assistantMessage: MessageRow,
  attachment: CreatedFileAttachment,
  sent: SentTelegramFileMessage | undefined,
): Promise<void> {
  await input.repos.files.setMessageId(attachment.fileId, assistantMessage.id, {
    displayName: attachment.name,
    caption: attachment.caption ?? null,
  });
  const delivery = attachment.telegramDelivery ?? (sent ? telegramDeliveryFromSent(sent) : undefined);
  if (delivery) attachment.telegramDelivery = delivery;
  await rememberTelegramDeliverySource(input, attachment);
}

async function rememberTelegramDeliverySource(input: TurnInput, attachment: CreatedFileAttachment): Promise<void> {
  const delivery = attachment.telegramDelivery;
  if (!delivery?.fileId) return;
  await input.repos.files.rememberSource(attachment.fileId, telegramFileSource({
    fileId: delivery.fileId,
    fileUniqueId: delivery.fileUniqueId,
    mimeType: attachment.type === "image"
      ? attachment.delivery === "photo" ? "image/jpeg" : attachment.mimeType ?? null
      : null,
  }));
}

type SentTelegramPhotoSize = { file_id?: string; file_unique_id?: string; width?: number; height?: number; file_size?: number };

type SentTelegramFileMessage = {
  message_id: number;
  document?: { file_id?: string; file_unique_id?: string };
  photo?: SentTelegramPhotoSize[];
};

function telegramDeliveryFromSent(sent: SentTelegramFileMessage): NonNullable<CreatedFileAttachment["telegramDelivery"]> {
  const fileRecord = sent.document ?? largestTelegramPhoto(sent.photo);
  return {
    messageId: sent.message_id,
    fileId: fileRecord?.file_id?.trim() || null,
    fileUniqueId: fileRecord?.file_unique_id?.trim() || null,
  };
}

function withThreadFallback<T>(
  input: TurnInput,
  warn: { message: string; fields?: Record<string, unknown> },
  attempt: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  return withThreadNotFoundFallback(
    {
      messageThreadId: input.messageThreadId,
      onFallback: () =>
        input.logger.warn(warn.message, {
          threadId: input.thread.id,
          topicId: input.messageThreadId,
          ...warn.fields,
        }),
    },
    attempt,
    fallback,
  );
}

function sendDocumentWithThreadFallback(
  input: TurnInput,
  attachment: CreatedFileAttachment,
): Promise<SentTelegramFileMessage> {
  return withThreadFallback(
    input,
    {
      message: "telegram topic send failed; retrying created file without message_thread_id",
      fields: { fileId: attachment.fileId },
    },
    () => input.api.sendDocument(input.chatId, attachmentInput(attachment), documentSendOptions(input.messageThreadId, attachment)),
    () => input.api.sendDocument(input.chatId, attachmentInput(attachment), {
      ...documentSendOptions(undefined, attachment),
      caption: documentFallbackCaption(input.thread.title, attachment),
    }),
  );
}

function sendPhotoWithThreadFallback(
  input: TurnInput,
  attachment: CreatedFileAttachment,
): Promise<SentTelegramFileMessage> {
  return withThreadFallback(
    input,
    {
      message: "telegram topic send failed; retrying generated image photo without message_thread_id",
      fields: { fileId: attachment.fileId },
    },
    () => input.api.sendPhoto(input.chatId, attachmentInput(attachment), {
      ...threadOnlySendOptions(input.messageThreadId),
      caption: attachment.caption ?? undefined,
    }),
    () => input.api.sendPhoto(input.chatId, attachmentInput(attachment), {
      ...threadOnlySendOptions(undefined),
      caption: attachment.caption
        ? documentFallbackCaption(input.thread.title, attachment)
        : undefined,
    }),
  );
}

function sendDocumentMediaGroupWithThreadFallback(
  input: TurnInput,
  attachments: CreatedFileAttachment[],
): Promise<SentTelegramFileMessage[]> {
  return withThreadFallback(
    input,
    {
      message: "telegram topic send failed; retrying created file media group without message_thread_id",
      fields: { files: attachments.length, fileIds: attachments.map((attachment) => attachment.fileId) },
    },
    () => input.api.sendMediaGroup(input.chatId, documentMediaGroup(attachments), threadOnlySendOptions(input.messageThreadId)),
    () => input.api.sendMediaGroup(input.chatId, documentMediaGroup(attachments, input.thread.title), threadOnlySendOptions(undefined)),
  );
}

function sendPhotoMediaGroupWithThreadFallback(
  input: TurnInput,
  attachments: CreatedFileAttachment[],
): Promise<SentTelegramFileMessage[]> {
  return withThreadFallback(
    input,
    {
      message: "telegram topic send failed; retrying generated image photo media group without message_thread_id",
      fields: { files: attachments.length, fileIds: attachments.map((attachment) => attachment.fileId) },
    },
    () => input.api.sendMediaGroup(input.chatId, photoMediaGroup(attachments), threadOnlySendOptions(input.messageThreadId)),
    () => input.api.sendMediaGroup(input.chatId, photoMediaGroup(attachments), threadOnlySendOptions(undefined)),
  );
}

function documentSendOptions(
  messageThreadId: number | undefined,
  attachment: CreatedFileAttachment,
): Parameters<Api["sendDocument"]>[2] {
  return {
    message_thread_id: messageThreadId,
    caption: attachment.caption ?? undefined,
  };
}

function threadOnlySendOptions(messageThreadId: number | undefined): { message_thread_id: number | undefined } {
  return {
    message_thread_id: messageThreadId,
  };
}

function documentMediaGroup(
  attachments: CreatedFileAttachment[],
  fallbackThreadTitle?: string,
): Parameters<Api["sendMediaGroup"]>[1] {
  return attachments.map((attachment, index) => ({
    type: "document" as const,
    media: attachmentInput(attachment),
    caption: fallbackThreadTitle && index === 0
      ? documentFallbackCaption(fallbackThreadTitle, attachment)
      : attachment.caption ?? undefined,
  }));
}

function photoMediaGroup(
  attachments: CreatedFileAttachment[],
): Parameters<Api["sendMediaGroup"]>[1] {
  return attachments.map((attachment) => ({
    type: "photo" as const,
    media: attachmentInput(attachment),
    caption: attachment.caption ?? undefined,
  }));
}

function attachmentInput(attachment: CreatedFileAttachment): InputFile {
  if (attachment.data) return new InputFile(attachment.data, attachment.name);
  if (attachment.path) return new InputFile(attachment.path, attachment.name);
  throw new Error(`Attachment ${attachment.name} has neither data nor path`);
}

function documentFallbackCaption(title: string, attachment: CreatedFileAttachment): string {
  const text = prefixPlainForThreadFallback(title, attachment.caption || attachment.name);
  return text.length <= TG_CAPTION_LIMIT ? text : `${text.slice(0, TG_CAPTION_LIMIT - 3)}...`;
}

function attachmentPersistedText(attachments: CreatedFileAttachment[]): string {
  if (!attachments.length) return "";
  const generatedImages = attachments.filter((attachment) => attachment.origin === "generated_image");
  const files = generatedImages.length ? generatedImages : attachments;
  const names = files.map((file) => file.caption?.trim() || file.name).filter(Boolean).join(", ");
  if (generatedImages.length) return `Generated image: ${names}`;
  return `Attached file${files.length === 1 ? "" : "s"}: ${names}`;
}

function largestTelegramPhoto(photos: SentTelegramPhotoSize[] | undefined): SentTelegramPhotoSize | undefined {
  if (!photos?.length) return undefined;
  return [...photos].sort((left, right) => telegramPhotoScore(right) - telegramPhotoScore(left))[0];
}

function telegramPhotoScore(photo: SentTelegramPhotoSize): number {
  const size = typeof photo.file_size === "number" && Number.isFinite(photo.file_size) ? photo.file_size : 0;
  const width = typeof photo.width === "number" && Number.isFinite(photo.width) ? photo.width : 0;
  const height = typeof photo.height === "number" && Number.isFinite(photo.height) ? photo.height : 0;
  return Math.max(size, width * height);
}

async function sendRichWithFallback(
  input: TurnInput,
  rich: InputRichMessage,
): Promise<SentTelegramFileMessage[]> {
  const markdown = rich.markdown ?? rich.html ?? "";
  let lastRichError: unknown;
  try {
    const sent = await sendRichMessageWithThreadFallback(input, rich);
    return [sent];
  } catch (err) {
    if (!isRichParseError(err)) throw err;
    lastRichError = err;
    input.logger.debug("rich message parse failed; trying repaired variants", {
      threadId: input.thread.id,
      err: String(err),
    });
  }

  for (const variant of variantsForRichRetry(markdown)) {
    try {
      const sent = await sendRichMessageWithThreadFallback(input, variant);
      return [sent];
    } catch (err) {
      if (!isRichParseError(err)) throw err;
      lastRichError = err;
      input.logger.debug("rich message repaired variant failed", {
        threadId: input.thread.id,
        err: String(err),
      });
    }
  }

  input.logger.error("all rich message repair attempts failed; falling back to plain sendMessage", {
    threadId: input.thread.id,
    chars: markdown.length,
  });
  const ids: number[] = [];
  for (const chunk of splitPlainText(markdown)) {
    const sent = await sendPlainWithThreadFallback(input, chunk);
    ids.push(sent.message_id);
  }
  input.logger.info("plain fallback messages sent", { threadId: input.thread.id, messages: ids.length });
  return ids.map((message_id) => ({ message_id }));
}

function sendRichMessageWithThreadFallback(
  input: TurnInput,
  rich: InputRichMessage,
): Promise<SentTelegramFileMessage> {
  return withThreadFallback(
    input,
    { message: "telegram topic send failed; retrying final rich message without message_thread_id" },
    () => sendRich(input.api, {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId,
      rich_message: rich,
    }),
    () => sendRich(input.api, {
      chat_id: input.chatId,
      rich_message: prefixRichForThreadFallback(input.thread.title, rich),
    }),
  );
}

function sendPlainWithThreadFallback(
  input: TurnInput,
  text: string,
  other: Parameters<Api["sendMessage"]>[2] = {},
): Promise<{ message_id: number }> {
  return withThreadFallback(
    input,
    { message: "telegram topic send failed; retrying plain message without message_thread_id" },
    () => input.api.sendMessage(input.chatId, text, {
      ...other,
      message_thread_id: input.messageThreadId,
    }),
    () => input.api.sendMessage(input.chatId, prefixPlainForThreadFallback(input.thread.title, text, other.parse_mode === "HTML"), other),
  );
}

function splitPlainText(text: string): string[] {
  const max = TG_MESSAGE_LIMIT;
  if (text.length <= max) return [text || " "];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    const cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(" "));
    const end = cut > max * MIN_SPLIT_RATIO ? cut : max;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function toolCallMetadata(
  input: TurnInput,
  part: Extract<NormalizedStreamPart, { kind: "tool-call" }>,
): Promise<ToolCallMetadata | undefined> {
  if (part.toolName !== "search_in_file" && part.toolName !== "read_file_section") return undefined;
  const fileId = fileIdFromToolInput(part.input);
  if (fileId === undefined) return undefined;
  try {
    const file = await input.repos.files.get(fileId);
    return { fileName: file?.name ?? `#${fileId}` };
  } catch (err) {
    input.logger.warn("failed to resolve tool file name", {
      threadId: input.thread.id,
      fileId,
      toolName: part.toolName,
      err: String(err),
    });
    return { fileName: `#${fileId}` };
  }
}

function fileIdFromToolInput(input: unknown): number | undefined {
  const value = asRecord(input)?.file_id;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

type StreamEvent = "content" | "tool-call" | "tool-result";

export function handleStreamPart(shaper: StreamShaper, part: unknown, metadata?: ToolCallMetadata): StreamEvent | undefined {
  return handleNormalizedStreamPart(shaper, normalizeStreamPart(part), metadata);
}

function handleNormalizedStreamPart(
  shaper: StreamShaper,
  normalized: NormalizedStreamPart | undefined,
  metadata?: ToolCallMetadata,
): StreamEvent | undefined {
  switch (normalized?.kind) {
    case "text":
      shaper.onTextDelta(normalized.text);
      return "content";
    case "text-final":
      shaper.onTextFinal(normalized.text);
      return "content";
    case "reasoning":
      shaper.onReasoningDelta(normalized.text);
      return "content";
    case "tool-call":
      shaper.onToolCall(normalized.toolName, normalized.input, metadata);
      return "tool-call";
    case "tool-result":
      shaper.onToolResult(normalized.toolName, summarizeToolOutput(normalized.toolName, normalized.output));
      return "tool-result";
    default:
      return undefined;
  }
}

export type NormalizedStreamPart =
  | { kind: "text"; text: string }
  | { kind: "text-final"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolName: string; input: unknown }
  | { kind: "tool-result"; toolName: string; output: unknown };

export function normalizeStreamPart(part: unknown): NormalizedStreamPart | undefined {
  const anyPart = part as Record<string, unknown> & { type?: string };
  switch (anyPart.type) {
    case "text-delta":
      return { kind: "text", text: String(anyPart.text ?? anyPart.delta ?? "") };
    case "text-final":
      return { kind: "text-final", text: String(anyPart.text ?? "") };
    case "reasoning-delta":
      return { kind: "reasoning", text: String(anyPart.text ?? anyPart.delta ?? "") };
    case "tool-call":
    case "tool-input-available":
      return { kind: "tool-call", toolName: String(anyPart.toolName ?? "tool"), input: anyPart.input ?? anyPart.args };
    case "tool-result":
    case "tool-output-available":
      return { kind: "tool-result", toolName: String(anyPart.toolName ?? "tool"), output: anyPart.output ?? anyPart.result };
    default:
      return undefined;
  }
}

function summarizeToolOutput(toolName: string, value: unknown): string {
  const record = asRecord(value);
  if (toolName === "bash" && record) {
    if (record.timed_out === true) return "timed out";
    if (typeof record.exit_code === "number") return `exit ${record.exit_code}`;
  }
  if (record?.error) return "error";

  if (toolName === "create_file" && record) {
    return record.file_id === undefined ? "done" : formatCount(1, "file");
  }

  if (toolName === "generate_image" && record) {
    if (record.pending === true) return "generating";
    return record.file_id === undefined ? "done" : formatCount(1, "image");
  }

  const results = Array.isArray(record?.results) ? record.results : undefined;
  if (results) {
    return formatCount(results.length, "result");
  }

  if (toolName === "load_message" && record) {
    return formatCount(1, "result");
  }

  if (toolName === "read_file_section" && record) {
    if (Array.isArray(record.outline)) return formatCount(record.outline.length, "result");
    if (typeof record.content === "string") return formatCount(countLoadedFileSections(record.content), "result");
  }

  const text = typeof value === "string" ? value : safeJson(value);
  return text && text !== "{}" ? formatCount(1, "result") : "done";
}

function toolErrorText(value: unknown): string | undefined {
  const error = asRecord(value)?.error;
  return typeof error === "string" && error.trim() ? error.trim() : undefined;
}

function isPendingToolResult(value: unknown): boolean {
  return asRecord(value)?.pending === true;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countLoadedFileSections(content: string): number {
  return Math.max(1, content.match(/^# chunk /gm)?.length ?? 0);
}

export function isContextLengthError(err: unknown): boolean {
  return /context|maximum.*tokens|too (many|long)/i.test(errorText(err));
}

function errorText(err: unknown): string {
  const parts = [String(err)];
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    for (const key of ["message", "description", "body", "responseBody", "data", "cause"]) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
      else if (value !== undefined) parts.push(safeJson(value));
    }
  }
  return parts.join("\n");
}
