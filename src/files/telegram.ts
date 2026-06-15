import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import { throwIfAborted } from "./cancel.js";

export interface DownloadedTelegramFile {
  bytes: Buffer;
  filePath?: string;
}

export type TelegramFileDownloader = (input: {
  api: Api;
  config: AppConfig;
  fileId: string;
  signal?: AbortSignal;
}) => Promise<DownloadedTelegramFile>;

export const downloadTelegramFile: TelegramFileDownloader = async (input) => {
  const file = await input.api.getFile(input.fileId);
  if (!file.file_path) throw new Error("Telegram did not return file_path");
  throwIfAborted(input.signal);
  const url = `https://api.telegram.org/file/bot${input.config.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: input.signal });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  throwIfAborted(input.signal);
  return { bytes: Buffer.from(await res.arrayBuffer()), filePath: file.file_path };
};
