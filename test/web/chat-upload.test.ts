import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHAT_UPLOAD_BYTES, MAX_CHAT_UPLOAD_FILES, MAX_FILE_BYTES } from "../../src/files/limits.js";
import { MAX_CHAT_BODY_BYTES, readChatUpload as parseChatUpload } from "../../src/web/chat-upload.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

vi.mock("node:fs/promises", async importOriginal => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, statfs: vi.fn(filesystem.statfs) };
});

let database: AppDatabase;
function readChatUpload(request: Request, minimumFreeBytes?: number) {
  return parseChatUpload(request, database.db, 42, minimumFreeBytes);
}

const boundary = "upload-boundary";
const requestId = "request_0123456789";
const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
const fileHeader = (filename = "note.txt", name = "files") => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
const filePart = (name = "note.txt", bytes = Buffer.from("hello")) => Buffer.concat([fileHeader(name), bytes, Buffer.from("\r\n")]);
const multipart = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);

function streamRequest(parts: Iterable<Uint8Array>, options: { signal?: AbortSignal; headers?: Record<string, string>; cancel?: () => void } = {}) {
  const iterator = parts[Symbol.iterator]();
  return new Request("https://chat.example/upload", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...options.headers },
    signal: options.signal,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel() { iterator.return?.(); options.cancel?.(); },
    }, { highWaterMark: 0 }),
  });
}

function* fragments(bytes: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

function* generatedUpload(count: number, size: number, trailingBytes = 0): Generator<Buffer> {
  yield field("requestId", requestId);
  const data = Buffer.alloc(64 * 1024, 97);
  for (let index = 0; index < count; index++) {
    yield fileHeader(`${index}.bin`);
    for (let offset = 0; offset < size; offset += data.length) yield data.subarray(0, Math.min(data.length, size - offset));
    yield Buffer.from("\r\n");
  }
  yield Buffer.from(`--${boundary}--\r\n`);
  for (let offset = 0; offset < trailingBytes; offset += data.length) yield data.subarray(0, Math.min(data.length, trailingBytes - offset));
}

let temporaryRoot: string;
beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "chat-upload-test-"));
  vi.stubEnv("TMPDIR", temporaryRoot);
  database = createDatabase({ DB_URL: "sqlite::memory:" });
  await database.initialize();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(statfs).mockReset();
  await database.destroy();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function uploadDirectory(): Promise<string> {
  const entries = await readdir(temporaryRoot);
  expect(entries).toHaveLength(1);
  return join(temporaryRoot, entries[0]);
}

it("rejects low disk space before writing upload data and removes temporary files", async () => {
  const cancel = vi.fn();
  await expect(readChatUpload(streamRequest(generatedUpload(1, 1024), { cancel }), Number.MAX_SAFE_INTEGER))
    .rejects.toMatchObject({ status: 507 });
  expect(await readdir(temporaryRoot)).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
});

it("reserves temporary write allowances across uploads and releases them on cancellation", async () => {
  vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(512 * 1024 ** 2 + 1.5 * 1024 ** 2), bsize: 1n } as never);
  const controller = new AbortController();
  const first = readChatUpload(new Request("https://chat.example/upload", {
    method: "POST", signal: controller.signal, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: new ReadableStream({ start(stream) {
      stream.enqueue(Buffer.concat([field("requestId", requestId), fileHeader(), Buffer.alloc(64 * 1024, 97)]));
    } }),
  }));
  void first.catch(() => {});
  let second: Awaited<ReturnType<typeof readChatUpload>> | undefined;
  try {
    await vi.waitFor(async () => { expect((await stat(join(await uploadDirectory(), "0"))).size).toBeGreaterThan(0); });
    await expect(readChatUpload(streamRequest(generatedUpload(1, 1024))).then(value => { second = value; return value; }))
      .rejects.toMatchObject({ status: 507 });
  } finally {
    controller.abort();
    await expect(first).rejects.toMatchObject({ status: 499 });
    await second?.dispose();
  }
  expect(await database.db.query(sql`select * from web_upload_reservations`)).toEqual([]);
  const next = await readChatUpload(streamRequest(generatedUpload(1, 1024)));
  await next.dispose();
});

