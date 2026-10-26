import type { MessageRow } from "../db/types.js";
import type { WebAttachment, WebMessage } from "./types.js";
import { attachmentKind } from "./media.js";
import { safeOpenUi } from "../openui/validate.js";
import { asRecord } from "../util/records.js";
import { savedToolActivity } from "../ai/toolActivity.js";
import { resolveOpenUiLanguage } from "../openui/language.js";
import { savedCompactionAction } from "../application/compactionAction.js";

export interface SavedTranscript { id: string; messageId: number; fileId: string; text: string }
export interface SavedAttachment extends WebAttachment { inlineContent?: string | null }

/** Separate the bot's saved media cards from the words a person actually sent. */
export function messageView(message: MessageRow, attachments: SavedAttachment[], transcripts: SavedTranscript[] = [], attachmentDeliveryPending = false): WebMessage {
  const action = message.role === "system" ? savedCompactionAction(message.content_json) : undefined;
  const pending = message.role === "assistant" && attachmentDeliveryPending;
  const files = attachments.map(({ inlineContent, ...file }) => file);
  const visualization = !pending && message.role === "assistant" && message.text_plain.trim() ? savedOpenUi(message.content_json, message.text_plain) : undefined;
  const toolActivity = message.role === "assistant" ? savedMessageToolActivity(message.content_json) : undefined;
  const view = { id: message.id, threadId: message.thread_id, role: message.role, text: message.text_plain,
    thinking: toolActivity ? toolActivity.reasoning.join("\n\n") || null : message.thinking,
    createdAt: message.created_at, attachments: pending ? [] : files, ...visualization,
    ...(toolActivity ? { toolActivity } : {}),
    ...(savedTelegramSyncFailure(message.content_json) ? { telegramSyncFailed: true } : {}), ...(action ? { action } : {}) };
  if (message.kind === "text" && message.role !== "assistant") return view;
  const captions = savedCaptions(message.content_json, files);
  const visible: string[] = [];
  let cursor = 0;
  for (const marker of message.text_plain.matchAll(/^\[\[chat-file:([\da-f-]+)\]\] /gm)) {
    if (marker.index < cursor) continue;
    const file = files.find(file => file.id === marker[1]);
    if (!file) continue;
    const tail = message.text_plain.slice(marker.index + marker[0].length);
    const prefix = message.text_plain.slice(cursor, marker.index);
    const fileEnd = fileCardEnd(tail, file, attachments.find(saved => saved.id === file.id)?.inlineContent);
    if (fileEnd !== null) {
      visible.push(prefix);
      cursor = marker.index + marker[0].length + fileEnd;
      continue;
    }
    if (attachmentKind(file) === "image") {
      const start = tail.startsWith(`[image #${file.id}: `) ? `[image #${file.id}: `
        : tail.startsWith(`[Generated image #${file.id}: `) ? `[Generated image #${file.id}: ` : null;
      if (!start) continue;
      const exact = `${start}${file.description ?? file.name}]`;
      const end = tail.startsWith(exact) ? exact.length : bracketEnd(tail);
      if (end === null) continue;
      file.description = tail.slice(start.length, end - 1);
      visible.push(prefix);
      cursor = marker.index + marker[0].length + end;
    } else if (attachmentKind(file) === "audio") {
      const sourceCard = [JSON.stringify(file.id), file.id]
        .map(id => `Audio file #${file.id}: ${file.name}. Use transcribe_audio with file_id: ${id}.`)
        .find(card => tail.startsWith(card));
      if (sourceCard) {
        visible.push(prefix);
        cursor = marker.index + marker[0].length + sourceCard.length;
        continue;
      }
      const short = "[Audio message transcribed above]";
      const long = tail.match(/^\[Audio transcript preview; full transcript saved \(\d+ characters\)\. Read more with transcribe_audio\((\{[^\n]*\})\)\.\]/);
      const note = tail.startsWith(short) ? short : long?.[0];
      if (!note || prefix.includes("[[chat-file:")) continue;
      let spoken = prefix.trim();
      // Single messages and albums both retain captions separately in their payload.
      for (const caption of captions) {
        if (spoken.startsWith(`${caption}\n\n`)) {
          visible.push(caption);
          spoken = spoken.slice(caption.length).trimStart();
        }
      }
      let full: SavedTranscript | undefined;
      if (long) {
        try {
          const reference = JSON.parse(long[1]!);
          full = transcripts.find(t => t.id === reference.transcript_id && t.messageId === message.id && t.fileId === file.id);
        } catch { /* A malformed reference must not expose another transcript. */ }
      }
      file.transcription = full?.text ?? spoken;
      file.transcriptionTruncated = Boolean(long && !full);
      cursor = marker.index + marker[0].length + note.length;
    }
  }
  visible.push(message.text_plain.slice(cursor));
  view.text = visible.map(part => part.trim()).filter(Boolean).join("\n\n");
  return view;
}

