import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeTelegramAttachmentDeliveries,
  sendCreatedFileAttachments,
  type TurnInput,
} from "../../src/ai/run.js";
import type { CreatedFileAttachment } from "../../src/ai/tools/types.js";

describe("buffered Telegram attachment delivery", () => {
  it("downgrades oversized generated images before the early photo path selects them", () => {
    const oversized = imageAttachment(1, "large.jpg", 15 * 1024 * 1024);
    oversized.origin = "generated_image";

    normalizeTelegramAttachmentDeliveries([oversized]);

    expect(oversized.delivery).toBe("document");
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
    expect(input.repos.files.setMessageId).toHaveBeenCalledTimes(2);
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
    expect(third.telegramDelivery).toBeDefined();
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
      files: {
        setMessageId: vi.fn(async () => undefined),
        rememberTelegramObservation: vi.fn(async () => undefined),
        get: vi.fn(async () => undefined),
        listSources: vi.fn(async () => []),
        deleteFile: vi.fn(async () => []),
      },
      embeddings: {
        deleteRefs: vi.fn(async () => undefined),
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
