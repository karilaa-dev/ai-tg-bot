import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCreateFileTool } from "../../src/ai/tools/createFile.js";
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

  it("does not insert a generic duplicate when durable source registration fails", async () => {
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
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(1);
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
    expect(createdFiles[0]?.data).toBeUndefined();
    expect(await repos.files.listForThreads([thread.id])).toHaveLength(1);
  });
});

function fileRuntime(bytes: Buffer, contentSha256: string): CommandRuntime {
  return {
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
