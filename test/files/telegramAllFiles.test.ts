import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileResolver } from "../../src/files/resolver.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { sha256Hex } from "../../src/files/hash.js";
import { telegramFileSource } from "../../src/files/telegramSource.js";
import { MAX_INDEXED_TEXT_BYTES } from "../../src/files/limits.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";

describe("arbitrary Telegram documents", () => {
  let env: GrammyEmulator;
  let downloads: number;
  let directory: string;
  beforeEach(async () => {
    downloads = 0;
    directory = await mkdtemp(path.join(os.tmpdir(), "telegram-files-"));
    env = await createGrammyEmulator({ config: { FILE_STORAGE_PATH: directory }, downloadFile: async ({ fileId }) => {
      downloads++;
      const bytes = env.bot.server.fileState.getFileContent(fileId);
      if (!bytes) throw new Error("Missing local Telegram fixture.");
      return { bytes: Buffer.from(bytes) };
    } });
    await env.bot.sendCommand(env.user, env.chat, "/start");
  });
  afterEach(async () => { vi.restoreAllMocks(); await env.dispose(); await rm(directory, { recursive: true, force: true }); });

  it.each([
    ["bundle.zip", "application/zip"], ["clip.mp4", "video/mp4"],
    ["program.exe", "application/x-msdownload"], ["legacy.doc", "application/msword"],
    ["unknown.custom", "application/octet-stream"],
    ["document.pdf", "application/pdf"], ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["recording.mp3", "audio/mpeg"],
  ])("persists and reuses original %s bytes without a remote source after restart", async (name, mime) => {
    const bytes = Buffer.from([0x4d, 0x5a, 0, 0xff, 0x80]);
    const document = env.bot.server.fileState.storeDocument(name, mime, { content: bytes });
    for (let index = 0; index < 2; index++) {
      await env.bot.processUpdatesConcurrently([
        env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
      ]);
    }
    expect(downloads).toBe(1);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file).toMatchObject({ content_sha256: sha256Hex(bytes), size: bytes.length, extraction_status: "source_only", is_inline: 0, content_md: null, name });
    expect(await env.repos.files.chunks(file.id)).toEqual([]);
    const messages = (await env.repos.messages.listThread(thread.id)).filter(message => message.role === "user" && message.kind === "file");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.text_plain).toContain(file.type === "audio" ? "transcribe_audio" : "materialize_chat_files");
      expect(await env.repos.files.listForMessage(message.id)).toMatchObject([{ id: file.id }]);
    }
    const resolver = new FileResolver(env.repos.files, undefined, new LocalFileStore(directory));
    const unavailable = vi.fn(async () => { throw new Error("Telegram is offline"); });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: unavailable });
    const resolved = await resolver.resolveFile(file);
    expect(resolved.source.transport).toBe("local");
    expect(unavailable).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([file.id]);
    expect(resolved.bytes).toEqual(bytes);
    expect(downloads).toBe(1);
  });

  it.each([
    ["large.csv", "text/csv", "a,b\n".repeat(MAX_INDEXED_TEXT_BYTES / 4 + 1)],
    ["wide.csv", "text/csv", ",".repeat(3_000)],
    ["large.txt", "text/plain", "x".repeat(MAX_INDEXED_TEXT_BYTES + 1)],
  ])("accepts and resends source-only %s from the Telegram cache", async (name, mime, content) => {
    const document = env.bot.server.fileState.storeDocument(name, mime, { content: Buffer.from(content) });
    for (let index = 0; index < 2; index++) {
      await env.bot.processUpdatesConcurrently([env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document)]);
    }
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ extraction_status: "source_only", content_md: null });
    const messages = (await env.repos.messages.listThread(thread.id)).filter(message => message.role === "user" && message.kind === "file");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.text_plain).toContain("materialize_chat_files");
      expect(await env.repos.files.listForMessage(message.id)).toMatchObject([{ id: files[0]!.id }]);
    }
    expect(downloads).toBe(1);
  });

  it("treats binary labelled as text as an opaque reusable source", async () => {
    const bytes = Buffer.from([0x4d, 0x5a, 0, 0xff, 0x80]);
    const document = env.bot.server.fileState.storeDocument("binary.txt", "text/plain", { content: bytes });
    for (let index = 0; index < 2; index++) {
      await env.bot.processUpdatesConcurrently([
        env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
      ]);
    }
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ type: "other", extraction_status: "source_only", is_inline: 0, content_md: null });
    const messages = (await env.repos.messages.listThread(thread.id)).filter(message => message.role === "user" && message.kind === "file");
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.text_plain.includes("materialize_chat_files"))).toBe(true);
  });

  it("records actual bytes and size when Telegram omits size metadata", async () => {
    const bytes = Buffer.from("opaque original");
    const document = env.bot.server.fileState.storeDocument("no-size.bin", "application/octet-stream", { content: bytes });
    delete document.file_size;
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
    ]);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [file] = await env.repos.files.listForThreads([thread.id]);
    expect(file).toMatchObject({ size: bytes.length, content_sha256: sha256Hex(bytes) });
    if (!file) throw new Error("Attachment was not accepted");
    expect(await new LocalFileStore(directory).read(String(file.id))).toEqual(bytes);
  });

  it("preserves an already-attached hash match when a competing source claim wins", async () => {
    const bytes = Buffer.from("shared file bytes");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const message = await env.repos.messages.insert({ threadId: thread.id, role: "user", kind: "file", content: {}, textPlain: "existing attachment" });
    const candidate = await env.repos.files.insertFile({
      userId: env.user.id, threadId: thread.id, messageId: message.id, type: "txt", name: "existing.txt",
      contentSha256: sha256Hex(bytes), size: bytes.length, isInline: false,
    });
    await env.repos.files.insertChunk({ fileId: candidate.id, idx: 0, content: bytes.toString() });
    await env.services.fileResolver.persistFile(candidate, bytes);
    const winner = await env.repos.files.insertFile({
      userId: env.user.id, threadId: thread.id, type: "txt", name: "winner.txt",
      contentSha256: sha256Hex(bytes), size: bytes.length, contentMd: bytes.toString(), isInline: true,
    });
    const document = env.bot.server.fileState.storeDocument("current-name.txt", "text/plain", { content: bytes });
    await env.repos.files.rememberSource(winner.id, telegramFileSource({ fileId: document.file_id, fileUniqueId: document.file_unique_id }));
    vi.spyOn(env.repos.files, "findBySource").mockResolvedValueOnce(undefined);
    vi.spyOn(env.repos.files, "findByContentHash").mockResolvedValueOnce(candidate);

    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
    ]);

    expect(await env.repos.files.get(candidate.id)).toMatchObject({ message_id: message.id, name: "existing.txt" });
    expect(await env.repos.files.listForMessage(message.id)).toMatchObject([{ id: candidate.id }]);
    expect(await env.repos.files.chunks(candidate.id)).toMatchObject([{ content: bytes.toString() }]);
    expect(await new LocalFileStore(directory).read(String(candidate.id))).toEqual(bytes);
    const messages = await env.repos.messages.listThread(thread.id);
    const accepted = messages.find(row => row.role === "user" && row.text_plain.includes("current-name.txt"));
    expect(accepted).toBeDefined();
    if (!accepted) throw new Error("New attachment was not accepted");
    expect(await env.repos.files.listForMessage(accepted.id)).toMatchObject([{ id: winner.id, name: "current-name.txt" }]);
  });

  it("sanitizes another owner's image card without overwriting their metadata", async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const owner = await env.repos.users.ensure({ tgId: 2902 });
    const ownerThread = await env.repos.threads.activeForUserTopic(owner.tg_id, null);
    const original = await env.repos.files.insertFile({
      userId: owner.tg_id, threadId: ownerThread.id, type: "image", name: "private-image-name.png",
      mimeType: "image/png", contentSha256: sha256Hex(bytes), size: bytes.length,
      summary: "private image generation prompt", isInline: true,
    });
    await env.services.fileResolver.persistFile(original, bytes);
    const document = env.bot.server.fileState.storeDocument("my-image.png", "image/png", { content: bytes });
    await env.repos.files.rememberSource(original.id, telegramFileSource({ fileId: document.file_id, fileUniqueId: document.file_unique_id }));
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
    ]);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const message = (await env.repos.messages.listThread(thread.id)).find(row => row.kind === "image");
    expect(message?.text_plain).toContain("Telegram image");
    expect(message?.text_plain).not.toContain("private image generation prompt");
    expect(message?.text_plain).not.toContain("private-image-name.png");
    expect((await env.repos.files.get(original.id))?.summary).toBe("private image generation prompt");
    if (!message) throw new Error("Image was not accepted");
    expect(await env.repos.files.listForMessage(message.id)).toMatchObject([{ id: original.id, name: "my-image.png", summary: null }]);
  });

  it("keeps a newly created losing candidate once another user accepts it", async () => {
    const bytes = Buffer.from("concurrently accepted bytes");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const other = await env.repos.users.ensure({ tgId: 2905 });
    const otherThread = await env.repos.threads.activeForUserTopic(other.tg_id, null);
    const accepted = await env.repos.messages.insert({ threadId: otherThread.id, role: "user", kind: "file", content: {}, textPlain: "accepted" });
    const winner = await env.repos.files.insertFile({
      userId: env.user.id, threadId: thread.id, type: "txt", name: "winner.txt", size: bytes.length,
      contentSha256: sha256Hex(bytes), contentMd: bytes.toString(), isInline: true,
    });
    const document = env.bot.server.fileState.storeDocument("competing.txt", "text/plain", { content: bytes });
    await env.repos.files.rememberSource(winner.id, telegramFileSource({ fileId: document.file_id, fileUniqueId: document.file_unique_id }));
    vi.spyOn(env.repos.files, "findBySource").mockResolvedValueOnce(undefined);
    vi.spyOn(env.repos.files, "findByContentHash").mockResolvedValueOnce(undefined);
    const remember = env.repos.files.rememberTelegramObservation.bind(env.repos.files);
    vi.spyOn(env.repos.files, "rememberTelegramObservation").mockImplementationOnce(async (id, source, input) => {
      const file = await env.repos.files.get(id);
      if (!file) throw new Error("Concurrent candidate missing");
      await env.services.fileResolver.persistFile(file, bytes);
      await env.repos.files.attachToMessage(accepted.id, id, { displayName: "other-users-name.txt" });
      return remember(id, source, input);
    });
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
    ]);
    const [retained] = await env.repos.files.listForMessage(accepted.id);
    expect(retained).toMatchObject({ name: "other-users-name.txt" });
    expect(retained?.id).not.toBe(winner.id);
    if (!retained) throw new Error("Concurrent attachment was deleted");
    expect(await new LocalFileStore(directory).read(retained.id)).toEqual(bytes);
  });
});
