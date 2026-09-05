import type { ThinkingDelivery } from "./types.js";
import type { TurnInput, TurnRunner } from "./types.js";
import { sendFinal, sendFinalVisible, refreshFinalThinkingVisible, normalizeTelegramAttachmentDeliveries, sendFinalThinkingVisible, sendPlainWithThreadFallback } from "./responseDelivery.js";
import { formatMarkdownListItem, draftAnswerWhileGeneratingImage, normalizeGeneratedImageFinalText } from "./turnOutput.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { MessageRow, UserRow } from "../db/types.js";
import { DraftStreamer } from "../telegram/draftStreamer.js";
import { isThreadNotFound } from "../telegram/richApi.js";
import { MAX_CREATED_FILES_PER_ANSWER } from "../files/limits.js";
import { StreamShaper, type ToolCallMetadata } from "./shaper.js";
import type { CreatedFileAttachment } from "../files/types.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import { asRecord, safeJson } from "../util/records.js";
import { escapeHtml } from "../util/text.js";
import {
  inferenceUsageDelta,
  type InferenceUsageDelta,
} from "../pi/usage.js";
import { budgetReasonText } from "../pi/turnBudget.js";
import { currentTurnAssistantResult } from "./currentTurnResult.js";
import { resolveTurnAnswer } from "./turnOutput.js";

const TYPING_ACTION_INTERVAL_MS = 5000;