it.each([1, 2, 3, 13, 64 * 1024])("preserves binary content and false boundaries with %i-byte fragments", async size => {
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 128, 13, 10]),
    Buffer.from(`before\r\n--${boundary}X\r\n--${boundary}--X\r\n--${boundary}\rX\r\n--${boundary.slice(0, -1)}after`),
    Buffer.from([0, 254]),
  ]);
  const upload = await readChatUpload(streamRequest(fragments(multipart(field("text", "Привет 🌍"), filePart("данные.bin", bytes), field("requestId", requestId)), size)));
  try {
    expect(upload.text).toBe("Привет 🌍");
    expect(upload.requestId).toBe(requestId);
    expect(upload.files).toHaveLength(1);
    expect(upload.files[0]).toMatchObject({ name: "данные.bin", type: "application/octet-stream", size: bytes.length });
    expect(Buffer.from(await upload.files[0].arrayBuffer())).toEqual(bytes);
    const directory = await uploadDirectory();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "0"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "0"))).toEqual(bytes);
  } finally { await Promise.all([upload.dispose(), upload.dispose()]); }
  expect(await readdir(temporaryRoot)).toEqual([]);
  await expect(upload.files[0].arrayBuffer()).rejects.toMatchObject({ code: "ENOENT" });
});

it("accepts native FormData, optional text, a quoted boundary, and escaped header parameters", async () => {
  const form = new FormData();
  form.set("requestId", requestId);
  form.append("files", new File(["native"], "original.txt", { type: "text/plain" }));
  const request = new Request("https://chat.example/upload", { method: "POST", body: form });
  const expectedFile = (await request.clone().formData()).get("files");
  expect(expectedFile).toBeInstanceOf(File);
  const native = await readChatUpload(request);
  try {
    expect(native.text).toBe("");
    expect(native.files[0]).toMatchObject({ name: "original.txt", type: expectedFile instanceof File ? expectedFile.type : "", size: 6 });
    expect(Buffer.from(await native.files[0].arrayBuffer()).toString()).toBe("native");
  } finally { await native.dispose(); }
  const escaped = await readChatUpload(streamRequest([multipart(field("requestId", requestId), filePart('quote\\"name.txt'))], {
    headers: { "Content-Type": `multipart/form-data; boundary="${boundary}"` },
  }));
  try { expect(escaped.files[0].name).toBe('quote"name.txt'); }
  finally { await escaped.dispose(); }
});

it("accepts text without files, maximum Unicode text and request IDs, and closing delimiters without CRLF", async () => {
  const text = "🌍".repeat(16_000);
  const bytes = multipart(field("text", text), field("requestId", "a".repeat(128)));
  const upload = await readChatUpload(streamRequest(fragments(bytes.subarray(0, -2), 1023)));
  expect(upload).toMatchObject({ text, requestId: "a".repeat(128), files: [] });
  await upload.dispose();
  expect(await readdir(temporaryRoot)).toEqual([]);
});

