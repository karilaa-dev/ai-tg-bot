import { GrammyError, InputFile, type Api } from "grammy";
import type { MessageRow } from "../db/types.js";
import { renderFinalAnswer, renderFinalThinking, variantsForRichRetry } from "../telegram/render.js";
import { isRichParseError, editRich, prefixPlainForThreadFallback, prefixRichForThreadFallback, sendRich, withThreadNotFoundFallback, type InputRichMessage } from "../telegram/richApi.js";
import { MAX_CREATED_FILES_PER_ANSWER, TG_PHOTO_MAX_BYTES } from "../files/limits.js";
import type { CreatedFileAttachment } from "../files/types.js";
import { escapeHtml } from "../util/text.js";
import { telegramFileSource } from "../files/telegramSource.js";
import { type InferenceUsageDelta } from "../pi/usage.js";
import { OutgoingBuffers } from "../files/outgoingBuffers.js";
import { AttachmentPreparation } from "./attachmentPreparation.js";

import type { TurnInput, ThinkingDelivery } from "./types.js";

const TG_CAPTION_LIMIT = 1024;
const TG_MESSAGE_LIMIT = 4096;
const MIN_SPLIT_RATIO = 0.5;

export async function sendFinal(
  input: TurnInput,
  thinking: string,
  answer: string,
  elapsedMs = 0,
  attachments: CreatedFileAttachment[] = [],
): Promise<void> {
  await sendFinalVisible(input, thinking, answer, elapsedMs, attachments);
}

interface FinalVisibleDelivery {
  assistantMessageId: number;
  thinkingMessageIds: number[];
}

