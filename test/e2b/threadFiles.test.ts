import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { e2bFileSource } from "../../src/e2b/fileSource.js";
import { resolveThreadFileDescriptors } from "../../src/e2b/threadFiles.js";

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
      sandboxId: "old-sandbox",
      userId: user.tg_id,
      threadId: thread.id,
      canonicalPath: "/home/user/workspace/photo.jpg",
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
        expect.objectContaining({ telegramFileId: "large", telegramSize: 100, isPrimary: true }),
        expect.objectContaining({ telegramFileId: "small", telegramSize: 20, isPrimary: false }),
      ],
    }]);
  });
});
