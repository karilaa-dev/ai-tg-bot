const FILE_MARKER_RE = /\[\[chat-file:(\d+)\]\]/g;

export function chatFileMarker(fileId: number): string {
  return `[[chat-file:${fileId}]]`;
}

export function chatFileIdsFromText(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(FILE_MARKER_RE)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
  }
  return [...new Set(ids)];
}