export async function sendFinalVisible(
  input: TurnInput,
  visibleThinking: string,
  visibleAnswer: string,
  elapsedMs: number,
  attachments: CreatedFileAttachment[],
  piEntryId?: string,
  thinkingDelivery?: ThinkingDelivery,
  inference?: { provider?: string; model?: string; usage?: InferenceUsageDelta },
  onPersisted?: () => void,
): Promise<FinalVisibleDelivery> {
  input.signal?.throwIfAborted();
  if (input.onDeliveryStarting && !input.onDeliveryStarting()) {
    throw input.signal?.reason ?? new Error("Turn cancellation won the delivery race.");
  }
  const outboundAttachments = attachments.slice(0, MAX_CREATED_FILES_PER_ANSWER);
  normalizeTelegramAttachmentDeliveries(outboundAttachments);
  if (attachments.length > outboundAttachments.length) {
    input.logger.warn("created file attachment limit exceeded before final send; sending capped subset", {
      threadId: input.thread.id,
      requestedFiles: attachments.length,
      sentFiles: outboundAttachments.length,
      limit: MAX_CREATED_FILES_PER_ANSWER,
    });
  }
  const thinkingMessages = thinkingDelivery?.handled
    ? []
    : renderFinalThinking({
        thinkingLog: visibleThinking,
        elapsedMs,
        t: input.t,
      });
  const answerMessages = renderFinalAnswer({
    answerMd: visibleAnswer,
  });
  let deliveredAnswer = visibleAnswer;
  const initialPersistedText = visibleAnswer.trim() ? visibleAnswer : "";
  input.logger.debug("sending final answer", {
    threadId: input.thread.id,
    thinkingParts: thinkingMessages.length,
    answerParts: answerMessages.length,
    answerChars: visibleAnswer.length,
    persistedChars: initialPersistedText.length,
    thinkingChars: visibleThinking.length,
  });
  const assistantMessage = await input.repos.messages.insert({
    threadId: input.thread.id,
    role: "assistant",
    content: { text: initialPersistedText },
    textPlain: initialPersistedText,
    thinking: visibleThinking,
    tgMessageId: null,
    piEntryId: piEntryId ?? null,
  });
  onPersisted?.();
  await input.onAwaitingDelivery?.({
    assistantMessageId: assistantMessage.id,
    provider: inference?.provider,
    model: inference?.model,
    usage: inference?.usage,
  });
  const thinkingIds = [...(thinkingDelivery?.messageIds ?? [])];
  const answerIds: number[] = [];
  const ownsBuffers = !input.outgoingBuffers;
  input = { ...input, outgoingBuffers: input.outgoingBuffers ?? new OutgoingBuffers() };
  const preparation = createAttachmentPreparation(input, outboundAttachments);
  preparation.start();
  try {
    for (const rich of thinkingMessages) {
      const sent = await sendRichWithFallback(input, rich);
      thinkingIds.push(...sent.map((message) => message.message_id));
    }
    for (const rich of answerMessages) {
      const sent = await sendRichWithFallback(input, rich);
      answerIds.push(...sent.map((message) => message.message_id));
      if (input.deliveryTiming) input.deliveryTiming.firstTextMs ??= Date.now() - input.deliveryTiming.startedAt;
    }
    await sendCreatedFileAttachments(input, assistantMessage, outboundAttachments, preparation);
  } catch (error) {
    if (isDefinitiveTelegramRejection(error)) {
      await input.onDeliveryFailed?.({
        assistantMessageId: assistantMessage.id,
        failureCode: "telegram_delivery_rejected",
      });
    } else {
      await input.onDeliveryUnknown?.({
        assistantMessageId: assistantMessage.id,
        failureCode: "telegram_delivery_unknown",
      });
    }
    throw error;
  } finally {
    await preparation.close();
    if (ownsBuffers) await input.outgoingBuffers?.dispose();
  }
  const generatedAttachments = outboundAttachments.filter((attachment) =>
    attachment.origin === "generated_image");
  const retainedAttachments = outboundAttachments.filter((attachment) => attachment.telegramDelivery);
  const unknownAttachments = outboundAttachments.filter((attachment) =>
    !attachment.telegramDelivery && attachment.telegramDeliveryUnknown);
  const attachmentFailures = outboundAttachments.filter((attachment) => attachment.telegramDeliveryFailure);
  const generatedDeliveryFailed = generatedAttachments.length > 0
    && generatedAttachments.every((attachment) =>
      !attachment.telegramDelivery && !attachment.telegramDeliveryUnknown);
  const strictPhotoDeliveryFailed = outboundAttachments.some((attachment) =>
    attachment.delivery === "photo"
    && attachment.photoFallback === "none"
    && !attachment.telegramDelivery
    && Boolean(attachment.telegramDeliveryFailure || attachment.telegramDeliveryUnknown));
  const everyRegularAttachmentFailed = !deliveredAnswer.trim()
    && outboundAttachments.length > 0
    && retainedAttachments.length === 0
    && unknownAttachments.length === 0
    && attachmentFailures.length === outboundAttachments.length;
  if (generatedDeliveryFailed || strictPhotoDeliveryFailed || everyRegularAttachmentFailed) {
    deliveredAnswer = input.t(generatedDeliveryFailed || strictPhotoDeliveryFailed ? "image-delivery-failed" : "file-delivery-failed");
    try {
      for (const rich of renderFinalAnswer({ answerMd: deliveredAnswer })) {
        const sent = await sendRichWithFallback(input, rich);
        answerIds.push(...sent.map((message) => message.message_id));
      }
    } catch (error) {
      if (isDefinitiveTelegramRejection(error)) {
        await input.onDeliveryFailed?.({
          assistantMessageId: assistantMessage.id,
          failureCode: "telegram_delivery_rejected",
        });
      } else {
        await input.onDeliveryUnknown?.({
          assistantMessageId: assistantMessage.id,
          failureCode: "telegram_delivery_unknown",
        });
      }
      throw error;
    }
  }
  const persistedText = deliveredAnswer.trim() ? deliveredAnswer : attachmentPersistedText(retainedAttachments);
  const persistedContent: Record<string, unknown> = { text: persistedText };
  if (retainedAttachments.length) {
    persistedContent.files = retainedAttachments.map((file) => ({
      id: file.fileId,
      type: file.type,
      name: file.name,
      inline: file.inline,
      delivery: file.delivery ?? "document",
    }));
  }
  if (attachmentFailures.length) {
    // This operational record is intentionally not rendered to Telegram. The product
    // policy keeps partial source-recovery failures silent while retaining diagnostics.
    persistedContent.attachment_failures = attachmentFailures.map((file) => ({
      file_id: file.fileId,
      status: file.telegramDeliveryFailure,
    }));
  }
  if (unknownAttachments.length) {
    persistedContent.attachment_delivery_unknown = unknownAttachments.map((file) => ({
      file_id: file.fileId,
      status: "delivery_unknown",
    }));
  }
  const attachmentMessageId = retainedAttachments
    .map((attachment) => attachment.telegramDelivery?.messageId)
    .find((id) => typeof id === "number" && id > 0);
  await retryFinalizedAssistantContentWrite(input, assistantMessage.id, () =>
    input.repos.messages.setDeliveryContent({
      messageId: assistantMessage.id,
      content: persistedContent,
      textPlain: persistedText,
      tgMessageId: answerIds.find((id) => id > 0)
        ?? thinkingIds.find((id) => id > 0)
        ?? attachmentMessageId
        ?? null,
    }));
  input.logger.info("assistant message persisted", {
    threadId: input.thread.id,
    messageId: assistantMessage.id,
    telegramMessages: thinkingIds.length + answerIds.length,
    files: retainedAttachments.length,
    unknownFiles: unknownAttachments.length,
    failedFiles: attachmentFailures.length,
  });
  await input.onDeliveryConfirmed?.({ assistantMessageId: assistantMessage.id });
  return {
    assistantMessageId: assistantMessage.id,
    thinkingMessageIds: thinkingIds,
  };
}

