import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import { FileTooLargeError, MAX_FILE_BYTES } from "./limits.js";
import { throwIfAborted } from "./cancel.js";

interface DownloadedTelegramFile {
  bytes: Buffer;
  filePath?: string;
}

export type TelegramFileDownloader = (input: {
  api: Api;
  config: AppConfig;
  fileId: string;
  signal?: AbortSignal;
  maxBytes?: number;
}) => Promise<DownloadedTelegramFile>;

export const downloadTelegramFile: TelegramFileDownloader = async (input) => {
  const file = await input.api.getFile(
    input.fileId,
    input.signal as Parameters<Api["getFile"]>[1],
  );
  if (!file.file_path) throw new Error("Telegram did not return file_path");
  throwIfAborted(input.signal);
  const maxBytes = Math.min(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
  if (file.file_size !== undefined && file.file_size > maxBytes) throw new FileTooLargeError();
  const url = `https://api.telegram.org/file/bot${input.config.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: input.signal });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  throwIfAborted(input.signal);
  if (!res.body) throw new Error("Telegram file response has no body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) throw new FileTooLargeError();
    while (true) {
      throwIfAborted(input.signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new FileTooLargeError();
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks, size), filePath: file.file_path };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
