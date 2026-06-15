import { streamText, stepCountIs } from "ai";
import type { Api } from "grammy";
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
import { buildTools } from "./tools/index.js";
import { chatModel, providerOptions } from "./provider.js";
import { StreamShaper } from "./shaper.js";
import type { FileRow } from "../db/types.js";

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
    }
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
    await sendContextLimitNotice(input);
    return;
  }

  const shaper = new StreamShaper();
  const streamer = input.user.stream_mode
    ? new DraftStreamer({
        api: input.api,
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        threadTitle: input.thread.title,
        updateMs: input.config.DRAFT_UPDATE_MS,
        t: input.t,
      })
    : undefined;
  const status = streamer ? undefined : new TurnStatusMessage(input);
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

  try {
    await status?.start(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
    const result = streamText({
      model: chatModel(input.config),
      system: context.system,
      messages: context.messages,
      tools: buildTools(input),
      stopWhen: stepCountIs(input.config.MAX_TOOL_STEPS),
      providerOptions: providerOptions(input.config),
      abortSignal: AbortSignal.timeout(300_000),
    });
    for await (const part of result.fullStream) {
      const event = handleStreamPart(shaper, part);
      if (event === "tool-call") streamer?.startKeepalive();
      if (event === "tool-result" || event === "content") streamer?.stopKeepalive();
      streamer?.update({ thinkingMd: shaper.thinkingMd(), answerMd: shaper.visibleAnswer() });
      if (event === "tool-call" || event === "tool-result") {
        await status?.update(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
      }
    }
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
    await sendFinal(input, shaper.thinkingMd(), finalAnswer);
    await status?.finish(shaper.toolStatusMd());
  } catch (err) {
    if (isContextLengthError(err)) {
      input.logger.warn("provider context limit hit", { err: String(err) });
      await status?.finish(shaper.toolStatusMd());
      await streamer?.finish();
      await sendContextLimitNotice(input);
      return;
    }
    input.logger.error("turn failed", { err: String(err) });
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
  const messages = await input.repos.messages.listThread(input.thread.id);
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.text_plain.trim()) return latest;
    if (message.role === "user") return message;
  }
  return latest;
}

async function sendContextLimitNotice(input: TurnInput): Promise<void> {
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
      const sent = await sendPlainWithThreadFallback(this.input, text);
      this.messageId = sent.message_id;
      this.lastText = text;
    } catch (err) {
      this.input.logger.warn("failed to send thinking status message", { err: String(err) });
    }
  }

  async update(text: string): Promise<void> {
    if (!this.messageId || text === this.lastText) return;
    try {
      await this.input.api.editMessageText(this.input.chatId, this.messageId, text);
      this.lastText = text;
    } catch (err) {
      this.input.logger.warn("failed to edit thinking status message", { err: String(err) });
    }
  }

  async finish(toolStatusMd: string): Promise<void> {
    await this.update(buildThinkingStatus(this.input.t("thinking-done"), toolStatusMd));
  }
}

function buildThinkingStatus(heading: string, toolStatusMd: string): string {
  const tools = toolStatusMd.trim();
  return tools ? `${heading}\n\n${tools}` : heading;
}

export async function sendFinal(input: TurnInput, thinking: string, answer: string): Promise<void> {
  const messages = renderFinal({
    thinkingLog: thinking,
    answerMd: answer,
    t: input.t,
    config: input.config,
  });
  const ids: number[] = [];
  for (const rich of messages) {
    ids.push(...(await sendRichWithFallback(input, rich)));
  }
  const assistantMessage = await input.repos.messages.insert({
    threadId: input.thread.id,
    role: "assistant",
    content: { text: answer },
    textPlain: answer,
    thinking,
    tgMessageId: ids.find((id) => id > 0) ?? null,
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

async function sendRichWithFallback(input: TurnInput, rich: { markdown?: string; html?: string }): Promise<number[]> {
  const markdown = rich.markdown ?? rich.html ?? "";
  try {
    const sent = await sendRichMessageWithThreadFallback(input, rich);
    return [sent.message_id];
  } catch (err) {
    if (!isRichParseError(err)) throw err;
  }

  for (const variant of variantsForRichRetry(markdown)) {
    try {
      const sent = await sendRichMessageWithThreadFallback(input, variant);
      return [sent.message_id];
    } catch (err) {
      if (!isRichParseError(err)) throw err;
    }
  }

  input.logger.error("all rich message repair attempts failed; falling back to plain sendMessage");
  const ids: number[] = [];
  for (const chunk of splitPlainText(markdown)) {
    const sent = await sendPlainWithThreadFallback(input, chunk);
    ids.push(sent.message_id);
  }
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
    return input.api.sendMessage(input.chatId, prefixPlainForThreadFallback(input.thread.title, text), other);
  }
}

function prefixRichForThreadFallback(title: string, rich: { markdown?: string; html?: string }): { markdown?: string; html?: string } {
  if (rich.markdown !== undefined) return { ...rich, markdown: `**${escapeMarkdownTitle(title)}**\n\n${rich.markdown}` };
  return { ...rich, html: `<p><strong>${escapeHtml(title)}</strong></p>\n\n${rich.html ?? ""}` };
}

function prefixPlainForThreadFallback(title: string, text: string): string {
  return `[${title}]\n\n${text}`;
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

type StreamEvent = "content" | "tool-call" | "tool-result";

export function handleStreamPart(shaper: StreamShaper, part: unknown): StreamEvent | undefined {
  const normalized = normalizeStreamPart(part);
  switch (normalized?.kind) {
    case "text":
      shaper.onTextDelta(normalized.text);
      return "content";
    case "reasoning":
      shaper.onReasoningDelta(normalized.text);
      return "content";
    case "tool-call":
      shaper.onToolCall(normalized.toolName);
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
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolName: string; input: unknown }
  | { kind: "tool-result"; toolName: string; output: unknown };

export function normalizeStreamPart(part: unknown): NormalizedStreamPart | undefined {
  const anyPart = part as Record<string, unknown> & { type?: string };
  switch (anyPart.type) {
    case "text-delta":
      return { kind: "text", text: String(anyPart.text ?? anyPart.delta ?? "") };
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
  if (record?.error) return "error";

  const results = Array.isArray(record?.results) ? record.results : undefined;
  if (results) {
    if (toolName === "web_search") return formatCount(results.length, "website");
    if (toolName === "search_thread") return formatCount(results.length, "chat match", "chat matches");
    if (toolName === "search_in_file") return formatCount(results.length, "file match", "file matches");
    return formatCount(results.length, "result");
  }

  if (toolName === "load_message" && record) {
    const files = Array.isArray(record.files) ? record.files.length : 0;
    const images = Array.isArray(record.images) ? record.images.length : 0;
    const extras = [files ? formatCount(files, "file") : "", images ? formatCount(images, "image") : ""].filter(Boolean);
    return extras.length ? `message loaded, ${extras.join(", ")}` : "message loaded";
  }

  if (toolName === "read_file_section" && record) {
    if (Array.isArray(record.outline)) return formatCount(record.outline.length, "heading");
    if (typeof record.content === "string") return formatCount(countLoadedFileSections(record.content), "file section");
  }

  const text = typeof value === "string" ? value : safeJson(value);
  return text && text !== "{}" ? "details returned" : "done";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
