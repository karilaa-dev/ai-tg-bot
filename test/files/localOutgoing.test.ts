import { mkdtemp, readdir, rm } from "node:fs/promises";
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
    vi.restoreAllMocks();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function outgoing() {
    const user = await repos.users.ensure({ tgId: 2903 });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    return { thread, files: new OutgoingFiles({ config, repos, user, thread, fileResolver }) };
  }

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
