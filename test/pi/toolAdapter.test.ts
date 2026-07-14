import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import type { CreatedFileAttachment, ToolBuildInput } from "../../src/ai/tools/types.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";

describe("Pi safe tool adapters", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("delivers a just-bash image from memory without a managed image path", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-adapter-"));
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: path.join(tempDir, "bash") });
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9901, firstName: "Adapter", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Adapter" });
    const createdFiles: CreatedFileAttachment[] = [];
    const buildInput = (): ToolBuildInput => ({ config, db: db!, repos, user, thread, createdFiles });
    const tools = createPiToolAdapters({ buildInput, stageImages: () => undefined });
    const bash = tools.find((tool) => tool.name === "bash")!;
    const createFile = tools.find((tool) => tool.name === "create_file")!;

    await bash.execute("bash-call", { script: "printf image-bytes > picture.png" }, undefined, undefined, {} as never);
    const result = await createFile.execute("file-call", {
      path: "/picture.png",
      caption: "Pi-created image",
      delivery: "auto",
    }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ type: "image", caption: "Pi-created image" });
    expect(createdFiles).toHaveLength(1);
    expect(createdFiles[0]).toMatchObject({ delivery: "photo", path: undefined, caption: "Pi-created image" });
    expect(createdFiles[0]?.data).toEqual(Buffer.from("image-bytes"));
    await expect(repos.files.get(createdFiles[0]!.fileId)).resolves.toMatchObject({ path: null, type: "image" });
  });
});
