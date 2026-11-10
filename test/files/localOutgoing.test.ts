import { link, mkdtemp, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { FileResolver } from "../../src/files/resolver.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { createLogger } from "../../src/logger.js";
import { sendFinal } from "../../src/ai/responseDelivery.js";
import type { TurnInput } from "../../src/ai/types.js";

vi.mock("node:fs/promises", async importOriginal => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, open: vi.fn(filesystem.open), link: vi.fn(filesystem.link) };
});

describe("durable outgoing attachment bytes", () => {
  let db: AppDatabase;
  let repos: Repos;
  let directory: string;
  let fileResolver: FileResolver;
  const config = loadTestConfig({ FILE_INLINE_TOKENS: 1 });

  beforeEach(async () => {
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    repos = createRepos(db.db, db.search);
    directory = await mkdtemp(path.join(os.tmpdir(), "local-outgoing-"));
    fileResolver = new FileResolver(repos.files, undefined, new LocalFileStore(directory));
  });
  afterEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function outgoing() {
    const user = await repos.users.ensure({ tgId: 2903 });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    return { thread, files: new OutgoingFiles({ config, repos, user, thread, fileResolver }) };
  }

  it("retains bytes even when a caller does not inject a resolver", async () => {
    const user = await repos.users.ensure({ tgId: 2903 });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const files = new OutgoingFiles({ config: { ...config, FILE_STORAGE_PATH: directory }, repos, user, thread });
    try {
      const bytes = Buffer.from("Download without a sandbox");
      const attachment = await files.bytes(async () => ({ name: "result.bin", bytes }));
      const stored = await repos.files.get(attachment.fileId);
      if (!stored) throw new Error("Missing file");
      expect((await fileResolver.resolveFile(stored, undefined, undefined, { excludeSandbox: true, allowSandboxResume: false, pauseAfterRead: false })).bytes).toEqual(bytes);
    } finally { await files.dispose(); }
  });

  it.each(["created_file", "generated_image"] as const)("retains %s after delivery, buffer disposal, and restart", async origin => {
    const { files, thread } = await outgoing();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]);
    const attachment = await files.bytes(async () => ({
      name: "download.jpg", mime: "image/jpeg", bytes, origin, summary: "generated scene",
    }));
    const message = await repos.messages.insert({ threadId: thread.id, role: "assistant", kind: "file", content: {}, textPlain: "download" });
    await repos.files.setMessageId(attachment.fileId, message.id);
    files.buffers.release(attachment);
    await files.dispose();
    const stored = await repos.files.get(attachment.fileId);
    if (!stored) throw new Error("Delivered file was removed");
    const restarted = new FileResolver(repos.files, undefined, new LocalFileStore(directory));
    expect(await restarted.resolveFile(stored)).toMatchObject({ bytes, source: { transport: "local" } });
  });

  it("retains original bytes when indexing fails and delivery uses a generic attachment", async () => {
    const { files, thread } = await outgoing();
    vi.spyOn(repos.files, "insertChunk").mockRejectedValueOnce(new Error("Search index unavailable"));
    const bytes = Buffer.from("Original text that exceeds the inline size limit.");
    const attachment = await files.bytes(async () => ({ name: "original.txt", mime: "text/plain", bytes }));
    expect(attachment.type).toBe("other");
    const message = await repos.messages.insert({ threadId: thread.id, role: "assistant", kind: "file", content: {}, textPlain: "download" });
    await repos.files.setMessageId(attachment.fileId, message.id);
    await files.dispose();
    const stored = await repos.files.get(attachment.fileId);
    if (!stored) throw new Error("Fallback attachment was removed");
    expect((await fileResolver.resolveFile(stored)).bytes).toEqual(bytes);
    expect(await readdir(directory)).toEqual([attachment.fileId]);
  });

  it("writes a prepared attachment's bytes once across preparation and final delivery", async () => {
    const { files, thread } = await outgoing();
    const user = (await repos.users.get(2903))!;
    vi.mocked(open).mockClear();
    vi.mocked(link).mockClear();
    const bytes = Buffer.from("A deliverable that is not stored twice");
    const attachment = await files.bytes(async () => ({ name: "report.bin", bytes }));
    const physical = () => ({
      staged: vi.mocked(open).mock.calls.filter(([file, flags]) => flags === "wx" && String(file).startsWith(directory)).length,
      published: vi.mocked(link).mock.calls.length,
    });
    expect(physical()).toEqual({ staged: 1, published: 1 });
    const persist = vi.spyOn(fileResolver, "persistFile");
    const sent: string[] = [];
    const api = {
      raw: { sendRichMessage: vi.fn(async (payload: { rich_message: { markdown: string } }) => { sent.push(`text:${payload.rich_message.markdown}`); return { message_id: 700 }; }), editMessageText: vi.fn(async () => true) },
      deleteMessage: vi.fn(async () => true),
      sendDocument: vi.fn(async () => { sent.push("document"); return { message_id: 701, document: { file_id: "doc", file_unique_id: "doc-unique", file_size: bytes.length } }; }),
    };
    const input = { api, chatId: 55, config, db, repos, user, thread, text: "", t: (key: string) => key, fileResolver,
      outgoingBuffers: files.buffers, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "error" } } as unknown as TurnInput;

    await sendFinal(input, "", "Here is the report", 0, [attachment]);

    // Final delivery still re-verifies and records the durable source, but does not write the copy again.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(physical()).toEqual({ staged: 1, published: 1 });
    expect(sent).toEqual(["text:Here is the report", "document"]);
    const stored = (await repos.files.get(attachment.fileId))!;
    expect(stored.message_id).not.toBeNull();
    expect((await fileResolver.resolveFile(stored)).bytes).toEqual(bytes);
    expect(await readdir(directory)).toEqual([attachment.fileId]);
    await files.dispose();
  });

  it("recovers a missing local copy during final delivery by writing it again", async () => {
    const { files, thread } = await outgoing();
    const user = (await repos.users.get(2903))!;
    const bytes = Buffer.from("Bytes lost between preparation and delivery");
    const attachment = await files.bytes(async () => ({ name: "lost.bin", bytes }));
    await rm(path.join(directory, attachment.fileId));
    vi.mocked(open).mockClear();
    const api = {
      raw: { sendRichMessage: vi.fn(async () => ({ message_id: 700 })), editMessageText: vi.fn(async () => true) },
      deleteMessage: vi.fn(async () => true),
      sendDocument: vi.fn(async () => ({ message_id: 701, document: { file_id: "doc", file_unique_id: "doc-unique", file_size: bytes.length } })),
    };
    const input = { api, chatId: 55, config, db, repos, user, thread, text: "", t: (key: string) => key, fileResolver,
      outgoingBuffers: files.buffers, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "error" } } as unknown as TurnInput;
    await sendFinal(input, "", "Recovered", 0, [attachment]);
    expect(vi.mocked(open).mock.calls.filter(([file, flags]) => flags === "wx" && String(file).startsWith(directory))).toHaveLength(1);
    expect(await readdir(directory)).toEqual([attachment.fileId]);
    expect((await fileResolver.resolveFile((await repos.files.get(attachment.fileId))!)).bytes).toEqual(bytes);
    await files.dispose();
  });

  it("removes only its own unpublished files when a turn is discarded", async () => {
    const { files } = await outgoing();
    const attachment = await files.bytes(async () => ({ name: "draft.custom", bytes: Buffer.from([0, 255]) }));
    expect(await readdir(directory)).toEqual([attachment.fileId]);
    await files.dispose();
    expect(await repos.files.get(attachment.fileId)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves another user's accepted reference when the original outgoing turn is discarded", async () => {
    const { files } = await outgoing();
    const bytes = Buffer.from("shared attachment original bytes");
    const attachment = await files.bytes(async () => ({ name: "owner.txt", mime: "text/plain", bytes }));
    const user = await repos.users.ensure({ tgId: 2904 });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({ threadId: thread.id, role: "user", kind: "file", content: {}, textPlain: "accepted shared file" });
    await repos.files.attachToMessage(message.id, attachment.fileId, { displayName: "my-name.txt" });
    expect((await repos.files.get(attachment.fileId))?.message_id).toBeNull();
    await files.dispose();
    const [retained] = await repos.files.listForMessage(message.id);
    expect(retained).toMatchObject({ id: attachment.fileId, name: "my-name.txt" });
    expect(await repos.files.chunks(attachment.fileId)).not.toHaveLength(0);
    if (!retained) throw new Error("Shared accepted file was deleted");
    expect((await fileResolver.resolveFile(retained)).bytes).toEqual(bytes);
  });
});