export function attachmentDeliveryTurnId(message: MessageRow): number | undefined {
  if (message.role !== "assistant") return undefined;
  try {
    const turnId = asRecord(JSON.parse(message.content_json))?.attachmentDeliveryTurnId;
    return typeof turnId === "number" && Number.isSafeInteger(turnId) && turnId > 0 ? turnId : undefined;
  } catch { return undefined; }
}

function fileCardEnd(text: string, file: WebAttachment, inlineContent?: string | null): number | null {
  const prefix = `File #${file.id}: ${file.name} (`;
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length);
  const original = `${file.size} bytes, original file). Use materialize_chat_files to access the original bytes in the sandbox.`;
  if (body.startsWith(original)) return prefix.length + original.length;
  const inline = body.match(/^(?:txt|csv|pdf|docx|other), inline\)\.\n/);
  if (inline) {
    const opening = `${inline[0]}<attachment id="${file.id}" name="${file.name}">\n`;
    // Match the saved payload exactly: file contents may themselves contain closing tags or other cards.
    if (inlineContent == null) return null;
    const framed = `${opening}${inlineContent}\n</attachment>`;
    return body.startsWith(framed) ? prefix.length + framed.length : null;
  }
  const card = body.match(/^(?:txt|csv|pdf|docx|other), (?:sandbox source\)\. Use materialize_chat_files, then (?:PDF Inspector or render_pdf_pages|docx-cli)\.|\d+ chunks\)\.[\s\S]*?Use search_in_file or read_file_section\.)(?=\n\n|$)/);
  return card ? prefix.length + card[0].length : null;
}

function savedCaptions(content: string, files: WebAttachment[]): string[] {
  const captions = files.flatMap(file => file.caption ? [file.caption] : []);
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.caption === "string") captions.unshift(parsed.caption);
    if (Array.isArray(parsed?.captions)) captions.unshift(...parsed.captions.filter((c: unknown) => typeof c === "string"));
  } catch { /* Older messages may have no structured caption. */ }
  return [...new Set(captions.map(c => c.trim()).filter(Boolean))];
}

function savedOpenUi(content: string, text: string) {
  try {
    const saved = asRecord(JSON.parse(content));
    const openui = safeOpenUi(saved?.openui);
    return openui ? { openui, openuiLanguage: resolveOpenUiLanguage(text, saved?.openuiLanguage) } : undefined;
  } catch { return undefined; }
}

function savedMessageToolActivity(content: string) {
  try { return savedToolActivity(asRecord(JSON.parse(content))?.toolActivity); } catch { return undefined; }
}

function savedTelegramSyncFailure(content: string): boolean {
  try { return asRecord(JSON.parse(content))?.telegramSyncFailed === true; } catch { return false; }
}

function bracketEnd(text: string): number | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]" && --depth === 0) return i + 1;
  }
  return null;
}
