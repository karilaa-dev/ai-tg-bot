import { describe, expect, it, vi } from "vitest";
import { sendCreatedFileAttachments, type TurnInput } from "../../src/ai/run.js";
import type { CreatedFileAttachment } from "../../src/ai/tools/types.js";

describe("buffered Telegram attachment delivery", () => {
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
    api.sendMediaGroup.mockRejectedValue(new Error("one photo is too large"));
    api.sendPhoto
      .mockResolvedValueOnce(photoMessage(501, "photo-1"))
      .mockRejectedValueOnce(new Error("photo rejected"));
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
    sendMediaGroup: vi.fn(async () => [photoMessage(500, "photo-1"), photoMessage(501, "photo-2")]),
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
