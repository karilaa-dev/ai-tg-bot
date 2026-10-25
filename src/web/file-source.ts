import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../db/sql.js";
import type { ChatFileSource, ChatFileSourceAdapter } from "../files/source.js";
import { MAX_FILE_BYTES } from "../files/limits.js";

export function webFileSource(fileId: number, mimeType: string): ChatFileSource {
  return { transport: "web", connectionKey: "default", remoteKey: String(fileId), locator: {}, mimeType };
}

export class WebFileSourceAdapter implements ChatFileSourceAdapter {
  readonly transport = "web";
  readonly connectionKey = "default";
  constructor(private readonly db: SqlExecutor) {}

  async fetch(source: ChatFileSource, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
    signal?.throwIfAborted();
    if (!/^[1-9]\d*$/.test(source.remoteKey) || !Number.isSafeInteger(Number(source.remoteKey))) throw new Error("Invalid web file reference.");
    const row = await queryOne<{ bytes: Uint8Array }>(this.db, sql`
      select b.bytes from web_file_blobs b join files f on f.id = b.file_id
      where b.file_id = ${Number(source.remoteKey)} and f.size <= ${Math.min(maxBytes, MAX_FILE_BYTES)}
    `);
    signal?.throwIfAborted();
    if (!row) throw new Error("Web attachment unavailable or exceeds the download limit.");
    return Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
  }
}