describe("invalid fields", () => {
  it.each([
    ["unknown field", [field("extra", "x")]],
    ["duplicate text", [field("text", "a"), field("text", "b")]],
    ["duplicate request ID", [field("requestId", requestId)]],
    ["non-file files field", [field("files", "not a file")]],
    ["file in text", [Buffer.concat([fileHeader("x", "text"), Buffer.from("data\r\n")])]],
    ["file in request ID", [Buffer.concat([fileHeader("x", "requestId"), Buffer.from("data\r\n")])]],
    ["long text", [field("text", "a".repeat(32_001))]],
    ["empty file name", [filePart("")]],
    ["long file name", [filePart("x".repeat(256))]],
    ["control in file name", [filePart("bad\u007fname")]],
    ["empty file", [filePart("empty", Buffer.alloc(0))]],
  ])("rejects %s and cleans files already written", async (_label, badParts) => {
    const request = streamRequest(fragments(multipart(field("requestId", requestId), filePart(), ...badParts), 31));
    await expect(readChatUpload(request)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it.each(["", "a".repeat(15), "a".repeat(129), "invalid request id", "invalid_request_💥"])("rejects invalid request ID %j", async value => {
    await expect(readChatUpload(streamRequest([multipart(filePart(), field("requestId", value))]))).rejects.toMatchObject({ status: 400 });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("requires one request ID and nonempty message content", async () => {
    for (const body of [multipart(filePart()), multipart(field("requestId", requestId), field("text", " \r\n "))]) {
      await expect(readChatUpload(streamRequest([body]))).rejects.toMatchObject({ status: 400 });
      expect(await readdir(temporaryRoot)).toEqual([]);
    }
  });
});

it.each([
  `Content-Disposition: form-data; name="files"; name="text"; filename="x"`,
  `Content-Disposition: form-data; name="files"; filename="x"\r\nContent-Disposition: form-data; name="text"`,
  `Content-Disposition: form-data; name="files"; filename="x"\r\nBad header`,
  `Content-Disposition: form-data; name="files"; filename="${"a".repeat(16 * 1024)}"`,
])("rejects ambiguous or oversized headers and cleans up", async header => {
  const bytes = multipart(filePart(), Buffer.from(`--${boundary}\r\n${header}\r\n\r\ndata\r\n`));
  await expect(readChatUpload(streamRequest(fragments(bytes, 1024)))).rejects.toMatchObject({ status: 400 });
  expect(await readdir(temporaryRoot)).toEqual([]);
});

it.each(["multipart/form-data", "multipart/form-data; boundary=", `multipart/form-data; boundary=${"x".repeat(71)}`, `multipart/form-data; boundary=${boundary}; boundary=other`, "text/plain"])("rejects invalid multipart content type %s and cancels the stream", async contentType => {
  const cancel = vi.fn();
  await expect(readChatUpload(streamRequest([Buffer.from("body")], { headers: { "Content-Type": contentType }, cancel }))).rejects.toMatchObject({ status: 400 });
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects truncated bodies and stream failures after spooling file content", async () => {
  const prefix = Buffer.concat([field("requestId", requestId), fileHeader(), Buffer.alloc(128 * 1024, 97)]);
  for (const fail of [false, true]) {
    function* chunks() {
      yield prefix;
      if (fail) throw new Error("connection lost");
    }
    await expect(readChatUpload(streamRequest(chunks()))).rejects.toMatchObject({ status: 400 });
    expect(await readdir(temporaryRoot)).toEqual([]);
  }
});

it("accepts ten generated 50 MiB files and reads each file lazily", async () => {
  expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
  expect(MAX_CHAT_UPLOAD_FILES).toBe(10);
  expect(MAX_CHAT_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
  expect(MAX_CHAT_BODY_BYTES).toBe(MAX_CHAT_UPLOAD_BYTES + 256 * 1024);
  const upload = await readChatUpload(streamRequest(generatedUpload(MAX_CHAT_UPLOAD_FILES, MAX_FILE_BYTES)));
  try {
    expect(upload.files).toHaveLength(10);
    expect(upload.files.map(file => file.size)).toEqual(Array(10).fill(MAX_FILE_BYTES));
    const directory = await uploadDirectory();
    expect(await readdir(directory)).toHaveLength(10);
    for (let index = 0; index < upload.files.length; index++) expect((await stat(join(directory, String(index)))).size).toBe(MAX_FILE_BYTES);
    const bytes = new Uint8Array(await upload.files[9].arrayBuffer());
    expect(bytes.byteLength).toBe(MAX_FILE_BYTES);
    expect(bytes[0]).toBe(97);
    expect(bytes[bytes.length - 1]).toBe(97);
  } finally { await upload.dispose(); }
  expect(await readdir(temporaryRoot)).toEqual([]);
}, 30_000);

it("rejects file limit plus one and an eleventh file, cancelling and cleaning up", async () => {
  for (const chunks of [generatedUpload(1, MAX_FILE_BYTES + 1), generatedUpload(11, 1)]) {
    const cancel = vi.fn();
    await expect(readChatUpload(streamRequest(chunks, { cancel }))).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(temporaryRoot)).toEqual([]);
  }
}, 10_000);

it("counts all received body bytes including epilogues and rejects limit plus one", async () => {
  const prefixSize = [...generatedUpload(0, 0)].reduce((sum, chunk) => sum + chunk.length, 0);
  for (const excess of [0, 1]) {
    const cancel = vi.fn();
    const request = streamRequest(generatedUpload(0, 0, MAX_CHAT_BODY_BYTES - prefixSize + excess), { cancel });
    // An exactly bounded body reaches content validation; one extra byte is 413.
    await expect(readChatUpload(request)).rejects.toMatchObject({ status: excess ? 413 : 400 });
    expect(cancel).toHaveBeenCalledTimes(excess);
    expect(await readdir(temporaryRoot)).toEqual([]);
  }
}, 30_000);

it("rejects an oversized Content-Length before pulling the body", async () => {
  const next = vi.fn(function* () { yield Buffer.from("never read"); });
  const cancel = vi.fn();
  await expect(readChatUpload(streamRequest(next(), { headers: { "Content-Length": String(MAX_CHAT_BODY_BYTES + 1) }, cancel }))).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(await readdir(temporaryRoot)).toEqual([]);
});

function stalledUpload(signal?: AbortSignal) {
  let pulls = 0;
  let notify = () => {};
  const waiting = new Promise<void>(resolve => { notify = resolve; });
  const cancel = vi.fn();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const request = new Request("https://chat.example/upload", {
    method: "POST", signal, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.concat([field("requestId", requestId), fileHeader(), Buffer.alloc(128 * 1024, 97)]));
        else notify();
      },
      cancel,
    }, { highWaterMark: 0 }),
  });
  return { request, waiting, cancel, enqueue: (bytes: Buffer) => source?.enqueue(bytes), close: () => source?.close(),
    enqueueAndWaitForRead: (bytes: Buffer) => {
      const nextRead = new Promise<void>(resolve => { notify = resolve; });
      source?.enqueue(bytes);
      return nextRead;
    },
  };
}

it("cleans a partially written upload on abort even when the source never finishes", async () => {
  const controller = new AbortController();
  const stream = stalledUpload(controller.signal);
  const result = readChatUpload(stream.request);
  const rejected = expect(result).rejects.toMatchObject({ status: 499 });
  await stream.waiting;
  expect((await stat(join(await uploadDirectory(), "0"))).size).toBeGreaterThan(0);
  controller.abort();
  await rejected;
  expect(stream.cancel).toHaveBeenCalledOnce();
  expect(await readdir(temporaryRoot)).toEqual([]);
});

it("uses a 60-second inactivity timeout and cleans stalled uploads", async () => {
  vi.useFakeTimers();
  const stream = stalledUpload();
  const result = readChatUpload(stream.request);
  const rejected = expect(result).rejects.toMatchObject({ status: 408 });
  await stream.waiting;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(stream.cancel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(stream.cancel).toHaveBeenCalledOnce();
  expect(await readdir(temporaryRoot)).toEqual([]);
});

it("allows active uploads to exceed a minute by resetting inactivity on received bytes", async () => {
  vi.useFakeTimers();
  const stream = stalledUpload();
  const result = readChatUpload(stream.request);
  await stream.waiting;
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(30_000);
    // Wait through real disk writes until the parser asks for more bytes, before advancing fake time.
    await stream.enqueueAndWaitForRead(Buffer.from("more data"));
  }
  stream.enqueue(closing);
  stream.close();
  const upload = await result;
  expect(upload.files[0].size).toBe(128 * 1024 + 3 * 9);
  expect(stream.cancel).not.toHaveBeenCalled();
  await upload.dispose();
  expect(await readdir(temporaryRoot)).toEqual([]);
});
