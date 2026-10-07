export const LOG_REC = 320;
export const TREE_REC = 288;
export class MemoError extends Error {}
export type Memory = readonly [id: number, date: string, text: string];

// Python str.strip's whitespace set; JS trim also removes BOM and omits NEL.
const SPACE = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const strip = (text: string): string => text.replace(new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu"), "");
export const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

export function pad(text: string, width: number): Buffer {
  const bytes = Buffer.from(text);
  if (bytes.length > width - 1) throw new MemoError(`Too long: ${bytes.length} bytes. The record holds ${width - 1}.`);
  const record = Buffer.alloc(width, 32);
  bytes.copy(record);
  record[width - 1] = 10;
  return record;
}

