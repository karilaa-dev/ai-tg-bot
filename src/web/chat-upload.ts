import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHAT_UPLOAD_BYTES, MAX_CHAT_UPLOAD_FILES, MAX_FILE_BYTES } from "../files/limits.js";
import { WebHttpError } from "./auth.js";
import type { ChatUploadFile } from "./chat-types.js";

export const MAX_CHAT_BODY_BYTES = MAX_CHAT_UPLOAD_BYTES + 256 * 1024;
const MAX_HEADERS_BYTES = 16 * 1024;
const CHUNK_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

function invalid(message = "Invalid multipart upload."): WebHttpError {
  return new WebHttpError(400, message);
}

function parameters(value: string): { kind: string; values: Map<string, string> } {
  const separator = value.indexOf(";");
  const kind = (separator < 0 ? value : value.slice(0, separator)).trim().toLowerCase();
  const values = new Map<string, string>();
  const parameter = /;[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))[ \t]*/y;
  let offset = separator < 0 ? value.length : separator;
  while (offset < value.length) {
    parameter.lastIndex = offset;
    const match = parameter.exec(value);
    if (!match) throw invalid();
    const [, rawName, quoted, token] = match;
    const parsedValue = quoted === undefined ? token : quoted.replace(/\\(.)/gs, "$1");
    if (rawName === undefined || parsedValue === undefined) throw invalid();
    const name = rawName.toLowerCase();
    if (values.has(name)) throw invalid();
    values.set(name, parsedValue);
    offset = parameter.lastIndex;
  }
  return { kind, values };
}

function partHeaders(bytes: Buffer): { name: string; filename: string | undefined; type: string } {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw invalid(); }
  const headers = new Map<string, string>();
  for (const line of decoded.split("\r\n")) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) throw invalid();
    const name = match[1].toLowerCase();
    if (headers.has(name) || !["content-disposition", "content-type"].includes(name)) throw invalid();
    headers.set(name, match[2].trim());
  }
  const disposition = parameters(headers.get("content-disposition") ?? "");
  const name = disposition.values.get("name");
  if (disposition.kind !== "form-data" || name === undefined || [...disposition.values.keys()].some(key => key !== "name" && key !== "filename")) throw invalid();
  return { name, filename: disposition.values.get("filename"), type: headers.get("content-type")?.toLowerCase() || "application/octet-stream" };
}

