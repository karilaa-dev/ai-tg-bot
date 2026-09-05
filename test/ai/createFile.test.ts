import { testOutgoingFiles } from "../helpers/outgoingFiles.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCreatedFileAttachments } from "../../src/ai/responseDelivery.js";
import { createCreateFileTool as buildCreateFileTool } from "../../src/ai/tools/createFile.js";
import type { CreatedFileAttachment } from "../../src/files/types.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import type { CommandRuntime } from "../../src/sandbox/types.js";

describe("create_file", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config);
    await db.initialize();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("cleans up the unqueued file when durable source registration fails", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 801, firstName: "Files", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Files" });
    const bytes = Buffer.from("image bytes");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const rememberSource = vi.spyOn(repos.files, "rememberSource")
      .mockRejectedValue(new Error("source registry unavailable"));
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles: [],
      commandRuntime: fileRuntime(bytes, contentSha256),
    });

    await expect(tool.execute({ path: "/photo.jpg", delivery: "auto" }))
      .resolves.toMatchObject({ error: "Error: source registry unavailable" });

    expect(rememberSource).toHaveBeenCalledTimes(1);
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(0);
  });

  it("preserves image delivery when image indexing falls back to a basic file row", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 802, firstName: "Images", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
    const bytes = Buffer.from("image bytes");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const originalInsert = repos.files.insertFile.bind(repos.files);
    vi.spyOn(repos.files, "insertFile")
      .mockRejectedValueOnce(new Error("image indexing unavailable"))
      .mockImplementation(originalInsert);
    const createdFiles: Array<{ type: string; delivery: string; data?: Buffer }> = [];
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles,
      commandRuntime: fileRuntime(bytes, contentSha256),
    } as never);

    await expect(tool.execute({ path: "/photo.jpg", delivery: "photo" }))
      .resolves.toMatchObject({ type: "image" });

    expect(createdFiles).toMatchObject([{ type: "image", delivery: "photo" }]);
    expect(createdFiles[0]?.data).toEqual(bytes);
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(1);
  });

  it("marks photo_only images so Telegram cannot fall back to document delivery", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 804, firstName: "Strict", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
    const bytes = Buffer.from("image bytes");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const createdFiles: Array<{ type: string; delivery: string; photoFallback?: string }> = [];
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles,
      commandRuntime: fileRuntime(bytes, contentSha256),
    } as never);

    await expect(tool.execute({ path: "/model.final.png", mime: "image/png", delivery: "photo_only" }))
      .resolves.toMatchObject({ type: "image" });

    expect(createdFiles).toMatchObject([{
      type: "image",
      delivery: "photo",
      photoFallback: "none",
    }]);
  });

  it("replaces an earlier queued revision from the same workspace path", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 806, firstName: "Revisions", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
    const createdFiles: CreatedFileAttachment[] = [];
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles,
      commandRuntime: revisionRuntime([
        Buffer.from("first rendered revision"),
        Buffer.from("final rendered revision"),
      ]),
    } as never);

    await expect(tool.execute({
      path: "/model.final.png",
      name: "draft.png",
      mime: "image/png",
      delivery: "photo_only",
    })).resolves.toMatchObject({ status: "1 file attached (1/25 used)" });
    await expect(tool.execute({
      path: "/model.final.png",
      name: "final.png",
      mime: "image/png",
      delivery: "photo_only",
    })).resolves.toMatchObject({ status: "1 file replaced (1/25 used)" });

    expect(createdFiles).toHaveLength(1);
    expect(createdFiles[0]).toMatchObject({ name: "final.png", size: 23 });
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(1);

    const sendPhoto = vi.fn(async () => ({
      message_id: 500,
      photo: [{
        file_id: "final-photo",
        file_unique_id: "final-photo-unique",
        width: 1200,
        height: 900,
        file_size: 23,
      }],
    }));
    await sendCreatedFileAttachments({
      api: {
        sendPhoto,
        sendDocument: vi.fn(),
        sendMediaGroup: vi.fn(),
      },
      chatId: 123,
      thread,
      logger: { info: vi.fn(), warn: vi.fn() },
      repos: {
        files: {
          get: vi.fn(async () => ({ id: createdFiles[0]!.fileId })),
          rememberTelegramObservation: vi.fn(async () => undefined),
          setMessageId: vi.fn(async () => undefined),
        },
      },
      resolveFile: vi.fn(async () => ({ bytes: Buffer.from("final rendered revision") })),
    } as never, { id: 999 } as never, createdFiles);

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(createdFiles[0]?.telegramDelivery).toMatchObject({ fileId: "final-photo" });
  });

  it("keeps attachments from distinct workspace paths", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 807, firstName: "Distinct", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Models" });
    const createdFiles: CreatedFileAttachment[] = [];
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles,
      commandRuntime: revisionRuntime([Buffer.from("stl bytes"), Buffer.from("png bytes")]),
    } as never);

    await tool.execute({ path: "/model.stl", delivery: "document" });
    await tool.execute({ path: "/model.final.png", mime: "image/png", delivery: "photo_only" });

    expect(createdFiles).toHaveLength(2);
    expect(createdFiles.map((attachment) => attachment.sourceVirtualPath)).toEqual([
      "/model.stl",
      "/model.final.png",
    ]);
  });

  it("rejects oversized photo_only images instead of downgrading them", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 805, firstName: "Strict", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles: [],
      commandRuntime: fileRuntime(bytes, contentSha256),
    });

    await expect(tool.execute({ path: "/model.final.png", mime: "image/png", delivery: "photo_only" }))
      .resolves.toMatchObject({ error: expect.stringContaining("photo_only requires an image no larger") });
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(0);
  });

  it("blocks an executable extension before a long file name is truncated", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 803, firstName: "Blocked", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Files" });
    const bytes = Buffer.from("zip container without executable magic");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const tool = createCreateFileTool({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles: [],
      commandRuntime: fileRuntime(bytes, contentSha256),
    });

    await expect(tool.execute({
      path: "/photo.jpg",
      name: `${"a".repeat(200)}.jar`,
      delivery: "document",
    })).resolves.toMatchObject({ error: expect.stringContaining("blocked executable file type: .jar") });
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(0);
  });
});

