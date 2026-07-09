import { InputFile, type Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { MessageKind, MessageRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { buildContext } from "../memory/contextBuilder.js";
import { persistEmbedding, type TextEmbedder } from "../memory/embeddings.js";
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
import { streamInference } from "./inference.js";
import { StreamShaper, type ToolCallMetadata } from "./shaper.js";
import type { FileRow } from "../db/types.js";
import type { BotImageGenerator, CreatedFileAttachment, PendingCreatedFile } from "./tools/index.js";
import { asRecord, safeJson } from "../util/records.js";
import { escapeHtml } from "../util/text.js";

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
  redownloadFile?: (file: FileRow) => Promise<Buffer>;
  embedder?: TextEmbedder;
  imageGenerator?: BotImageGenerator;
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
  await resolveTurnUserMessage(input);
  const context = await buildContext({
    config: input.config,
    repos: input.repos,
    search: input.db.search,
    user: input.user,
    thread: input.thread,
    newUserText: input.text,
    logger: input.logger,
  });
  if (context.overBudget) {
    input.logger.info("turn stopped; context over budget", {
      threadId: input.thread.id,
      tokensEst: context.tokensEst,
    });
    await sendContextLimitNotice(input);
    return;
  }
  input.logger.debug("turn context ready", {
    threadId: input.thread.id,
    messages: context.messages.length,
    tokensEst: context.tokensEst,
  });

  const shaper = new StreamShaper();
  const { streamer, status, stop } = createTurnPresenter(input, startedAt);

  const createdFiles: CreatedFileAttachment[] = [];
  const pendingCreatedFiles: PendingCreatedFile[] = [];
  try {
    await status?.start(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
    input.logger.info("provider stream starting", {
      threadId: input.thread.id,
      provider: "codex",
      model: input.config.CODEX_MODEL,
      reasoningSummary: input.config.REASONING_SUMMARY,
    });
    const result = streamInference({
      ...input,
      context,
      createdFiles,
      pendingCreatedFiles,
      abortSignal: input.config.CODEX_TURN_TIMEOUT_MS > 0 ? AbortSignal.timeout(input.config.CODEX_TURN_TIMEOUT_MS) : undefined,
    });
    streamer?.update({ thinkingMd: "", answerMd: "" });
    const stats = await runStreamLoop(input, shaper, streamer, status, result);
    input.logger.debug("provider stream complete", {
      threadId: input.thread.id,
      contentEvents: stats.contentEvents,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
    });
    const pendingFileError = await waitForPendingCreatedFiles(input, pendingCreatedFiles);
    const generateImageToolError = pendingFileError ?? stats.generateImageToolError;
    const answer = shaper.finalAnswer();
    const hasGeneratedImage = createdFiles.some((file) => file.origin === "generated_image");
    if (stats.generateImageToolCalls > 0 && !hasGeneratedImage) {
      throw new Error(`Image generation failed${generateImageToolError ? `: ${generateImageToolError}` : ": no image attachment was produced"}`);
    }
    const finalText = normalizeGeneratedImageFinalText(input.t, answer, hasGeneratedImage);
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
    await streamer?.finish({ thinkingMd: finalThinking, answerMd: finalAnswer });
    await sendFinalVisible(input, finalThinking, finalAnswer, Date.now() - startedAt, createdFiles);
    await status?.finish(shaper.toolStatusMd());
    input.logger.info("turn complete", {
      threadId: input.thread.id,
      answerChars: finalAnswer.length,
      thinkingChars: finalThinking.length,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    if (isContextLengthError(err)) {
      input.logger.warn("provider context limit hit", { threadId: input.thread.id, err: String(err) });
      await status?.finish(shaper.toolStatusMd());
      await streamer?.finish();
      await sendContextLimitNotice(input);
      return;
    }
    input.logger.error("turn failed", { threadId: input.thread.id, err: String(err), ms: Date.now() - startedAt });
    await status?.finish(shaper.toolStatusMd());
    await streamer?.finish();
    await sendFinal(input, "", `${input.t("error-generic")}\n\n<details><summary>Error</summary>\n\n${String(err)}\n\n</details>`);
  } finally {
    stop();
  }
};

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
}

async function runStreamLoop(
  input: TurnInput,
  shaper: StreamShaper,
  streamer: DraftStreamer | undefined,
  status: TurnStatusMessage | undefined,
  result: { fullStream: AsyncIterable<unknown> },
): Promise<TurnStreamStats> {
  let contentEvents = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let generateImageToolCalls = 0;
  let generateImageToolError: string | undefined;
  for await (const part of result.fullStream) {
    const normalized = normalizeStreamPart(part);
    const metadata = normalized?.kind === "tool-call" ? await toolCallMetadata(input, normalized) : undefined;
    const event = handleNormalizedStreamPart(shaper, normalized, metadata);
    if (event === "content") contentEvents += 1;
    if (event === "tool-call") {
      toolCalls += 1;
      if (normalized?.kind === "tool-call" && normalized.toolName === "generate_image") generateImageToolCalls += 1;
      input.logger.info("tool call started", {
        threadId: input.thread.id,
        toolName: normalized?.kind === "tool-call" ? normalized.toolName : "tool",
      });
    }
    if (event === "tool-result") {
      toolResults += 1;
      const pendingGenerateImage = normalized?.kind === "tool-result"
        && normalized.toolName === "generate_image"
        && isPendingToolResult(normalized.output);
      if (normalized?.kind === "tool-result" && normalized.toolName === "generate_image") {
        generateImageToolError = toolErrorText(normalized.output) ?? generateImageToolError;
      }
      input.logger.info(pendingGenerateImage ? "tool call acknowledged" : "tool call finished", {
        threadId: input.thread.id,
        toolName: normalized?.kind === "tool-result" ? normalized.toolName : "tool",
        pending: pendingGenerateImage || undefined,
      });
    }
    streamer?.update({
      thinkingMd: shaper.streamingThinkingMd(),
      answerMd: draftAnswerWhileGeneratingImage(shaper.visibleAnswer(), generateImageToolCalls > 0),
    });
    if (event === "tool-call" || event === "tool-result") {
      await status?.update(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
    }
  }
  return { contentEvents, toolCalls, toolResults, generateImageToolCalls, generateImageToolError };
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
    await persistEmbedding({
      repos: input.repos,
      kind: "message",
      refId: userMessage.id,
      text: userMessage.text_plain,
      embedder: input.embedder,
      embeddingModel: input.config.OPENROUTER_EMBEDDING_MODEL,
      logger: input.logger,
    });
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

async function sendContextLimitNotice(input: TurnInput): Promise<void> {
  input.logger.info("sending context limit notice", { threadId: input.thread.id });
  await sendPlainWithThreadFallback(input, input.t("ctx-limit"), {
    reply_markup: {
      inline_keyboard: [[{ text: input.t("btn-compact"), callback_data: "ctx:compact" }]],
    },
  });
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
  const reasoningTitles = [...summary.reasoningTitles, ...extraReasoning];
  if (!reasoningTitles.length && !summary.toolCallCount && !requestedFiles) return "";

  const lines = [
    input.t("thinking-final-tool-calls", {
      count: summary.toolCallCount,
    }),
  ];

  if (reasoningTitles.length) {
    lines.push(input.t("thinking-final-reasoning", { count: reasoningTitles.length }));
    lines.push(...reasoningTitles.map((title) => `- ${title}`));
  }

  if (summary.toolCounts.length) {
    lines.push(input.t("thinking-final-tools"));
    lines.push(...summary.toolCounts.map((tool) => `- ${tool.label}: ${tool.count}`));
  }

  if (requestedFiles) {
    const sentFiles = Math.min(requestedFiles, MAX_CREATED_FILES_PER_ANSWER);
    const sentNames = input.attachments
      .slice(0, sentFiles)
      .map((file) => `<code>${escapeHtml(file.name)}</code>`)
      .join(", ");
    lines.push(
      requestedFiles > sentFiles
        ? input.t("thinking-final-files-capped", {
            sent: sentFiles,
            requested: requestedFiles,
            limit: MAX_CREATED_FILES_PER_ANSWER,
          })
        : input.t("thinking-final-files", { count: sentFiles }),
    );
    if (sentNames) lines.push(sentNames);
  }

  return lines.join("\n");
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
  const section = `${t("thinking-final-reasoning", { count: 1 })}\n- ${note}`;
  return thinking.trim() ? `${thinking.trimEnd()}\n${section}` : section;
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
    tgMessageId: ids.find((id) => id > 0) ?? null,
  });
  await sendCreatedFileAttachments(input, assistantMessage, outboundAttachments);
  input.logger.info("assistant message persisted", {
    threadId: input.thread.id,
    messageId: assistantMessage.id,
    telegramMessages: ids.length,
    files: outboundAttachments.length,
  });
  await persistEmbedding({
    repos: input.repos,
    kind: "message",
    refId: assistantMessage.id,
    text: assistantMessage.text_plain,
    embedder: input.embedder,
    embeddingModel: input.config.OPENROUTER_EMBEDDING_MODEL,
    logger: input.logger,
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
  if (attachments.length === 1) {
    const attachment = attachments[0]!;
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
    }
    return;
  }

  try {
    const sent = await strategy.sendGroup(input, attachments);
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, sent[index]);
    }
    input.logger.info(`${strategy.label} media group sent`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      files: attachments.length,
      telegramMessages: sent.map((message) => message.message_id),
    });
  } catch (err) {
    input.logger.warn(`failed to send ${strategy.label} media group`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      files: attachments.length,
      fileIds: attachments.map((attachment) => attachment.fileId),
      err: String(err),
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
  const fileRecord = sent?.document ?? largestTelegramPhoto(sent?.photo);
  await input.repos.files.rememberTelegramFileRef(attachment.fileId, {
    fileUniqueId: fileRecord?.file_unique_id?.trim() || null,
    telegramFileId: fileRecord?.file_id?.trim() || null,
  });
}

type SentTelegramPhotoSize = { file_id?: string; file_unique_id?: string; width?: number; height?: number; file_size?: number };

type SentTelegramFileMessage = {
  message_id: number;
  document?: { file_id?: string; file_unique_id?: string };
  photo?: SentTelegramPhotoSize[];
};

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
    () => input.api.sendDocument(input.chatId, new InputFile(attachment.path, attachment.name), documentSendOptions(input.messageThreadId, attachment)),
    () => input.api.sendDocument(input.chatId, new InputFile(attachment.path, attachment.name), {
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
    () => input.api.sendPhoto(input.chatId, new InputFile(attachment.path, attachment.name), threadOnlySendOptions(input.messageThreadId)),
    () => input.api.sendPhoto(input.chatId, new InputFile(attachment.path, attachment.name), { ...threadOnlySendOptions(undefined) }),
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
    media: new InputFile(attachment.path, attachment.name),
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
    media: new InputFile(attachment.path, attachment.name),
  }));
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
