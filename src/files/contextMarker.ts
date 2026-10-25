import { isUuid } from "../utils/uuid.js";

const FILE_MARKER_RE = /\[\[chat-file:([^\[\]\r\n]+)\]\]/g;

export function chatFileMarker(fileId: string): string {
  return `[[chat-file:${fileId}]]`;
}

export function chatFileIdsFromText(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(FILE_MARKER_RE)) {
    const id = match[1];
    if (isUuid(id)) ids.push(id);
  }
  return [...new Set(ids)];
}