export async function sendFinalThinkingVisible(
  input: TurnInput,
  visibleThinking: string,
  elapsedMs: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (const rich of renderFinalThinking({
    thinkingLog: visibleThinking,
    elapsedMs,
    t: input.t,
  })) {
    const sent = await sendRichWithFallback(input, rich);
    ids.push(...sent.map((message) => message.message_id));
  }
  return ids;
}

export async function refreshFinalThinkingVisible(
  input: TurnInput,
  existingMessageIds: number[],
  visibleThinking: string,
  elapsedMs: number,
): Promise<number[]> {
  const messages = renderFinalThinking({
    thinkingLog: visibleThinking,
    elapsedMs,
    t: input.t,
  });
  const existing = existingMessageIds.filter((id) => id > 0);
  if (existing.length) {
    const sharedParts = Math.min(existing.length, messages.length);
    for (let index = 0; index < sharedParts; index += 1) {
      const edited = await editFinalThinkingVisible(input, existing[index]!, messages[index]!);
      if (!edited) return existingMessageIds;
    }

    const updatedIds = [...existing];
    for (const rich of messages.slice(sharedParts)) {
      const sent = await sendRichWithFallback(input, rich);
      updatedIds.push(...sent.map((message) => message.message_id).filter((id) => id > 0));
    }

    if (existing.length > messages.length) {
      const staleIds = existing.slice(messages.length);
      const retainedStaleIds: number[] = [];
      for (const messageId of staleIds) {
        try {
          await input.api.deleteMessage(input.chatId, messageId);
        } catch (error) {
          retainedStaleIds.push(messageId);
          input.logger.warn("failed to delete stale multipart final-thinking message", {
            threadId: input.thread.id,
            telegramMessageId: messageId,
            err: String(error),
          });
        }
      }
      return [...updatedIds.slice(0, messages.length), ...retainedStaleIds];
    }
    return updatedIds;
  }
  const sent = await sendFinalThinkingVisible(input, visibleThinking, elapsedMs);
  return [...existingMessageIds, ...sent];
}