export async function readChatUpload(request: Request): Promise<{
  text: string;
  requestId: string;
  files: ChatUploadFile[];
  dispose(): Promise<void>;
}> {
  if (!request.body) throw invalid();
  const reader = request.body.getReader();
  let directory: string | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposal ??= directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve();
  let interruption: WebHttpError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (error: WebHttpError) => {
    interruption ??= error;
    void reader.cancel().catch(() => {});
  };
  const abort = () => interrupt(new WebHttpError(499, "Upload aborted."));
  const checkInterrupted = () => { if (interruption) throw interruption; };
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => interrupt(new WebHttpError(408, "Upload timed out.")), IDLE_TIMEOUT_MS);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  let buffer: Buffer = Buffer.alloc(0);
  let chunk: Buffer = Buffer.alloc(0);
  let received = 0;
  let ended = false;
  async function fill(): Promise<boolean> {
    checkInterrupted();
    while (!chunk.length) {
      if (ended) return false;
      let next: Awaited<ReturnType<typeof reader.read>>;
      try { next = await reader.read(); }
      catch { checkInterrupted(); throw invalid("Could not read the upload."); }
      checkInterrupted();
      if (next.done) { ended = true; return false; }
      received += next.value.byteLength;
      if (received > MAX_CHAT_BODY_BYTES) throw new WebHttpError(413, "Upload body is too large.");
      if (!next.value.byteLength) continue;
      resetTimeout();
      chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    }
    const piece = chunk.subarray(0, CHUNK_BYTES);
    buffer = Buffer.concat([buffer, piece]);
    chunk = chunk.subarray(piece.length);
    return true;
  }
  async function ensure(length: number): Promise<void> {
    while (buffer.length < length && await fill()) { /* Read only enough framing bytes. */ }
  }
  async function headers(): Promise<ReturnType<typeof partHeaders>> {
    while (true) {
      const end = buffer.indexOf(HEADER_END);
      if (end >= 0) {
        if (end > MAX_HEADERS_BYTES) throw invalid("Upload headers are too large.");
        const result = partHeaders(buffer.subarray(0, end));
        buffer = buffer.subarray(end + HEADER_END.length);
        return result;
      }
      if (buffer.length > MAX_HEADERS_BYTES + HEADER_END.length - 1) throw invalid("Upload headers are too large.");
      if (!await fill()) throw invalid();
    }
  }
  try {
    checkInterrupted();
    if (Number(request.headers.get("content-length")) > MAX_CHAT_BODY_BYTES) throw new WebHttpError(413, "Upload body is too large.");
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.length > MAX_HEADERS_BYTES) throw invalid();
    const content = parameters(contentType);
    const boundary = content.values.get("boundary");
    if (content.kind !== "multipart/form-data" || !boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary)) throw invalid();
    const first = Buffer.from(`--${boundary}\r\n`);
    const delimiter = Buffer.from(`\r\n--${boundary}`);
    resetTimeout();
    await ensure(first.length);
    if (!buffer.subarray(0, first.length).equals(first)) throw invalid();
    buffer = buffer.subarray(first.length);

    async function payload(write: (bytes: Buffer) => Promise<void>): Promise<boolean> {
      let search = 0;
      while (true) {
        checkInterrupted();
        const candidate = buffer.indexOf(delimiter, search);
        if (candidate >= 0) {
          if (buffer.length < candidate + delimiter.length + 4 && !ended) {
            if (candidate) await write(buffer.subarray(0, candidate));
            buffer = buffer.subarray(candidate);
            await ensure(delimiter.length + 4);
            search = 0;
            continue;
          }
          const suffixOffset = candidate + delimiter.length;
          const suffix = buffer.subarray(suffixOffset, suffixOffset + 2);
          if (suffix.equals(CRLF)) {
            if (candidate) await write(buffer.subarray(0, candidate));
            buffer = buffer.subarray(suffixOffset + 2);
            return false;
          }
          if (suffix.equals(Buffer.from("--")) && (buffer.subarray(suffixOffset + 2, suffixOffset + 4).equals(CRLF) || (ended && buffer.length === suffixOffset + 2))) {
            if (candidate) await write(buffer.subarray(0, candidate));
            buffer = buffer.subarray(suffixOffset + (buffer.length === suffixOffset + 2 ? 2 : 4));
            return true;
          }
          search = candidate + 1;
          continue;
        }
        const flush = buffer.length - delimiter.length + 1;
        if (flush > 0) {
          await write(buffer.subarray(0, flush));
          buffer = Buffer.from(buffer.subarray(flush));
        }
        search = 0;
        if (!await fill()) throw invalid("Incomplete multipart upload.");
      }
    }

    const seen = new Set<string>();
    const files: ChatUploadFile[] = [];
    let text = "";
    let requestId: string | undefined;
    let uploaded = 0;
    let final = false;
    while (!final) {
      const part = await headers();
      if (part.name === "files") {
        if (part.filename === undefined || !part.filename || part.filename.length > 255 || /\p{Cc}/u.test(part.filename)) throw invalid("Invalid file name.");
        if (files.length >= MAX_CHAT_UPLOAD_FILES) throw new WebHttpError(413, `Upload up to ${MAX_CHAT_UPLOAD_FILES} files.`);
        directory ??= await mkdtemp(join(tmpdir(), "chat-upload-"));
        const filePath = join(directory, String(files.length));
        const file = await open(filePath, "wx", 0o600);
        let size = 0;
        try {
          final = await payload(async bytes => {
            size += bytes.length;
            uploaded += bytes.length;
            if (size > MAX_FILE_BYTES || uploaded > MAX_CHAT_UPLOAD_BYTES) throw new WebHttpError(413, "Upload exceeds the file size limit.");
            let offset = 0;
            while (offset < bytes.length) {
              const result = await file.write(bytes, offset, bytes.length - offset);
              if (!result.bytesWritten) throw new Error("Could not write the upload.");
              offset += result.bytesWritten;
            }
          });
        } finally { await file.close(); }
        if (!size) throw invalid("Empty files are not allowed.");
        files.push({
          name: part.filename, type: part.type, size,
          async arrayBuffer() {
            const bytes = await readFile(filePath);
            if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          },
        });
      } else {
        if ((part.name !== "text" && part.name !== "requestId") || part.filename !== undefined || seen.has(part.name)) throw invalid("Invalid upload fields.");
        seen.add(part.name);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const limit = part.name === "text" ? 32_000 : 128;
        let value = "";
        const decode = (bytes?: Buffer) => {
          try { value += decoder.decode(bytes, { stream: bytes !== undefined }); }
          catch { throw invalid("Invalid upload text."); }
          if (value.length > limit) throw invalid("Upload text is too long.");
        };
        final = await payload(async bytes => { decode(bytes); });
        decode();
        if (part.name === "text") text = value;
        else {
          if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw invalid("Invalid request ID.");
          requestId = value;
        }
      }
    }
    // MIME epilogues count toward the body limit even though they are not fields.
    do { buffer = Buffer.alloc(0); } while (await fill());
    checkInterrupted();
    if (requestId === undefined) throw invalid("A request ID is required.");
    if (!text.trim() && !files.length) throw invalid("Write a message or attach a file.");
    return { text, requestId, files, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