export const runTurn: TurnRunner = async (input) => {
  const startedAt = Date.now();
  input = { ...input, deliveryTiming: { startedAt } };
  input.logger.info("turn starting", {
    turnRunId: input.turnRunId,
    threadId: input.thread.id,
    userId: input.user.tg_id,
    kind: input.userMessageKind ?? "text",
    textChars: input.text.length,
    streamMode: input.user.stream_mode,
  });
  const shaper = new StreamShaper();
  const { streamer, status, stop } = createTurnPresenter(input, startedAt);
  let activeBridge: Awaited<ReturnType<PiRuntimeService["runtime"]>>["bridge"] | undefined;
  let inferenceUsage: InferenceUsageDelta | undefined;
  let inferenceBackend: { inferenceProvider: string; inferenceModel: string } | undefined;
  let currentTurnMessages: AgentMessage[] = [];
  let completionEntryId: string | undefined;
  let deliveryStarted = false;

  const piEntries: Array<{ id: string; role: "user" | "assistant" }> = [];
  try {
    input.signal?.throwIfAborted();
    if (!input.pi) throw new Error("Pi runtime is not configured.");
    const userMessage = await resolveTurnUserMessage(input);
    const currentFiles = userMessage ? await input.repos.files.listForMessage(userMessage.id) : [];
    const runtime = await input.pi.runtime(input.thread, input.user);
    activeBridge = runtime.bridge;
    await runtime.bridge.beginTurn({
      api: input.api,
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      resolveFile: async (file, signal) => {
        if (!input.resolveFile) throw new Error("Chat file resolution is unavailable.");
        return input.resolveFile(file, signal);
      },
      currentFileIds: currentFiles.map((file) => file.id),
      userMessageId: userMessage?.id,
    });
    input.outgoingBuffers = runtime.bridge.outgoingBuffers;
    await status?.start(buildThinkingStatus(input.t("thinking-placeholder"), shaper.toolStatusMd()));
    input.logger.info("Pi turn starting", {
      turnRunId: input.turnRunId,
      threadId: input.thread.id,
      modelRole: runtime.session.model?.id,
      sessionId: runtime.session.sessionId,
    });
    streamer?.update({ thinkingMd: "", answerMd: "" });
    const stats = createPiStreamLoop(input, shaper, streamer, status);
    const existingEntryIds = new Set(runtime.session.sessionManager.getEntries().map((entry) => entry.id));
    const usageBefore = runtime.session.getSessionStats().tokens;
    const unsubscribe = runtime.session.subscribe(stats.onEvent);
    try {
      await runPiPromptWithTimeout(runtime.session, input.text, input.config.PI_TURN_TIMEOUT_MS, input.signal);
    } finally {
      unsubscribe();
      const newEntries = runtime.session.sessionManager.getEntries().filter(
        (entry) => !existingEntryIds.has(entry.id),
      );
      currentTurnMessages = newEntries.flatMap((entry) =>
        entry.type === "message" ? [entry.message] : []);
      // A terminal tool is the last persisted entry. Fork after its result so
      // the next session retains the final text and a complete tool exchange.
      completionEntryId = [...newEntries].reverse().find((entry) =>
        entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolName === "finish_response" && !entry.message.isError
        && asRecord(entry.message.details)?.completed === true)?.id;
      piEntries.push(...newEntries.flatMap((entry) => {
        if (entry.type !== "message") return [];
        const role = entry.message.role;
        return role === "user" || role === "assistant" ? [{ id: entry.id, role }] : [];
      }));
      inferenceUsage = inferenceUsageDelta(
        usageBefore,
        runtime.session.getSessionStats().tokens,
      );
      const finalAssistant = [...newEntries].reverse().find(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      if (finalAssistant?.type === "message" && finalAssistant.message.role === "assistant") {
        inferenceBackend = {
          inferenceProvider: finalAssistant.message.provider,
          inferenceModel: finalAssistant.message.model,
        };
      }
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
      turnRunId: input.turnRunId,
      threadId: input.thread.id,
      contentEvents: stats.counts.contentEvents,
      toolCalls: stats.counts.toolCalls,
      toolResults: stats.counts.toolResults,
    });
    input.signal?.throwIfAborted();
    const generateImageToolError = stats.counts.generateImageToolError;
    const assistantResult = currentTurnAssistantResult(currentTurnMessages);
    let answer = assistantResult.completed ? assistantResult.text : assistantResult.text || shaper.finalAnswer();
    const budgetSnapshot = runtime.bridge.currentTurnBudget()?.snapshot();
    const budgetReason = budgetSnapshot?.terminationReason;
    if (assistantResult.stopReason === "aborted" && !budgetReason) {
      await status?.finish(shaper.toolStatusMd());
      await streamer?.finish();
      input.logger.info("Pi turn cancelled", {
        threadId: input.thread.id,
        ...inferenceBackend,
        ...inferenceUsage,
      });
      return;
    }
    if (budgetReason) answer = appendBudgetNotice(answer, budgetReasonText(budgetReason, input.user.lang), input.user.lang);
    const assistantError = assistantResult.error;
    if (assistantError && !answer.trim()) throw new Error(assistantError);
    const createdFiles = runtime.bridge.attachments;
    normalizeTelegramAttachmentDeliveries(createdFiles);
    const hasGeneratedImage = createdFiles.some((file) => file.origin === "generated_image");
    if (stats.counts.generateImageToolCalls > 0 && !hasGeneratedImage) {
      throw new Error(`Image generation failed${generateImageToolError ? `: ${generateImageToolError}` : ": no image attachment was produced"}`);
    }
    const finalText = normalizeGeneratedImageFinalText(hasGeneratedImage ? "" : answer, hasGeneratedImage);
    const resolvedAnswer = resolveTurnAnswer({
      answer: finalText.answer,
      attachmentCount: createdFiles.length,
      emptyAnswer: input.t("empty-answer"),
    });
    let finalAnswer = resolvedAnswer.answer;
    if (resolvedAnswer.usedEmptyFallback) {
      input.logger.warn("turn produced empty final answer", {
        threadId: input.thread.id,
        userId: input.user.tg_id,
        toolStatus: shaper.toolStatusMd(),
      });
    }
    finalAnswer = appendPublishedWebsiteNotice(
      finalAnswer,
      runtime.bridge.publishedWebsites.map((website) => website.url),
      input.user.lang,
    );
    let finalThinking = buildFinalThinkingSummary({
      t: input.t,
      shaper,
      // List only confirmed deliveries so the visible summary never promises a
      // pending source that may fail its lazy reload.
      attachments: createdFiles.filter((file) => file.telegramDelivery),
      extraReasoning: finalText.demotedReasoning ? [finalText.demotedReasoning] : [],
    });
    input.signal?.throwIfAborted();
    const thinkingDelivery = await streamer?.finish({ thinkingMd: finalThinking, answerMd: finalAnswer });
    input.signal?.throwIfAborted();
    const assistantEntry = [...piEntries].reverse().find((entry) => entry.role === "assistant");
    const finalDelivery = await sendFinalVisible(
      input,
      finalThinking,
      finalAnswer,
      Date.now() - startedAt,
      createdFiles,
      completionEntryId ?? assistantEntry?.id,
      thinkingDelivery,
      {
        provider: inferenceBackend?.inferenceProvider,
        model: inferenceBackend?.inferenceModel,
        usage: inferenceUsage,
      },
      () => { deliveryStarted = true; },
    );
    if (hasGeneratedImage) {
      const delivered = createdFiles.filter((file) =>
        file.origin === "generated_image" && file.telegramDelivery).length;
      input.logger.info("generated image delivered after final thinking", {
        threadId: input.thread.id,
        images: delivered,
        postToolDeliveryMs: stats.counts.generateImageReadyAt
          ? Math.max(0, Date.now() - stats.counts.generateImageReadyAt)
          : undefined,
      });
    }
    const deliveredFinalThinking = buildFinalThinkingSummary({
      t: input.t,
      shaper,
      attachments: createdFiles.filter((file) => file.telegramDelivery),
      requestedAttachmentCount: createdFiles.length,
      extraReasoning: finalText.demotedReasoning ? [finalText.demotedReasoning] : [],
    });
    if (deliveredFinalThinking !== finalThinking) {
      finalThinking = deliveredFinalThinking;
      let thinkingMessageId = finalDelivery.thinkingMessageIds.find((id) => id > 0);
      if (thinkingMessageId !== undefined) {
        try {
          const thinkingMessageIds = await refreshFinalThinkingVisible(
            input,
            finalDelivery.thinkingMessageIds,
            finalThinking,
            Date.now() - startedAt,
          );
          thinkingMessageId = thinkingMessageIds.find((id) => id > 0);
        } catch (error) {
          input.logger.warn("failed to refresh finalized attachment thinking summary", {
            threadId: input.thread.id,
            messageId: finalDelivery.assistantMessageId,
            err: String(error),
          });
        }
      }
      await input.repos.messages.setThinking(
        finalDelivery.assistantMessageId,
        finalThinking,
        thinkingMessageId,
      ).catch((error) => {
        input.logger.warn("failed to persist finalized attachment thinking summary", {
          threadId: input.thread.id,
          messageId: finalDelivery.assistantMessageId,
          err: String(error),
        });
      });
    }
    await status?.finish(shaper.toolStatusMd());
    input.logger.info("turn complete", {
      turnRunId: input.turnRunId,
      threadId: input.thread.id,
      answerChars: finalAnswer.length,
      thinkingChars: finalThinking.length,
      ms: Date.now() - startedAt,
      ...inferenceBackend,
      ...inferenceUsage,
      modelCycles: budgetSnapshot?.modelCycles,
      toolCalls: budgetSnapshot?.toolCalls,
      budgetTerminationReason: budgetReason,
      ...stats.counts.modelTiming,
      ...input.deliveryTiming,
      ...input.outgoingBuffers?.snapshot(),
    });
  } catch (err) {
    if (input.signal?.aborted) {
      await status?.finish(shaper.toolStatusMd());
      await streamer?.finish();
      input.logger.info("turn cancelled", {
        threadId: input.thread.id,
        turnRunId: input.turnRunId,
        ms: Date.now() - startedAt,
      });
      return;
    }
    const budgetReason = activeBridge?.currentTurnBudget()?.snapshot().terminationReason;
    if (budgetReason && !deliveryStarted) {
      const partial = appendBudgetNotice(shaper.finalAnswer(), budgetReasonText(budgetReason, input.user.lang), input.user.lang);
      await sendFinal(input, "", partial);
      input.logger.warn("turn stopped by loop budget", {
        threadId: input.thread.id,
        turnRunId: input.turnRunId,
        budgetTerminationReason: budgetReason,
      });
      return;
    }
    input.logger.error("turn failed", {
      turnRunId: input.turnRunId,
      threadId: input.thread.id,
      err: String(err),
      ms: Date.now() - startedAt,
      ...inferenceBackend,
      ...inferenceUsage,
    });
    await input.onExecutionFailure?.("agent_execution_failed");
    const generatedImageDelivered = activeBridge?.attachments.some((file) =>
      file.origin === "generated_image" && file.telegramDelivery);
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
    if (deliveryStarted) {
      input.logger.warn("turn failed after final delivery began; suppressing duplicate error reply", {
        threadId: input.thread.id,
        turnRunId: input.turnRunId,
      });
      return;
    }
    const reference = input.turnRunId ? `#${input.turnRunId}` : "unavailable";
    const label = input.user.lang === "ru" ? "Код обращения" : "Turn reference";
    await sendFinal(input, "", `${input.t("error-generic")}\n\n${label}: ${reference}`);
  } finally {
    try {
      await activeBridge?.endTurn();
    } catch (err) {
      input.logger.error("Pi bridge cleanup failed", {
        threadId: input.thread.id,
        err: String(err),
      });
    } finally {
      stop();
    }
  }
};