async function editFinalThinkingVisible(
  input: TurnInput,
  messageId: number,
  rich: InputRichMessage,
): Promise<boolean> {
  const variants = [rich, ...variantsForRichRetry(rich.markdown ?? rich.html ?? "")];
  const seen = new Set<string>();
  for (const variant of variants) {
    const hash = JSON.stringify(variant);
    if (seen.has(hash)) continue;
    seen.add(hash);
    try {
      const edited = await editRich(input.api, {
        chat_id: input.chatId,
        message_id: messageId,
        rich_message: variant,
      });
      if (edited) return true;
    } catch (err) {
      if (!isRichParseError(err)) throw err;
      input.logger.debug("final thinking edit parse failed; trying repaired variant", {
        threadId: input.thread.id,
        telegramMessageId: messageId,
        err: String(err),
      });
    }
  }
  input.logger.warn("failed to edit stale final thinking; leaving the existing message unchanged", {
    threadId: input.thread.id,
    telegramMessageId: messageId,
  });
  return false;
}

export async function sendCreatedFileAttachments(
  input: TurnInput,
  assistantMessage: MessageRow,
  attachments: CreatedFileAttachment[],
  preparation?: AttachmentPreparation,
): Promise<void> {
  if (!attachments.length) return;
  normalizeTelegramAttachmentDeliveries(attachments);
  const ownsBuffers = !input.outgoingBuffers;
  input = { ...input, outgoingBuffers: input.outgoingBuffers ?? new OutgoingBuffers() };
  const pipeline = preparation ?? createAttachmentPreparation(input, attachments);
  try {
    for (let index = 0; index < pipeline.batches.length; index++) {
      const ready = await pipeline.ready(index);
      // Exactly two preparation workers overlap the next batch with this upload.
      pipeline.start(index + 1);
      await sendAttachmentBatch(input, assistantMessage, ready,
        ready[0]?.delivery === "photo" ? photoSendStrategy : documentSendStrategy);
    }
  } finally {
    if (!preparation) await pipeline.close();
    if (ownsBuffers) await input.outgoingBuffers?.dispose();
  }
}

function createAttachmentPreparation(input: TurnInput, attachments: CreatedFileAttachment[]): AttachmentPreparation {
  return new AttachmentPreparation({
    attachments,
    buffers: input.outgoingBuffers!,
    signal: input.signal,
    load: async (attachment, signal) => {
      if (!input.resolveFile) throw new Error("Chat file resolution is unavailable.");
      const stored = await input.repos.files.get(attachment.fileId);
      if (!stored) throw new Error(`Attachment file #${attachment.fileId} no longer exists.`);
      return (await input.resolveFile(stored, signal)).bytes;
    },
    onPrepared: (attachment, ms, error) => {
      if (error && !input.signal?.aborted) attachment.telegramDeliveryFailure = "source_unavailable";
      input.logger.info("outgoing attachment prepared", {
        threadId: input.thread.id, turnRunId: input.turnRunId, fileId: attachment.fileId,
        preparationMs: ms, bytes: attachment.size, error: error ? String(error) : undefined,
        ...input.outgoingBuffers?.snapshot(),
      });
    },
  });
}

