import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { TelegramFileDownloader } from "./telegram.js";
import type { ChatFileSource, ChatFileSourceAdapter } from "./source.js";

export const TELEGRAM_CONNECTION_KEY = "default";

export function telegramFileSource(input: {
  fileId: string;
  fileUniqueId?: string | null;
  mimeType?: string | null;
}): ChatFileSource {
  return {
    transport: "telegram",
    connectionKey: TELEGRAM_CONNECTION_KEY,
    remoteKey: input.fileUniqueId?.trim() || input.fileId,
    locator: {
      file_id: input.fileId,
      file_unique_id: input.fileUniqueId?.trim() || null,
    },
    mimeType: input.mimeType ?? null,
  };
}

export class TelegramFileSourceAdapter implements ChatFileSourceAdapter {
  readonly transport = "telegram";
  readonly connectionKey = TELEGRAM_CONNECTION_KEY;

  constructor(private readonly input: {
    api: Api;
    config: AppConfig;
    download: TelegramFileDownloader;
  }) {}

  async fetch(source: ChatFileSource, signal?: AbortSignal): Promise<Buffer> {
    const fileId = source.locator.file_id;
    if (typeof fileId !== "string" || !fileId.trim()) throw new Error("Telegram source has no file_id.");
    const downloaded = await this.input.download({
      api: this.input.api,
      config: this.input.config,
      fileId,
      signal,
    });
    return Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
  }
}
