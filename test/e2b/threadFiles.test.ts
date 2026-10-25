import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { e2bFileSource } from "../../src/e2b/fileSource.js";
import { resolveThreadFileDescriptors } from "../../src/e2b/threadFiles.js";
import { webFileSource } from "../../src/web/file-source.js";

describe("E2B thread file descriptors", () => {
  let database: AppDatabase | undefined;

  afterEach(async () => {
    await database?.destroy();
  });

  it("resolves Telegram metadata without loading file bytes", async () => {
    const config = loadTestConfig();
    database = createDatabase(config);
    await database.initialize();
    const repos = createRepos(database.db, database.search);
    const user = await repos.users.ensure({ tgId: 501, firstName: "Files", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Files" });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      contentSha256: "a".repeat(64),
      mimeType: "image/jpeg",
      name: "photo.jpg",
      size: 100,
      isInline: true,
    });
    await repos.files.rememberTelegramFileRefs(file.id, {
      direction: "inbound",
      mediaKind: "photo",
      refs: [
        { fileId: "small", width: 90, height: 90, size: 20, primary: false },
        { fileId: "large", width: 640, height: 480, size: 100, primary: true },
      ],
    });
    await repos.files.rememberSource(file.id, e2bFileSource(config, {
      fileId: file.id,
      sandboxId: "old-sandbox",
      userId: user.tg_id,
      threadId: thread.id,
      sourceCanonicalPath: `/home/user/.ai-tg-bot/file-sources/${"a".repeat(64)}`,
      size: 100,
      contentSha256: "a".repeat(64),
      mimeType: "image/jpeg",
    }));
    const byteResolver = vi.fn(async () => {
      throw new Error("must not be called");
    });

    const descriptors = await resolveThreadFileDescriptors({
      repos,
      thread,
      resolveFile: byteResolver,
    } as never);

    expect(byteResolver).not.toHaveBeenCalled();
    expect(descriptors).toEqual([{
      fileId: file.id,
      messageId: null,
      name: "photo.jpg",
      mimeType: "image/jpeg",
      expectedSize: 100,
      expectedSha256: "a".repeat(64),
      telegramRefs: [
        expect.objectContaining({ telegramFileId: "large", telegramSize: 100, direction: "inbound", mediaKind: "photo", isPrimary: true }),
        expect.objectContaining({ telegramFileId: "small", telegramSize: 20, direction: "inbound", mediaKind: "photo", isPrimary: false }),
      ],
    }]);
  });

  it("keys immutable E2B sources by logical file as well as content", () => {
    const config = loadTestConfig();
    const base = {
      sandboxId: "sandbox-1",
      userId: 1,
      threadId: 2,
      sourceCanonicalPath: `/home/user/.ai-tg-bot/file-sources/${"b".repeat(64)}`,
      size: 5,
      contentSha256: "b".repeat(64),
    };

    const first = e2bFileSource(config, { ...base, fileId: 10 });
    const second = e2bFileSource(config, { ...base, fileId: 11 });

    expect(first.remoteKey).not.toBe(second.remoteKey);
    expect(first.locator).toMatchObject({ path: base.sourceCanonicalPath, size: 5, sha256: "b".repeat(64) });
  });

  it("includes registered web attachments without Telegram refs, within message and fork boundaries", async () => {
    database = createDatabase(loadTestConfig());
    await database.initialize();
    const repos = createRepos(database.db, database.search);
    const user = await repos.users.ensure({ tgId: 501, firstName: "Files", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Files" });
    const files = [];
    for (const name of ["before.txt", "after.txt"]) {
      const message = await repos.messages.insert({ threadId: thread.id, role: "user", content: [], textPlain: name });
      const file = await repos.files.insertFile({
        userId: user.tg_id, threadId: thread.id, messageId: message.id,
        type: "txt", name, size: 5, contentSha256: "a".repeat(64), mimeType: "text/plain", isInline: false,
      });
      await repos.files.rememberSource(file.id, webFileSource(file.id, "text/plain"));
      files.push(file);
    }
    const [before, after] = files;
    if (!before || !after || before.message_id === null) throw new Error("missing attachment fixture");
    const fork = await repos.threads.create({
      userId: user.tg_id, topicId: null, title: "Fork", parentThreadId: thread.id, forkPointMessageId: before.message_id,
    });
    const selected = [before.id, after.id, before.id];
    for (const input of [{ repos, thread, maxMessageId: before.message_id }, { repos, thread: fork }]) {
      const descriptors = await resolveThreadFileDescriptors(input, undefined, selected);
      expect(descriptors).toEqual([{
        fileId: before.id, messageId: before.message_id, name: "before.txt", mimeType: "text/plain",
        expectedSize: 5, expectedSha256: "a".repeat(64), telegramRefs: [],
      }]);
    }
    expect(await resolveThreadFileDescriptors({ repos, thread })).toHaveLength(2);
  });

  it("requires a visible attachment grant for another user's web blob and keeps the recipient's name", async () => {
    database = createDatabase(loadTestConfig());
    await database.initialize();
    const repos = createRepos(database.db, database.search);
    const owner = await repos.users.ensure({ tgId: 501, firstName: "Owner", lang: "en" });
    const recipient = await repos.users.ensure({ tgId: 502, firstName: "Recipient", lang: "en" });
    const original = await repos.threads.create({ userId: owner.tg_id, topicId: null, title: "Private" });
    const thread = await repos.threads.create({ userId: recipient.tg_id, topicId: null, title: "Shared" });
    const file = await repos.files.insertFile({
      userId: owner.tg_id, threadId: original.id, type: "txt", name: "private-original.txt",
      size: 5, isInline: false, mimeType: "text/plain",
    });
    await repos.files.rememberSource(file.id, webFileSource(file.id, "text/plain"));
    expect(await resolveThreadFileDescriptors({ repos, thread }, undefined, [file.id])).toEqual([]);

    const message = await repos.messages.insert({ threadId: thread.id, role: "user", content: [], textPlain: "attachment" });
    await repos.files.attachToMessage(message.id, file.id, { displayName: "shared.txt" });
    const descriptors = await resolveThreadFileDescriptors({ repos, thread }, undefined, [file.id]);
    expect(descriptors).toEqual([expect.objectContaining({ fileId: file.id, name: "shared.txt", telegramRefs: [] })]);
    expect(JSON.stringify(descriptors)).not.toContain("private-original");
  });
});
