import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import type { CreatedFileAttachment, ToolBuildInput } from "../../src/ai/tools/types.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import { botThreadWorkspace } from "../../src/sandbox/paths.js";
import type { SandboxCommandRequest, SandboxCommandResult, SandboxFileExportRequest, CommandRuntime } from "../../src/sandbox/types.js";

describe("Pi safe tool adapters", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists and delivers a OpenSandbox-created image from the managed chat-file store", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-adapter-"));
    const config = testConfig(tempDir);
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9901, firstName: "Adapter", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Adapter" });
    const workspace = botThreadWorkspace(config, user.tg_id, thread.id);
    const runtime = new FakeRuntime(async () => {
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "picture.png"), "image-bytes");
      return successfulCommand();
    }, async (request) => {
      const destination = request.hostDestination;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(workspace, "picture.png"), destination);
    });
    const createdFiles: CreatedFileAttachment[] = [];
    const buildInput = (): ToolBuildInput => ({
      config,
      db: db!,
      repos,
      user,
      thread,
      createdFiles,
      commandRuntime: runtime,
    });
    const tools = createPiToolAdapters({ buildInput });
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
    expect(createdFiles[0]).toMatchObject({ delivery: "photo", caption: "Pi-created image" });
    expect(createdFiles[0]?.path).toBe(path.join(config.MANAGED_FILE_ROOT, String(createdFiles[0]?.fileId), "content"));
    await expect(fs.readFile(createdFiles[0]!.path!)).resolves.toEqual(Buffer.from("image-bytes"));
  });

  it("stages only requested scoped attachments for the live adapter call", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-input-"));
    const config = testConfig(tempDir);
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9902, firstName: "Input", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Input" });
    const bytes = Buffer.from("telegram attachment");
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      mimeType: "text/plain",
      name: "telegram.txt",
      path: null,
      size: bytes.length,
      summary: "attachment",
      isInline: true,
    });
    const runtime = new FakeRuntime(async (request) => {
      expect(request.env[`CHAT_FILE_${file.id}`]).toMatch(new RegExp(`/attachments/[^/]+/${file.id}$`));
      return successfulCommand("read-ok\n");
    });
    const resolveFile = vi.fn(async () => ({
      path: "",
      bytes,
      mimeType: "text/plain",
      size: bytes.length,
      contentSha256: "hash",
      expiresAt: Number.POSITIVE_INFINITY,
      source: { transport: "test", connectionKey: "default", remoteKey: String(file.id), locator: {} },
    }));
    const bash = createPiToolAdapters({
      buildInput: () => ({ config, db: db!, repos, user, thread, commandRuntime: runtime, resolveFile }),
    }).find((tool) => tool.name === "bash")!;

    const result = await bash.execute("bash-input", {
      script: `cat "$CHAT_FILE_${file.id}"`,
      input_file_ids: [file.id],
    }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({
      exit_code: 0,
      input_files: [{ file_id: file.id, name: "telegram.txt", size: bytes.length }],
    });
    expect(resolveFile).toHaveBeenCalledTimes(1);
  });

  it("does not contact OpenSandbox while tool adapters are constructed", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-lazy-box-"));
    const config = testConfig(tempDir);
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9903, firstName: "Lazy", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Lazy" });
    const runtime = new FakeRuntime();

    const tools = createPiToolAdapters({
      buildInput: () => ({ config, db: db!, repos, user, thread, commandRuntime: runtime }),
    });

    expect(tools.map((tool) => tool.name)).toContain("bash");
    expect((tools.find((tool) => tool.name === "bash")!.parameters as { required?: string[] }).required)
      .toEqual(["script"]);
    expect((tools.find((tool) => tool.name === "web_search")!.parameters as { required?: string[] }).required)
      .toEqual(["query"]);
    expect(runtime.requests).toHaveLength(0);
  });
});

class FakeRuntime implements CommandRuntime {
  readonly requests: SandboxCommandRequest[] = [];

  constructor(
    private readonly handler: (request: SandboxCommandRequest) => Promise<SandboxCommandResult> = async () => successfulCommand(),
    private readonly exporter: (request: SandboxFileExportRequest) => Promise<void> = async () => {
      throw new Error("export not configured");
    },
  ) {}

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.requests.push(request);
    return this.handler(request);
  }

  exportFile(request: SandboxFileExportRequest): Promise<void> {
    return this.exporter(request);
  }

  async reconcile(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function successfulCommand(stdout = ""): SandboxCommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function testConfig(root: string) {
  return loadTestConfig({
    AGENT_SHARED_ROOT: path.join(root, "agent"),
    MANAGED_FILE_ROOT: path.join(root, "agent", ".chat-files"),
    BASH_WORKSPACE_ROOT: path.join(root, "legacy-bash"),
  });
}