export function appendPublishedWebsiteNotice(
  answer: string,
  urls: string[],
  locale: UserRow["lang"],
): string {
  const unique = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (!unique.length) return answer;
  const links = unique.map((url) => `- ${url}`).join("\n");
  const notice = locale === "ru"
    ? [
        "Сайт опубликован по публичной ссылке:",
        links,
        "Любой, у кого есть ссылка, сможет открыть сайт. Песочница останется активной 15 минут после этого ответа, затем будет приостановлена и ссылка перестанет отвечать. Попросите меня в этой ветке возобновить и снова опубликовать сайт; если сервер всё ещё исправен, адрес останется тем же.",
      ].join("\n\n")
    : [
        "The website is available at this public link:",
        links,
        "Anyone with the link can access it. The sandbox will remain active for 15 minutes after this response, then pause and the link will stop responding. Ask me in this thread to resume and publish it again; if the server is still healthy, the URL will stay the same.",
      ].join("\n\n");
  return answer.trim() ? `${answer.trimEnd()}\n\n${notice}` : notice;
}

export async function runPiPromptWithTimeout(
  session: Awaited<ReturnType<PiRuntimeService["runtime"]>>["session"],
  text: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort!: (reason?: unknown) => void;
  let shutdownRequested = false;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    shutdownRequested = true;
    rejectAbort(signal?.reason ?? new Error("Turn cancelled."));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let prompt: ReturnType<typeof session.prompt> | undefined;
  try {
    prompt = session.prompt(text, { expandPromptTemplates: false, source: "extension" });
    const operations: Promise<unknown>[] = [
      prompt,
      abortPromise,
    ];
    if (timeoutMs > 0) {
      operations.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          shutdownRequested = true;
          reject(new Error(`Pi turn timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
      }));
    }
    await Promise.race(operations);
  } catch (error) {
    if (shutdownRequested) {
      await session.abort().catch(() => undefined);
      await prompt?.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function appendBudgetNotice(answer: string, reason: string, locale: UserRow["lang"]): string {
  const notice = locale === "ru"
    ? `Остановлено безопасным лимитом цикла: ${reason}`
    : `Stopped by an agent-loop safety limit: ${reason}`;
  return answer.trim() ? `${answer.trimEnd()}\n\n${notice}` : notice;
}

interface TurnPresenter {
  streamer: TurnDraftStreamer | undefined;
  status: TurnStatusMessage | undefined;
  stop: () => void;
}

function createTurnPresenter(input: TurnInput, startedAt: number): TurnPresenter {
  const streamer = input.user.stream_mode
    ? new TurnDraftStreamer(input, startedAt)
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

class TurnDraftStreamer {
  private readonly thinking: DraftStreamer;
  private readonly answer: DraftStreamer;
  private answerStarted = false;
  private answerReady = false;
  private latestAnswerMd = "";
  private deliveredThinkingMd = "";
  private thinkingDelivery?: Promise<number[]>;
  private thinkingDeliveryError: unknown;

  constructor(
    private readonly input: TurnInput,
    private readonly startedAt: number,
  ) {
    const common = {
      api: input.api,
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      threadTitle: input.thread.title,
      startedAt,
      updateMs: input.config.DRAFT_UPDATE_MS,
      t: input.t,
    };
    this.thinking = new DraftStreamer(common);
    this.answer = new DraftStreamer({ ...common, answerOnly: true });
  }

  update(frame: { thinkingMd: string; answerMd: string }): void {
    if (this.answerStarted) return;
    // Text can precede more tool calls. Keep it inside the running draft until
    // the prompt completes and finish() can publish the final answer.
    this.thinking.update({
      thinkingMd: [frame.thinkingMd, frame.answerMd].filter((text) => text.trim()).join("\n\n"),
      answerMd: "",
    });
  }

  async finish(frame?: { thinkingMd: string; answerMd: string }): Promise<ThinkingDelivery | undefined> {
    if (!frame) {
      if (!this.answerStarted) {
        await this.thinking.finish();
        return undefined;
      }
      const messageIds = await this.waitForThinkingDelivery();
      await this.answer.finish();
      return { handled: true, messageIds };
    }

    this.latestAnswerMd = frame.answerMd;
    if (!this.answerStarted) this.startAnswer(frame.thinkingMd);
    let messageIds = await this.waitForThinkingDelivery();
    if (frame.thinkingMd !== this.deliveredThinkingMd) {
      messageIds = await refreshFinalThinkingVisible(
        this.input,
        messageIds,
        frame.thinkingMd,
        Math.max(0, Date.now() - this.startedAt),
      );
      this.deliveredThinkingMd = frame.thinkingMd;
    }
    if (frame.answerMd.trim()) {
      await this.answer.finish({ thinkingMd: "", answerMd: frame.answerMd });
    } else {
      this.answer.stop();
    }
    return { handled: true, messageIds };
  }

  stop(): void {
    this.thinking.stop();
    this.answer.stop();
  }

  private startAnswer(finalThinkingMd: string): void {
    if (this.answerStarted) return;
    this.answerStarted = true;
    this.deliveredThinkingMd = finalThinkingMd;
    this.thinking.stop();
    const elapsedMs = Math.max(0, Date.now() - this.startedAt);
    this.thinkingDelivery = sendFinalThinkingVisible(this.input, finalThinkingMd, elapsedMs).catch((err) => {
      this.thinkingDeliveryError = err;
      return [];
    });
    void this.thinkingDelivery.then(() => {
      if (this.thinkingDeliveryError) return;
      this.answerReady = true;
      this.updateAnswerDraft();
    });
  }

  private async waitForThinkingDelivery(): Promise<number[]> {
    const messageIds = await (this.thinkingDelivery ?? Promise.resolve([]));
    if (this.thinkingDeliveryError) throw this.thinkingDeliveryError;
    return messageIds;
  }

  private updateAnswerDraft(): void {
    if (!this.answerReady || !this.latestAnswerMd.trim()) return;
    this.answer.update({ thinkingMd: "", answerMd: this.latestAnswerMd });
  }
}

interface TurnStreamStats {
  modelTiming: { modelMs: number; peakContextTokens: number };
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
  streamer: TurnDraftStreamer | undefined,
  status: TurnStatusMessage | undefined,
): { counts: TurnStreamStats; onEvent: (event: AgentSessionEvent) => void } {
  const counts: TurnStreamStats = {
    modelTiming: { modelMs: 0, peakContextTokens: 0 },
    contentEvents: 0,
    toolCalls: 0,
    toolResults: 0,
    generateImageToolCalls: 0,
    generateImageToolError: undefined,
    generateImageReadyAt: undefined,
  };
  let cycleStartedAt = Date.now();
  let cycle = 0;
  const toolStartedAt = new Map<string, number>();
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
    if (event.type === "turn_start") { cycleStartedAt = Date.now(); cycle++; }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      const ms = Date.now() - cycleStartedAt;
      const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      counts.modelTiming.modelMs += ms;
      counts.modelTiming.peakContextTokens = Math.max(counts.modelTiming.peakContextTokens, contextTokens);
      input.logger.info("Pi model cycle complete", {
        threadId: input.thread.id, turnRunId: input.turnRunId, cycle, ms,
        provider: event.message.provider, model: event.message.model,
        inputTokens: usage.input, outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
        cacheReadRatio: contextTokens ? usage.cacheRead / contextTokens : null,
        contextTokens, stopReason: event.message.stopReason,
      });
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        shaper.onTextDelta(update.delta);
        counts.contentEvents += 1;
      } else if (update.type === "thinking_start") {
        shaper.onReasoningStart();
      } else if (update.type === "thinking_delta") {
        shaper.onReasoningDelta(update.delta);
        counts.contentEvents += 1;
      } else if (update.type === "thinking_end") {
        shaper.onReasoningEnd();
      }
      updatePresenter();
      return;
    }
    if (event.type === "tool_execution_start") {
      toolStartedAt.set(event.toolCallId, Date.now());
      shaper.onToolCall(event.toolName, event.args);
      counts.toolCalls += 1;
      if (event.toolName === "generate_image") counts.generateImageToolCalls += 1;
      input.logger.info("Pi tool call started", {
        threadId: input.thread.id,
        turnRunId: input.turnRunId,
        toolName: event.toolName,
      });
      updatePresenter();
      updateStatus();
      return;
    }
    if (event.type === "tool_execution_end") {
      const startedAt = toolStartedAt.get(event.toolCallId);
      toolStartedAt.delete(event.toolCallId);
      shaper.onToolResult(event.toolName, summarizeToolOutput(event.toolName, event.result));
      counts.toolResults += 1;
      if (event.toolName === "generate_image") {
        counts.generateImageToolError = toolErrorText(event.result, event.isError)
          ?? counts.generateImageToolError;
        if (!event.isError) counts.generateImageReadyAt = Date.now();
      }
      input.logger.info("Pi tool call finished", {
        threadId: input.thread.id,
        turnRunId: input.turnRunId,
        toolName: event.toolName,
        error: event.isError || undefined,
        latencyMs: startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt),
      });
      updatePresenter();
      updateStatus();
    }
  };
  return { counts, onEvent };
}

async function resolveTurnUserMessage(input: TurnInput): Promise<MessageRow | undefined> {
  if (input.userMessageId !== undefined) {
    const accepted = await input.repos.messages.get(input.userMessageId);
    if (!accepted || accepted.thread_id !== input.thread.id || accepted.role !== "user") {
      throw new Error(`Accepted user message #${input.userMessageId} is unavailable for this turn.`);
    }
    return accepted;
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
  await input.onUserMessagePersisted?.(inserted);
  return inserted;
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

export function buildFinalThinkingSummary(input: {
  t: TurnInput["t"];
  shaper: StreamShaper;
  attachments: CreatedFileAttachment[];
  requestedAttachmentCount?: number;
  extraReasoning?: string[];
}): string {
  const summary = input.shaper.runSummary();
  const deliveredFiles = Math.min(input.attachments.length, MAX_CREATED_FILES_PER_ANSWER);
  const requestedFiles = input.requestedAttachmentCount ?? input.attachments.length;
  const filesWereCapped = requestedFiles > MAX_CREATED_FILES_PER_ANSWER;
  const extraReasoning = (input.extraReasoning ?? []).map((item) => item.trim()).filter(Boolean);
  const reasoningSummaries = [...summary.reasoningSummaries, ...extraReasoning];
  if (!reasoningSummaries.length && !summary.toolCallCount && !deliveredFiles && !filesWereCapped) return "";

  const counters = [
    input.t("thinking-final-tool-calls", {
      count: summary.toolCallCount,
    }),
  ];

  if (reasoningSummaries.length) {
    counters.push(input.t("thinking-final-reasoning", { count: reasoningSummaries.length }));
  }

  const sections = [counters.join(" · ")];

  if (deliveredFiles || filesWereCapped) {
    const sentNames = input.attachments
      .slice(0, deliveredFiles)
      .map((file) => `<code>${escapeHtml(file.name)}</code>`)
      .join(", ");
    const filesLabel =
      filesWereCapped
        ? input.t("thinking-final-files-capped", {
            sent: deliveredFiles,
            requested: requestedFiles,
            limit: MAX_CREATED_FILES_PER_ANSWER,
          })
        : input.t("thinking-final-files", { count: deliveredFiles });
    // Keep confirmed deliveries ahead of verbose reasoning/tool sections. The
    // Telegram final-thinking renderer caps long summaries from the end, so this
    // ordering guarantees that file outcomes survive that cap.
    sections.push(sentNames ? `${filesLabel}\n\n${sentNames}` : filesLabel);
  }

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

  return sections.join("\n\n");
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

type NormalizedStreamPart =
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
  const wrapper = asRecord(value);
  const record = asRecord(wrapper?.details) ?? wrapper;
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

  if (toolName === "render_office_preview" && record) {
    return record.rendered === true ? formatCount(1, "preview") : "done";
  }

  if (toolName === "inspect_workspace_images" && record && Array.isArray(record.images)) {
    return formatCount(record.images.length, "image");
  }

  if (toolName === "browser_list_tabs" && record && Array.isArray(record.tabs)) {
    return formatCount(record.tabs.length, "tab");
  }

  if (toolName === "browser_list_downloads" && record && Array.isArray(record.downloads)) {
    return formatCount(record.downloads.length, "file");
  }

  if ((toolName === "browser_screenshot" || toolName === "browser_send_file") && record?.attached === true) {
    return formatCount(1, "file");
  }

  if (toolName === "browser_close_session" && record) {
    if (record.already_closed === true) return "already closed";
    if (record.closed === true && typeof record.tabs_closed === "number") {
      return formatCount(record.tabs_closed, "tab");
    }
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

export function toolErrorText(value: unknown, includeContentText = false): string | undefined {
  const record = asRecord(value);
  const details = asRecord(record?.details);
  for (const candidate of [record?.error, details?.error, record?.message, details?.message]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (!includeContentText) return undefined;
  const content = Array.isArray(record?.content) ? record.content : [];
  for (const part of content) {
    const text = asRecord(part)?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return undefined;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countLoadedFileSections(content: string): number {
  return Math.max(1, content.match(/^# chunk /gm)?.length ?? 0);
}
