import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  buildFinalThinkingSummary,
  normalizeTelegramAttachmentDeliveries,
  refreshFinalThinkingVisible,
  sendCreatedFileAttachments,
  sendFinal,
  type TurnInput,
} from "../../src/ai/run.js";
import type { CreatedFileAttachment } from "../../src/ai/tools/types.js";
import { StreamShaper } from "../../src/ai/shaper.js";
import { renderFinalThinking } from "../../src/telegram/render.js";

describe("buffered Telegram attachment delivery", () => {
  it("keeps the original requested count when only delivered files are summarized", () => {
    const delivered = Array.from({ length: 25 }, (_, index) =>
      imageAttachment(index + 1, `${index + 1}.jpg`, 100));
    const summary = buildFinalThinkingSummary({
      t: (key, params) => `${key}:${JSON.stringify(params)}`,
      shaper: new StreamShaper(),
      attachments: delivered,
      requestedAttachmentCount: 30,
    });

    expect(summary).toContain('thinking-final-files-capped:{"sent":25,"requested":30,"limit":25}');
    expect(summary).toContain("<code>1.jpg</code>");
    expect(summary).toContain("<code>25.jpg</code>");
  });

  it("reports the confirmed count when a capped delivery is only partially successful", () => {
    const delivered = Array.from({ length: 20 }, (_, index) =>
      imageAttachment(index + 1, `${index + 1}.jpg`, 100));
    const summary = buildFinalThinkingSummary({
      t: (key, params) => `${key}:${JSON.stringify(params)}`,
      shaper: new StreamShaper(),
      attachments: delivered,
      requestedAttachmentCount: 30,
    });

    expect(summary).toContain('thinking-final-files-capped:{"sent":20,"requested":30,"limit":25}');
    expect(summary).not.toContain('thinking-final-files-capped:{"sent":25');
  });

  it("keeps confirmed file names when verbose reasoning is capped", () => {
    const shaper = new StreamShaper();
    shaper.onReasoningStart();
    shaper.onReasoningDelta("reasoning ".repeat(20_000));
    const summary = buildFinalThinkingSummary({
      t: (key) => key,
      shaper,
      attachments: [imageAttachment(1, "confirmed.jpg", 100)],
    });

    const rendered = renderFinalThinking({ thinkingLog: summary, elapsedMs: 0, t: (key) => key });

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.markdown).toContain("confirmed.jpg");
  });

  it("refreshes multipart thinking deliveries and removes stale fallback parts", async () => {
    const api = fakeApi();
    const input = turnInput(api);

    await expect(refreshFinalThinkingVisible(input, [701, 702], "updated thinking", 0))
      .resolves.toEqual([701]);

    expect(api.raw.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ message_id: 701 }));
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 702);
  });

  it("downgrades oversized generated images before attachment delivery", () => {
    const oversized = imageAttachment(1, "large.jpg", 15 * 1024 * 1024);
    oversized.origin = "generated_image";

    normalizeTelegramAttachmentDeliveries([oversized]);

    expect(oversized.delivery).toBe("document");
  });

  it("sends final thinking before a captioned generated image without a completion reply", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const attachment = imageAttachment(1, "generated.jpg", 100);
    attachment.origin = "generated_image";
    attachment.caption = "A pear with the cat's face";

    await sendFinal(input, "Image generation details", "", 1000, [attachment]);

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.raw.sendRichMessage.mock.invocationCallOrder[0])
      .toBeLessThan(api.sendPhoto.mock.invocationCallOrder[0]!);
    expect(api.sendPhoto).toHaveBeenCalledWith(123, expect.anything(), expect.objectContaining({
      caption: "A pear with the cat's face",
    }));
  });

  it("does not deliver a generated image when assistant persistence fails", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    vi.mocked(input.repos.messages.insert).mockRejectedValueOnce(new Error("database unavailable"));
    const attachment = imageAttachment(1, "generated.jpg", 100);
    attachment.origin = "generated_image";
    attachment.caption = "Generated image";

    await expect(sendFinal(input, "Image generation details", "", 1000, [attachment]))
      .rejects.toThrow("database unavailable");

    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
    expect(attachment.telegramDelivery).toBeUndefined();
  });

  it("persists the assistant result before delivery and does not retry an ambiguous final send", async () => {
    const api = fakeApi();
    api.raw.sendRichMessage.mockRejectedValueOnce(new Error("connection reset after write"));
    const input = turnInput(api);
    input.onDeliveryUnknown = vi.fn(async () => undefined);

    await expect(sendFinal(input, "", "Persist me first"))
      .rejects.toThrow("connection reset after write");

    expect(input.repos.messages.insert).toHaveBeenCalledOnce();
    expect(api.raw.sendRichMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(input.repos.messages.insert).mock.invocationCallOrder[0])
      .toBeLessThan(api.raw.sendRichMessage.mock.invocationCallOrder[0]!);
    expect(input.onDeliveryUnknown).toHaveBeenCalledWith(expect.objectContaining({
      assistantMessageId: 99,
      failureCode: "telegram_delivery_unknown",
    }));
  });

  it("does not persist or send a final answer after cancellation wins the delivery barrier", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    input.onDeliveryStarting = vi.fn(() => false);

    await expect(sendFinal(input, "", "cancelled"))
      .rejects.toThrow("Turn cancellation won the delivery race");

    expect(input.repos.messages.insert).not.toHaveBeenCalled();
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
  });

  it("sends a failure reply only when generated-image delivery is definitively rejected", async () => {
    const api = fakeApi();
    api.sendPhoto.mockRejectedValue(telegramError("Bad Request: photo rejected", "sendPhoto"));
    api.sendDocument.mockRejectedValue(telegramError("Bad Request: document rejected", "sendDocument"));
    const input = turnInput(api);
    const attachment = imageAttachment(1, "generated.jpg", 100);
    attachment.origin = "generated_image";
    attachment.caption = "Generated image";

    await sendFinal(input, "Image generation details", "", 1000, [attachment]);

    expect(attachment.telegramDelivery).toBeUndefined();
    expect(attachment.telegramDeliveryFailure).toBe("telegram_rejected");
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(api.raw.sendRichMessage.mock.calls[1])).toContain("image-delivery-failed");
    expect(api.sendDocument.mock.invocationCallOrder.at(-1))
      .toBeLessThan(api.raw.sendRichMessage.mock.invocationCallOrder.at(-1)!);
  });

  it("sends images over Telegram's photo limit as documents", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const attachment = imageAttachment(1, "large.jpg", 15 * 1024 * 1024);

    await sendCreatedFileAttachments(input, { id: 99 } as never, [attachment]);

    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
    expect(attachment.delivery).toBe("document");
  });

  it("retries failed photo groups individually and falls back to a document per rejected photo", async () => {
    const api = fakeApi();
    api.sendMediaGroup.mockRejectedValue(telegramError("Bad Request: one photo is too large", "sendMediaGroup"));
    api.sendPhoto
      .mockResolvedValueOnce(photoMessage(501, "photo-1"))
      .mockRejectedValueOnce(telegramError("Bad Request: photo rejected", "sendPhoto"));
    const input = turnInput(api);
    const first = imageAttachment(1, "first.jpg", 100);
    const second = imageAttachment(2, "second.jpg", 200);

    await sendCreatedFileAttachments(input, { id: 99 } as never, [first, second]);

    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(first.delivery).toBe("photo");
    expect(second.delivery).toBe("document");
    expect(input.repos.files.setMessageId).toHaveBeenCalledTimes(2);
  });

  it("does not retry a media group after an ambiguous transport failure", async () => {
    const api = fakeApi();
    api.sendMediaGroup.mockRejectedValue(new Error("request timed out after upload"));
    const input = turnInput(api);
    const first = imageAttachment(1, "first.jpg", 100);
    const second = imageAttachment(2, "second.jpg", 200);

    await sendCreatedFileAttachments(input, { id: 99 } as never, [first, second]);

    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(first.telegramDeliveryUnknown).toBe(true);
    expect(second.telegramDeliveryUnknown).toBe(true);
  });

  it("persists an ambiguous send in a separate operational bucket", async () => {
    const api = fakeApi();
    api.sendMediaGroup.mockRejectedValue(new Error("request timed out after upload"));
    const input = turnInput(api);
    const first = imageAttachment(1, "first.jpg", 100);
    const second = imageAttachment(2, "second.jpg", 200);

    await sendFinal(input, "", "", 0, [first, second]);

    expect(input.repos.messages.setDeliveryContent).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 99,
      content: {
        text: "",
        attachment_delivery_unknown: [
          { file_id: 1, status: "delivery_unknown" },
          { file_id: 2, status: "delivery_unknown" },
        ],
      },
    }));
    expect(input.repos.files.deleteFile).not.toHaveBeenCalled();
  });

  it("does not resend a photo when post-delivery bookkeeping fails", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    vi.mocked(input.repos.files.setMessageId).mockRejectedValueOnce(new Error("database unavailable"));
    const attachment = imageAttachment(1, "picture.jpg", 100);

    await sendCreatedFileAttachments(input, { id: 99 } as never, [attachment]);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(attachment.telegramDelivery).toMatchObject({ messageId: 500, fileId: "photo-file" });
  });

  it("retries the durable Telegram source before associating the delivered message", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    vi.mocked(input.repos.files.rememberTelegramObservation)
      .mockRejectedValueOnce(new Error("database temporarily unavailable"));
    const attachment = imageAttachment(1, "picture.jpg", 100);

    await sendCreatedFileAttachments(input, { id: 99 } as never, [attachment]);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(input.repos.files.rememberTelegramObservation).toHaveBeenCalledTimes(2);
    expect(input.repos.files.setMessageId).toHaveBeenCalledTimes(1);
    const sourceWrite = vi.mocked(input.repos.files.rememberTelegramObservation).mock.invocationCallOrder.at(-1)!;
    const messageWrite = vi.mocked(input.repos.files.setMessageId).mock.invocationCallOrder[0]!;
    expect(sourceWrite).toBeLessThan(messageWrite);
  });

  it("does not resend a media group when one delivery record fails", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    vi.mocked(input.repos.files.setMessageId).mockRejectedValueOnce(new Error("database unavailable"));
    const first = imageAttachment(1, "first.jpg", 100);
    const second = imageAttachment(2, "second.jpg", 200);

    await sendCreatedFileAttachments(input, { id: 99 } as never, [first, second]);

    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(first.telegramDelivery).toMatchObject({ messageId: 500, fileId: "photo-1" });
    expect(second.telegramDelivery).toMatchObject({ messageId: 501, fileId: "photo-2" });
    expect(input.repos.files.setMessageId).toHaveBeenCalledTimes(3);
  });

  it("splits large albums to bound simultaneously buffered file bytes", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const attachments = Array.from({ length: 4 }, (_, index) =>
      imageAttachment(index + 1, `${index + 1}.jpg`, 20 * 1024 * 1024));

    await sendCreatedFileAttachments(input, { id: 99 } as never, attachments);

    expect(api.sendMediaGroup).toHaveBeenCalledTimes(2);
    expect(api.sendMediaGroup.mock.calls.map((call) => call[1].length)).toEqual([2, 2]);
  });

  it("loads a sandbox attachment only for its send and releases the buffer afterward", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const attachment = imageAttachment(1, "picture.jpg", 100);
    attachment.data = undefined;
    vi.mocked(input.repos.files.get).mockResolvedValueOnce({ id: attachment.fileId } as never);
    input.resolveFile = vi.fn(async () => ({ bytes: Buffer.from("restored image") } as never));

    await sendCreatedFileAttachments(input, { id: 99 } as never, [attachment]);

    expect(input.resolveFile).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(attachment.data).toBeUndefined();
  });

  it("continues with readable files when one media-group source cannot be loaded", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const first = imageAttachment(1, "first.jpg", 100);
    const missing = imageAttachment(2, "missing.jpg", 100);
    const third = imageAttachment(3, "third.jpg", 100);
    missing.data = undefined;
    vi.mocked(input.repos.files.get).mockResolvedValueOnce({ id: missing.fileId } as never);
    input.resolveFile = vi.fn(async () => { throw new Error("source unavailable"); });

    await sendCreatedFileAttachments(input, { id: 99 } as never, [first, missing, third]);

    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendMediaGroup.mock.calls[0]?.[1]).toHaveLength(2);
    expect(first.telegramDelivery).toBeDefined();
    expect(missing.telegramDelivery).toBeUndefined();
    expect(missing.telegramDeliveryFailure).toBe("source_unavailable");
    expect(third.telegramDelivery).toBeDefined();
  });

  it("records a source-load failure without persisting the file as delivered", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const missing = imageAttachment(2, "missing.jpg", 100);
    missing.data = undefined;
    vi.mocked(input.repos.files.get).mockResolvedValueOnce({ id: missing.fileId } as never);
    input.resolveFile = vi.fn(async () => { throw new Error("source unavailable"); });

    await sendFinal(input, "", "", 0, [missing]);

    expect(input.repos.messages.setDeliveryContent).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 99,
      content: {
        text: "",
        attachment_failures: [{ file_id: 2, status: "source_unavailable" }],
      },
    }));
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  it("continues pending delivery when bookkeeping for an earlier photo fails", async () => {
    const api = fakeApi();
    const input = turnInput(api);
    const delivered = imageAttachment(1, "delivered.jpg", 100);
    delivered.telegramDelivery = {
      messageId: 400,
      fileId: "existing-photo",
      fileUniqueId: "existing-photo-unique",
    };
    const pending = imageAttachment(2, "pending.jpg", 100);
    vi.mocked(input.repos.files.setMessageId).mockRejectedValueOnce(new Error("database unavailable"));

    await sendCreatedFileAttachments(input, { id: 99 } as never, [delivered, pending]);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(pending.telegramDelivery).toMatchObject({ messageId: 500, fileId: "photo-file" });
  });
});

