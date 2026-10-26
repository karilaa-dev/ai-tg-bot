import { Api, InputFile } from "grammy";
import { z } from "zod";
import type { Repos } from "../db/repos/index.js";
import type { MessageRow, TurnRunRow } from "../db/types.js";
import type { FileResolver } from "../files/resolver.js";
import { telegramFileSource } from "../files/telegramSource.js";
import { prefixPlainForThreadFallback, withThreadNotFoundFallback } from "../telegram/richApi.js";
import { silentSends } from "../telegram/silent.js";
import { escapeHtml } from "../util/text.js";

/** A per-turn client, so a web turn's reply threading never leaks into concurrent turns. */
export function quietTelegramApi(base: Api): Api {
  const api = new Api(base.token, base.options);
  api.config.use(...base.config.installedTransformers());
  api.config.use(silentSends());
  return api;
}

/** Installed only after the user's echo, on the web turn's private API client. */
export function replyToWebMessage(api: Api, chatId: number, messageId: number): void {
  api.config.use((previous, method, payload, signal) => previous(method,
    method.startsWith("send") && method !== "sendChatAction" && !method.endsWith("Draft")
      && "chat_id" in payload && payload.chat_id === chatId
      ? { ...payload, reply_parameters: "reply_parameters" in payload && payload.reply_parameters
        ? payload.reply_parameters : { message_id: messageId, allow_sending_without_reply: true } }
      : payload, signal));
}

const webContent = z.object({ webText: z.string(), files: z.array(z.object({ id: z.uuid() })).optional() });

export async function mirrorWebMessage(input: {
  api: Api; run: TurnRunRow; message: MessageRow; title: string; repos: Repos; resolver: FileResolver; signal: AbortSignal;
}): Promise<void> {
  const { api, run, message, repos, signal } = input;
  const parsed = webContent.safeParse(JSON.parse(message.content_json));
  const text = parsed.success ? parsed.data.webText : message.text_plain;
  const topic = run.message_thread_id === null ? {} : { message_thread_id: run.message_thread_id };
  let firstId: number | null = null;
  // One compact line marks the echo as sent from the website. Unicode iteration avoids splitting a surrogate pair at Telegram's limit.
  const caption = run.locale === "ru" ? "🌐 С сайта" : "🌐 From the website";
  const characters = Array.from(text || (run.locale === "ru" ? "Прикреплён файл" : "Shared an attachment"));
  while (characters.length) {
    signal.throwIfAborted();
    const chunk: string = `${firstId === null ? "🌐 " : ""}${escapeHtml(characters.splice(0, 1800).join(""))}`;
    const sent = await withThreadNotFoundFallback({ messageThreadId: run.message_thread_id ?? undefined },
      () => api.sendMessage(run.chat_id, chunk, { ...topic, disable_notification: true, parse_mode: "HTML" }, signal as Parameters<Api["sendMessage"]>[3]),
      () => api.sendMessage(run.chat_id, prefixPlainForThreadFallback(input.title, chunk, true), { disable_notification: true, parse_mode: "HTML" }, signal as Parameters<Api["sendMessage"]>[3]));
    firstId ??= sent.message_id;
  }
  await repos.messages.setDeliveryContent({ messageId: message.id, content: JSON.parse(message.content_json), textPlain: message.text_plain, tgMessageId: firstId });
  for (const ref of parsed.success ? parsed.data.files ?? [] : []) {
    const file = await repos.files.get(ref.id);
    if (!file || file.user_id !== run.user_id || file.thread_id !== run.thread_id || file.message_id !== message.id) throw new Error("Web attachment ownership mismatch.");
    const resolved = await input.resolver.resolveFile(file, signal);
    const sent = await withThreadNotFoundFallback({ messageThreadId: run.message_thread_id ?? undefined },
      () => api.sendDocument(run.chat_id, new InputFile(resolved.bytes, file.name), {
        ...topic, disable_notification: true, caption, parse_mode: "HTML",
      }, signal as Parameters<Api["sendDocument"]>[3]),
      () => api.sendDocument(run.chat_id, new InputFile(resolved.bytes, file.name), {
        disable_notification: true, caption: prefixPlainForThreadFallback(input.title, caption, true), parse_mode: "HTML",
      }, signal as Parameters<Api["sendDocument"]>[3]));
    await repos.files.rememberTelegramObservation(file.id, telegramFileSource({
      fileId: sent.document.file_id, fileUniqueId: sent.document.file_unique_id, mimeType: file.mime_type,
    }), { direction: "outbound", mediaKind: "document", telegramMessageId: sent.message_id,
      refs: [{ fileId: sent.document.file_id, fileUniqueId: sent.document.file_unique_id,
        size: sent.document.file_size ?? null, primary: true }] });
  }
}
