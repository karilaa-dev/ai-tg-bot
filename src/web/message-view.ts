import type { MessageRow } from "../db/types.js";
import type { WebAttachment, WebMessage } from "./types.js";
import { attachmentKind } from "./media.js";

export interface SavedTranscript { id: string; messageId: number; fileId: number; text: string }

/** Separate the bot's saved media cards from the words a person actually sent. */
export function messageView(message: MessageRow, attachments: WebAttachment[], transcripts: SavedTranscript[] = []): WebMessage {
  const files = attachments.map(file => ({ ...file }));
  const view = { id: message.id, threadId: message.thread_id, role: message.role, text: message.text_plain,
    thinking: message.thinking, createdAt: message.created_at, attachments: files };
  if (message.kind === "text" && message.role !== "assistant") return view;
  const captions = savedCaptions(message.content_json, files);
  const visible: string[] = [];
  let cursor = 0;
  for (const marker of message.text_plain.matchAll(/^\[\[chat-file:(\d+)\]\] /gm)) {
    if (marker.index < cursor) continue;
    const file = files.find(file => file.id === Number(marker[1]));
    if (!file) continue;
    const tail = message.text_plain.slice(marker.index + marker[0].length);
    const prefix = message.text_plain.slice(cursor, marker.index);
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
      const sourceCard = `Audio file #${file.id}: ${file.name}. Use transcribe_audio with file_id: ${file.id}.`;
      if (tail.startsWith(sourceCard)) {
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
    } else {
      const end = fileCardEnd(tail, file);
      if (end === null) continue;
      visible.push(prefix);
      cursor = marker.index + marker[0].length + end;
    }
  }
  visible.push(message.text_plain.slice(cursor));
  view.text = visible.map(part => part.trim()).filter(Boolean).join("\n\n");
  return view;
}

function fileCardEnd(text: string, file: WebAttachment): number | null {
  const prefix = `File #${file.id}: ${file.name} (`;
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length);
  const inline = body.match(/^(?:txt|csv|pdf|docx|other), inline\)\.\n/);
  if (inline) {
    const opening = `${inline[0]}<attachment id="${file.id}" name="${file.name}">\n`;
    if (!body.startsWith(opening)) return null;
    const end = body.slice(opening.length).search(/\n<\/attachment>(?=\n\n|$)/);
    return end < 0 ? null : prefix.length + opening.length + end + "\n</attachment>".length;
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

function bracketEnd(text: string): number | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]" && --depth === 0) return i + 1;
  }
  return null;
}