export function normalizeTelegramAttachmentDeliveries(
  attachments: CreatedFileAttachment[],
): void {
  for (const attachment of attachments) {
    if (
      attachment.delivery === "photo"
      && attachment.size > TG_PHOTO_MAX_BYTES
      && attachment.photoFallback !== "none"
    ) {
      attachment.delivery = "document";
    }
  }
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
    await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, undefined).catch((error) => {
      input.logger.warn("failed to persist previously delivered attachment", {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        fileId: attachment.fileId,
        telegramMessageId: attachment.telegramDelivery?.messageId,
        err: String(error),
      });
    });
  }
  const ready = attachments.filter((file) => !file.telegramDelivery && !file.telegramDeliveryUnknown);
  if (!ready.length) return;
  if (ready.length === 1) {
    await sendOneBufferedAttachment(input, assistantMessage, ready[0]!, strategy);
    return;
  }
  let sent: SentTelegramFileMessage[];
  try {
    sent = await strategy.sendGroup(input, ready);
    if (sent.length !== ready.length || sent.some((message) => !Number.isSafeInteger(message?.message_id))) {
      throw new Error("Telegram returned an incomplete media group acknowledgment.");
    }
  } catch (err) {
    if (!isDefinitiveTelegramRejection(err)) {
      for (const attachment of ready) {
        attachment.telegramDeliveryUnknown = true;
        releaseAttachmentData(input, attachment);
      }
      input.logger.warn(`${strategy.label} media group delivery outcome is unknown; not retrying`, {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        files: ready.length,
        fileIds: ready.map((attachment) => attachment.fileId),
        err: String(err),
      });
      return;
    }
    input.logger.warn(`failed to send ${strategy.label} media group; retrying files individually`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      files: ready.length,
      fileIds: ready.map((attachment) => attachment.fileId),
      err: String(err),
    });
    for (const attachment of ready) {
      await sendOneBufferedAttachment(input, assistantMessage, attachment, strategy);
    }
    return;
  }
  for (let index = 0; index < ready.length; index += 1) {
    ready[index]!.telegramDelivery = telegramDeliveryFromSent(sent[index]!);
    releaseAttachmentData(input, ready[index]!);
  }
  for (const attachment of ready) {
    await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, undefined).catch((error) => {
      input.logger.warn(`failed to persist delivered ${strategy.label}`, {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        fileId: attachment.fileId,
        telegramMessageId: attachment.telegramDelivery?.messageId,
        err: String(error),
      });
    });
  }
  input.logger.info(`${strategy.label} media group sent`, {
    threadId: input.thread.id,
    messageId: assistantMessage.id,
    files: ready.length,
    telegramMessages: sent.map((message) => message.message_id),
  });
}

async function sendOneBufferedAttachment(
  input: TurnInput,
  assistantMessage: MessageRow,
  attachment: CreatedFileAttachment,
  strategy: AttachmentSendStrategy,
): Promise<void> {
  let failure: unknown;
  try {
    const sent = await strategy.sendOne(input, attachment);
    attachment.telegramDelivery = telegramDeliveryFromSent(sent);
    releaseAttachmentData(input, attachment);
    await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, undefined);
    input.logger.info(`${strategy.label} sent`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      fileId: attachment.fileId,
      telegramMessageId: sent.message_id,
      name: attachment.name,
    });
    return;
  } catch (error) {
    failure = error;
  }
  if (attachment.telegramDelivery) {
    input.logger.warn(`failed to persist delivered ${strategy.label}`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      fileId: attachment.fileId,
      telegramMessageId: attachment.telegramDelivery.messageId,
      err: String(failure),
    });
    return;
  }
  if (!isDefinitiveTelegramRejection(failure)) {
    attachment.telegramDeliveryUnknown = true;
    releaseAttachmentData(input, attachment);
    input.logger.warn(`${strategy.label} delivery outcome is unknown; not retrying`, {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      fileId: attachment.fileId,
      name: attachment.name,
      err: String(failure),
    });
    return;
  }
  if (strategy === photoSendStrategy && attachment.photoFallback !== "none") {
    try {
      const sent = await documentSendStrategy.sendOne(input, attachment);
      attachment.delivery = "document";
      attachment.telegramDelivery = telegramDeliveryFromSent(sent);
      releaseAttachmentData(input, attachment);
      await rememberSentCreatedFileAttachment(input, assistantMessage, attachment, undefined);
      input.logger.info("generated image sent as a document after photo rejection", {
        threadId: input.thread.id,
        messageId: assistantMessage.id,
        fileId: attachment.fileId,
        telegramMessageId: sent.message_id,
        name: attachment.name,
      });
      return;
    } catch (error) {
      failure = error;
    }
  }
  if (attachment.telegramDelivery) {
    input.logger.warn("failed to persist delivered created file attachment", {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      fileId: attachment.fileId,
      telegramMessageId: attachment.telegramDelivery.messageId,
      err: String(failure),
    });
    return;
  }
  if (!isDefinitiveTelegramRejection(failure)) {
    attachment.telegramDeliveryUnknown = true;
    releaseAttachmentData(input, attachment);
    input.logger.warn("created file attachment delivery outcome is unknown; not retrying", {
      threadId: input.thread.id,
      messageId: assistantMessage.id,
      fileId: attachment.fileId,
      name: attachment.name,
      err: String(failure),
    });
    return;
  }
  input.logger.warn(`failed to send ${strategy.label}`, {
    threadId: input.thread.id,
    messageId: assistantMessage.id,
    fileId: attachment.fileId,
    name: attachment.name,
    err: String(failure),
  });
  attachment.telegramDeliveryFailure = "telegram_rejected";
  releaseAttachmentData(input, attachment);
  await removeUnresolvableUndeliveredAttachment(input, attachment);
}