function fileRuntime(bytes: Buffer, contentSha256: string): CommandRuntime {
  return {
    materializeFiles: async () => ({ directory: "/home/user/telegram-files", available: 0, files: [] }),
    execute: async () => { throw new Error("not used"); },
    readWorkspaceFile: async () => ({
      sandboxId: "sandbox-1",
      canonicalPath: "/home/user/workspace/photo.jpg",
      sourceCanonicalPath: `/home/user/.ai-tg-bot/file-sources/${contentSha256}`,
      bytes,
      size: bytes.length,
      contentSha256,
    }),
    readSourceFile: async () => { throw new Error("not used"); },
    publishWebsite: async () => { throw new Error("not used"); },
    dispose: async () => undefined,
  };
}

function revisionRuntime(revisions: Buffer[]): CommandRuntime {
  let index = 0;
  return {
    materializeFiles: async () => ({ directory: "/home/user/telegram-files", available: 0, files: [] }),
    execute: async () => { throw new Error("not used"); },
    readWorkspaceFile: async () => {
      const bytes = revisions[index++];
      if (!bytes) throw new Error("unexpected extra revision read");
      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        sandboxId: "sandbox-1",
        canonicalPath: "/home/user/workspace/model.final.png",
        sourceCanonicalPath: `/home/user/.ai-tg-bot/file-sources/${contentSha256}`,
        bytes,
        size: bytes.length,
        contentSha256,
      };
    },
    readSourceFile: async () => { throw new Error("not used"); },
    publishWebsite: async () => { throw new Error("not used"); },
    dispose: async () => undefined,
  };
}

function createCreateFileTool(input: Parameters<typeof buildCreateFileTool>[0] & { createdFiles?: unknown[] }) {
  return buildCreateFileTool({ ...input, outgoingFiles: testOutgoingFiles(input, input.createdFiles) });
}
