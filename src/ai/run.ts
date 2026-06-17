import { InputFile, type Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { MessageRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { buildContext } from "../memory/contextBuilder.js";
import { persistEmbedding, type TextEmbedder } from "../memory/embeddings.js";
import { DraftStreamer } from "../telegram/draftStreamer.js";
import { renderFinal, variantsForRichRetry } from "../telegram/render.js";
import { isRichParseError, isThreadNotFound, sendRich } from "../telegram/richApi.js";
import { MAX_CREATED_FILES_PER_ANSWER } from "../files/limits.js";
import { streamInference } from "./inference.js";
import { StreamShaper, type ToolCallMetadata } from "./shaper.js";
import type { FileRow } from "../db/types.js";
import type { CreatedFileAttachment } from "./tools/index.js";

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
  userMessageKind?: "text" | "image" | "file" | "system";
  userMessageContent?: unknown;
  onUserMessagePersisted?: (message: MessageRow) => Promise<void>;
  redownloadFile?: (file: FileRow) => Promise<Buffer>;
  embedder?: TextEmbedder;
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
  const latest = await input.repos.messages.latest(input.thread.id);
  let userMessage = await latestRetryableUserMessage(input, latest);
  if (!(latest?.role === "user" && latest.text_plain === input.text)) {
    if (!(userMessage?.role === "user" && userMessage.text_plain === input.text)) {
      userMessage = await input.repos.messages.insert({
        threadId: input.thread.id,
        role: "user",
        kind: input.userMessageKind,
        content: input.userMessageContent ?? { text: input.text },
        textPlain: input.text,
      });
      input.logger.debug("user message persisted for turn", {
        threadId: input.thread.id,
        messageId: userMessage.id,
        kind: userMessage.kind,
      });
    } else {
      input.logger.debug("reusing retryable user message for turn", {
        threadId: input.thread.id,
        messageId: userMessage.id,
      });
    }
  } else {
    input.logger.debug("latest user message already matches turn text", {
      threadId: input.thread.id,
      messageId: latest.id,
    });
  }
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
    }, 5000);
  }

  let contentEvents = 0;
  let toolCalls = 0;
  let toolResults = 0;
  const createdFiles: CreatedFileAttachment[] = [];
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
      abortSignal: input.config.CODEX_TURN_TIMEOUT_MS > 0 ? AbortSignal.timeout(input.config.CODEX_TURN_TIMEOUT_MS) : undefined,
    });
    streamer?.update({ thinkingMd: "", answerMd: "" });
    for await (const part of result.fullStream) {
      const normalized = normalizeStreamPart(part);
      const metadata = normalized?.kind === "tool-call" ? await toolCallMetadata(input, normalized) : undefined;
      const event = handleStreamPart(shaper, part, metadata);
      if (event === "content") contentEvents += 1;
      if (event === "tool-call") {
        toolCalls += 1;
        input.logger.info("tool call started", {
          threadId: input.thread.id,
          toolName: normalized?.kind === "tool-call" ? normalized.toolName : "tool",
        });
      }
      if (event === "tool-result") {
        toolResults += 1;
        input.logger.info("tool call finished", {
          threadId: input.thread.id,
          toolName: normalized?.kind === "tool-result" ? normalized.toolName : "tool",
        });
      }
      streamer?.update({ thinkingMd: shaper.thinkingMd(), answerMd: shaper.visibleAnswer() });
      if (event === "tool-call" || event === "tool-result") {
        await status?.update(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
      }
    }
    input.logger.debug("provider stream complete", {
      threadId: input.thread.id,
      contentEvents,
      toolCalls,
      toolResults,
    });
    const answer = shaper.finalAnswer();
    let finalAnswer = answer;
    if (!answer.trim()) {
      input.logger.warn("turn produced empty final answer", {
        threadId: input.thread.id,
        userId: input.user.tg_id,
        toolStatus: shaper.toolStatusMd(),
      });
      finalAnswer = input.t("empty-answer");
    }
    await streamer?.finish({ thinkingMd: shaper.thinkingMd(), answerMd: finalAnswer });
    await sendFinal(input, shaper.thinkingMd(), finalAnswer, Date.now() - startedAt, createdFiles);
    await status?.finish(shaper.toolStatusMd());
    input.logger.info("turn complete", {
      threadId: input.thread.id,
      answerChars: finalAnswer.length,
      thinkingChars: shaper.thinkingMd().length,
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
    streamer?.stop();
    if (typing) clearInterval(typing);
  }
};

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

export async function sendFinal(
  input: TurnInput,
  thinking: string,
  answer: string,
  elapsedMs = 0,
  attachments: CreatedFileAttachment[] = [],
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
  const messages = renderFinal({
    thinkingLog: thinking,
    answerMd: answer,
    elapsedMs,
    t: input.t,
  });
  input.logger.debug("sending final answer", {
    threadId: input.thread.id,
    parts: messages.length,
    answerChars: answer.length,
    thinkingChars: thinking.length,
  });
  const ids: number[] = [];
  for (const rich of messages) {
    ids.push(...(await sendRichWithFallback(input, rich)));
  }
  const assistantMessage = await input.repos.messages.insert({
    threadId: input.thread.id,
    role: "assistant",
    content: outboundAttachments.length
      ? {
          text: answer,
          files: outboundAttachments.map((file) => ({
            id: file.fileId,
            type: file.type,
            name: file.name,
            inline: file.inline,
          })),
        }
      : { text: answer },
    textPlain: answer,
    thinking,
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
  if (attachments.length === 1) {
    const attachment = attachments[0]!;
    try {
      const sent = await sendDocumentWithThreadFallback(input, attachment);
      await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, sent);
      input.logger.info("created file attachment sent", {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        fileId: attachment.fileId,
        telegramMessageId: sent.message_id,
        name: attachment.name,
      });
    } catch (err) {
      input.logger.warn("failed to send created file attachment", {
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
    const sent = await sendMediaGroupWithThreadFallback(input, attachments);
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, sent[index]);
    }
    input.logger.info("created file attachment media group sent", {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      files: attachments.length,
      telegramMessages: sent.map((message) => message.message_id),
    });
  } catch (err) {
    input.logger.warn("failed to send created file attachment media group", {
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
  sent: SentDocumentMessage | undefined,
): Promise<void> {
  await input.repos.files.setMessageId(attachment.fileId, assistantMessage.id, {
    displayName: attachment.name,
    caption: attachment.caption ?? null,
  });
  const document = asRecord(sent)?.document;
  await input.repos.files.rememberTelegramFileRef(attachment.fileId, {
    fileUniqueId: stringField(asRecord(document), "file_unique_id") ?? null,
    telegramFileId: stringField(asRecord(document), "file_id") ?? null,
  });
}

type SentDocumentMessage = { message_id: number; document?: { file_id?: string; file_unique_id?: string } };

async function sendDocumentWithThreadFallback(
  input: TurnInput,
  attachment: CreatedFileAttachment,
): Promise<SentDocumentMessage> {
  const other = documentSendOptions(input.messageThreadId, attachment);
  try {
    return await input.api.sendDocument(input.chatId, new InputFile(attachment.path, attachment.name), other);
  } catch (err) {
    if (!input.messageThreadId || !isThreadNotFound(err)) throw err;
    input.logger.warn("telegram topic send failed; retrying created file without message_thread_id", {
      threadId: input.thread.id,
      topicId: input.messageThreadId,
      fileId: attachment.fileId,
    });
    return input.api.sendDocument(input.chatId, new InputFile(attachment.path, attachment.name), {
      ...documentSendOptions(undefined, attachment),
      caption: documentFallbackCaption(input.thread.title, attachment),
    });
  }
}

async function sendMediaGroupWithThreadFallback(
  input: TurnInput,
  attachments: CreatedFileAttachment[],
): Promise<SentDocumentMessage[]> {
  try {
    return await input.api.sendMediaGroup(input.chatId, documentMediaGroup(attachments), mediaGroupSendOptions(input.messageThreadId));
  } catch (err) {
    if (!input.messageThreadId || !isThreadNotFound(err)) throw err;
    input.logger.warn("telegram topic send failed; retrying created file media group without message_thread_id", {
      threadId: input.thread.id,
      topicId: input.messageThreadId,
      files: attachments.length,
      fileIds: attachments.map((attachment) => attachment.fileId),
    });
    return input.api.sendMediaGroup(
      input.chatId,
      documentMediaGroup(attachments, input.thread.title),
      mediaGroupSendOptions(undefined),
    );
  }
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

function mediaGroupSendOptions(messageThreadId: number | undefined): Parameters<Api["sendMediaGroup"]>[2] {
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

function documentFallbackCaption(title: string, attachment: CreatedFileAttachment): string {
  const text = prefixPlainForThreadFallback(title, attachment.caption || attachment.name);
  return text.length <= 1024 ? text : `${text.slice(0, 1021)}...`;
}

async function sendRichWithFallback(input: TurnInput, rich: { markdown?: string; html?: string }): Promise<number[]> {
  const markdown = rich.markdown ?? rich.html ?? "";
  try {
    const sent = await sendRichMessageWithThreadFallback(input, rich);
    return [sent.message_id];
  } catch (err) {
    if (!isRichParseError(err)) throw err;
    input.logger.debug("rich message parse failed; trying repaired variants", {
      threadId: input.thread.id,
      err: String(err),
    });
  }

  for (const variant of variantsForRichRetry(markdown)) {
    try {
      const sent = await sendRichMessageWithThreadFallback(input, variant);
      return [sent.message_id];
    } catch (err) {
      if (!isRichParseError(err)) throw err;
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
  return ids;
}

async function sendRichMessageWithThreadFallback(
  input: TurnInput,
  rich: { markdown?: string; html?: string },
): Promise<{ message_id: number }> {
  try {
    return await sendRich(input.api, {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId,
      rich_message: rich as never,
    });
  } catch (err) {
    if (!input.messageThreadId || !isThreadNotFound(err)) throw err;
    input.logger.warn("telegram topic send failed; retrying final rich message without message_thread_id", {
      threadId: input.thread.id,
      topicId: input.messageThreadId,
    });
    return sendRich(input.api, {
      chat_id: input.chatId,
      rich_message: prefixRichForThreadFallback(input.thread.title, rich) as never,
    });
  }
}

async function sendPlainWithThreadFallback(
  input: TurnInput,
  text: string,
  other: Parameters<Api["sendMessage"]>[2] = {},
): Promise<{ message_id: number }> {
  try {
    return await input.api.sendMessage(input.chatId, text, {
      ...other,
      message_thread_id: input.messageThreadId,
    });
  } catch (err) {
    if (!input.messageThreadId || !isThreadNotFound(err)) throw err;
    input.logger.warn("telegram topic send failed; retrying plain message without message_thread_id", {
      threadId: input.thread.id,
      topicId: input.messageThreadId,
    });
    return input.api.sendMessage(input.chatId, prefixPlainForThreadFallback(input.thread.title, text, other.parse_mode === "HTML"), other);
  }
}

function prefixRichForThreadFallback(title: string, rich: { markdown?: string; html?: string }): { markdown?: string; html?: string } {
  if (rich.markdown !== undefined) return { ...rich, markdown: `**${escapeMarkdownTitle(title)}**\n\n${rich.markdown}` };
  return { ...rich, html: `<p><strong>${escapeHtml(title)}</strong></p>\n\n${rich.html ?? ""}` };
}

function prefixPlainForThreadFallback(title: string, text: string, html = false): string {
  return `[${html ? escapeHtml(title) : title}]\n\n${text}`;
}

function escapeMarkdownTitle(title: string): string {
  return title.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitPlainText(text: string): string[] {
  const max = 4096;
  if (text.length <= max) return [text || " "];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    const cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(" "));
    const end = cut > max * 0.5 ? cut : max;
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
  const normalized = normalizeStreamPart(part);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