function releaseAttachmentData(input: TurnInput, attachment: CreatedFileAttachment): void {
  if (attachment.telegramDelivery && input.deliveryTiming) {
    const elapsed = Date.now() - input.deliveryTiming.startedAt;
    input.deliveryTiming.firstFileMs ??= elapsed;
    input.deliveryTiming.lastFileMs = elapsed;
  }
  input.outgoingBuffers?.release(attachment);
  attachment.data = undefined;
}

function isDefinitiveTelegramRejection(error: unknown): boolean {
  // The bot-level grammY autoRetry transformer handles flood waits, HTTP
  // failures, and 5xx responses before they can reach this delivery layer.
  // If one still escapes, its acceptance state is ambiguous and must not be
  // retried here because Telegram has no idempotency key for media sends.
  return error instanceof GrammyError
    && error.error_code >= 400
    && error.error_code < 500
    && error.error_code !== 429;
}

async function removeUnresolvableUndeliveredAttachment(
  input: TurnInput,
  attachment: CreatedFileAttachment,
): Promise<void> {
  if (attachment.telegramDelivery?.fileId) return;
  try {
    const stored = await input.repos.files.get(attachment.fileId);
    if (!stored) return;
    const sources = await input.repos.files.listSources(attachment.fileId);
    if (sources.length) return;
    await input.repos.files.deleteFile(attachment.fileId);
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
  const delivery = attachment.telegramDelivery ?? (sent ? telegramDeliveryFromSent(sent) : undefined);
  if (delivery) attachment.telegramDelivery = delivery;
  await rememberTelegramDeliverySource(input, attachment);
  await retryTelegramDeliveryMetadataWrite(input, attachment, "message association", () =>
    input.repos.files.setMessageId(attachment.fileId, assistantMessage.id, {
      displayName: attachment.name,
      caption: attachment.caption ?? null,
    }));
}

async function rememberTelegramDeliverySource(input: TurnInput, attachment: CreatedFileAttachment): Promise<void> {
  const delivery = attachment.telegramDelivery;
  if (!delivery?.fileId) return;
  await retryTelegramDeliveryMetadataWrite(input, attachment, "Telegram source", () =>
    input.repos.files.rememberTelegramObservation(attachment.fileId, telegramFileSource({
      fileId: delivery.fileId!,
      fileUniqueId: delivery.fileUniqueId,
      mimeType: attachment.type === "image"
        ? attachment.delivery === "photo" ? "image/jpeg" : attachment.mimeType ?? null
        : null,
    }), {
      direction: "outbound",
      mediaKind: attachment.delivery === "photo" ? "photo" : "document",
      telegramMessageId: delivery.messageId,
      refs: delivery.refs?.length
        ? delivery.refs
        : [{
          fileId: delivery.fileId!,
          fileUniqueId: delivery.fileUniqueId,
          primary: true,
        }],
    }));
}

async function retryTelegramDeliveryMetadataWrite(
  input: TurnInput,
  attachment: CreatedFileAttachment,
  label: string,
  write: () => Promise<unknown>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        input.logger.warn(`retrying delivered attachment ${label} write`, {
          threadId: input.thread.id,
          fileId: attachment.fileId,
          telegramMessageId: attachment.telegramDelivery?.messageId,
          err: String(error),
        });
      }
    }
  }
  throw lastError;
}