function imageAttachment(fileId: number, name: string, size: number): CreatedFileAttachment {
  return {
    fileId,
    type: "image",
    name,
    mimeType: "image/jpeg",
    data: Buffer.from(`image-${fileId}`),
    size,
    caption: null,
    inline: false,
    card: `image ${fileId}`,
    delivery: "photo",
    origin: "created_file",
  };
}

function fakeApi() {
  return {
    raw: {
      editMessageText: vi.fn(async () => true),
      sendRichMessage: vi.fn(async () => ({ message_id: 700 })),
    },
    deleteMessage: vi.fn(async () => true),
    sendDocument: vi.fn(async (_chatId: number) => ({
      message_id: 600,
      document: {
        file_id: "document-file",
        file_unique_id: "document-unique",
        file_size: 100,
      },
    })),
    sendPhoto: vi.fn(async () => photoMessage(500, "photo-file")),
    sendMediaGroup: vi.fn(async (_chatId: number, _media: unknown[]) => [
      photoMessage(500, "photo-1"),
      photoMessage(501, "photo-2"),
    ]),
  };
}

function photoMessage(messageId: number, fileId: string) {
  return {
    message_id: messageId,
    photo: [{
      file_id: fileId,
      file_unique_id: `${fileId}-unique`,
      width: 100,
      height: 100,
      file_size: 100,
    }],
  };
}

function telegramError(description: string, method: string): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed`,
    { ok: false, error_code: 400, description },
    method,
    {},
  );
}

function turnInput(api: ReturnType<typeof fakeApi>): TurnInput {
  return {
    api,
    chatId: 123,
    config: {} as never,
    db: {} as never,
    repos: {
      messages: {
        insert: vi.fn(async () => ({ id: 99 })),
        setDeliveryContent: vi.fn(async () => undefined),
        setThinking: vi.fn(async () => undefined),
      },
      files: {
        setMessageId: vi.fn(async () => undefined),
        rememberTelegramObservation: vi.fn(async () => undefined),
        get: vi.fn(async () => undefined),
        listSources: vi.fn(async () => []),
        deleteFile: vi.fn(async () => []),
      },
    } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      level: "error",
    },
    user: { tg_id: 1 } as never,
    thread: { id: 2, title: "Thread" } as never,
    text: "",
    t: (key: string) => key,
  } as unknown as TurnInput;
}