async function retryFinalizedAssistantContentWrite(
  input: TurnInput,
  messageId: number,
  write: () => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      lastError = error;
      input.logger.warn("finalized assistant content write failed", {
        threadId: input.thread.id,
        messageId,
        attempt,
        retrying: attempt < 3,
        err: String(error),
      });
      if (attempt < 3) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

type SentTelegramPhotoSize = { file_id?: string; file_unique_id?: string; width?: number; height?: number; file_size?: number };

type SentTelegramFileMessage = {
  message_id: number;
  document?: { file_id?: string; file_unique_id?: string; file_size?: number };
  photo?: SentTelegramPhotoSize[];
};

function telegramDeliveryFromSent(sent: SentTelegramFileMessage): NonNullable<CreatedFileAttachment["telegramDelivery"]> {
  const fileRecord = sent.document ?? largestTelegramPhoto(sent.photo);
  const refs = sent.document
    ? sent.document.file_id
      ? [{
        fileId: sent.document.file_id,
        fileUniqueId: sent.document.file_unique_id?.trim() || null,
        width: null,
        height: null,
        size: sent.document.file_size ?? null,
        primary: true,
      }]
      : []
    : (sent.photo ?? []).flatMap((photo) => photo.file_id ? [{
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id?.trim() || null,
      width: photo.width ?? null,
      height: photo.height ?? null,
      size: photo.file_size ?? null,
      primary: photo.file_id === fileRecord?.file_id,
    }] : []);
  return {
    messageId: sent.message_id,
    fileId: fileRecord?.file_id?.trim() || null,
    fileUniqueId: fileRecord?.file_unique_id?.trim() || null,
    refs,
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
  const combinedCaption = combinedPhotoCaption(attachments);
  return attachments.map((attachment, index) => ({
    type: "photo" as const,
    media: attachmentInput(attachment),
    caption: index === 0 ? combinedCaption?.caption : undefined,
    parse_mode: index === 0 ? combinedCaption?.parseMode : undefined,
  }));
}

function combinedPhotoCaption(
  attachments: CreatedFileAttachment[],
): { caption: string; parseMode?: "HTML" } | undefined {
  const captions = attachments.flatMap((attachment, index) => {
    const caption = attachment.caption?.trim();
    return caption ? [{ index, caption }] : [];
  });
  if (!captions.length) return undefined;
  if (captions.length === 1 && captions[0]!.index === 0) {
    return { caption: truncateCaption(captions[0]!.caption) };
  }
  const combined = captions
    .map(({ index, caption }) => `Photo ${index + 1}: ${caption}`)
    .join("\n");
  return {
    caption: `<blockquote>${escapeHtml(truncateCaption(combined))}</blockquote>`,
    parseMode: "HTML",
  };
}

function truncateCaption(caption: string): string {
  const characters = Array.from(caption);
  if (characters.length <= TG_CAPTION_LIMIT) return caption;
  return `${characters.slice(0, TG_CAPTION_LIMIT - 3).join("")}...`;
}

function attachmentInput(attachment: CreatedFileAttachment): InputFile {
  if (attachment.data) return new InputFile(attachment.data, attachment.name);
  throw new Error(`Attachment ${attachment.name} has no in-memory data`);
}

function documentFallbackCaption(title: string, attachment: CreatedFileAttachment): string {
  const text = prefixPlainForThreadFallback(title, attachment.caption || attachment.name);
  return text.length <= TG_CAPTION_LIMIT ? text : `${text.slice(0, TG_CAPTION_LIMIT - 3)}...`;
}

function attachmentPersistedText(attachments: CreatedFileAttachment[]): string {
  if (!attachments.length) return "";
  const generatedImages = attachments.filter((attachment) => attachment.origin === "generated_image");
  const files = attachments;
  const names = files.map((file) => file.caption?.trim() || file.name).filter(Boolean).join(", ");
  if (generatedImages.length === files.length) return `Generated image: ${names}`;
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
  try {
    const sent = await sendRichMessageWithThreadFallback(input, rich);
    return [sent];
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
      return [sent];
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

export function sendPlainWithThreadFallback(
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
