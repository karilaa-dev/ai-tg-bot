import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import type { CreatedFileAttachment, ToolBuildInput } from "../../src/ai/tools/types.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import { FileByteCache } from "../../src/files/cache.js";
import { FileResolver } from "../../src/files/resolver.js";
import { ManagedFileStore } from "../../src/files/storage.js";
import type { ChatFileSourceAdapter } from "../../src/files/source.js";

describe("Pi safe tool adapters", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists and delivers a just-bash image from the managed chat-file store", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-adapter-"));
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: path.join(tempDir, "bash") });
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9901, firstName: "Adapter", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Adapter" });
    const createdFiles: CreatedFileAttachment[] = [];
    const buildInput = (): ToolBuildInput => ({ config, db: db!, repos, user, thread, createdFiles });
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
    expect(createdFiles[0]?.path).toBe(path.join(config.BASH_WORKSPACE_ROOT, ".chat-files", String(createdFiles[0]?.fileId), "content"));
    expect(createdFiles[0]?.data).toEqual(Buffer.from("image-bytes"));
    await expect(repos.files.get(createdFiles[0]!.fileId)).resolves.toMatchObject({ path: createdFiles[0]?.path, type: "image" });
  });

  it("mounts scoped chat attachment snapshots for Python and JavaScript", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-input-image-"));
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: path.join(tempDir, "bash") });
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9902, firstName: "InputImage", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Input image" });
    const image = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      mimeType: "image/png",
      name: "telegram.png",
      path: null,
      size: 20,
      summary: "a Telegram image",
      isInline: true,
    });
    const bytes = Buffer.from([
      255, 0, 0,
      200, 10, 10,
      0, 0, 255,
    ]);
    let downloads = 0;
    const buildInput = (): ToolBuildInput => ({
      config,
      db: db!,
      repos,
      user,
      thread,
      resolveFile: async (file) => {
        downloads += 1;
        expect(file.id).toBe(image.id);
        return resolvedFile(bytes, file.id);
      },
    });
    const bash = createPiToolAdapters({ buildInput })
      .find((tool) => tool.name === "bash")!;
    const virtualPath = `/attachments/${image.id}`;
    const result = await bash.execute("bash-input", {
      script: [
        `python3 -c 'd=open("${virtualPath}", "rb").read(); print(sum(1 for i in range(0,len(d),3) if d[i] > d[i+1]*2 and d[i] > d[i+2]*2))'`,
        `js-exec -m -c "import fs from 'fs'; const d=fs.readFileSync('${virtualPath}'); let n=0; for(let i=0;i<d.length;i+=3){const r=d.readUInt8(i),g=d.readUInt8(i+1),b=d.readUInt8(i+2); if(r>g*2&&r>b*2)n++} console.log(n)"`,
        `printenv CHAT_FILE_${image.id}`,
        "printf persistent > /kept.txt",
      ].join("; "),
      input_file_ids: [image.id],
    }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({
      exit_code: 0,
      input_files: [{ file_id: image.id, path: virtualPath, name: "telegram.png", size: bytes.length }],
    });
    expect((result.details as { stdout: string }).stdout).toBe(`2\n2\n${virtualPath}\n`);
    expect(downloads).toBe(1);
    await expect(fs.readFile(path.join(config.BASH_WORKSPACE_ROOT, `thread-${thread.id}`, "kept.txt"), "utf8"))
      .resolves.toBe("persistent");
    await expect(fs.access(path.join(config.BASH_WORKSPACE_ROOT, `thread-${thread.id}`, "attachments")))
      .rejects.toThrow();

    const otherThread = await repos.threads.create({ userId: user.tg_id, topicId: 22, title: "Other" });
    const otherImage = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: otherThread.id,
      type: "image",
      name: "other.png",
      path: null,
      size: 5,
      summary: "out of scope",
      isInline: true,
    });
    await expect(bash.execute("bash-cross-thread", {
      script: "wc -c /attachments/input",
      input_file_ids: [otherImage.id],
    }, undefined, undefined, {} as never)).rejects.toThrow("not available in this thread");
  });

  it("lists every scoped attachment without downloading and restores only the file that is read", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-lazy-attachments-"));
    const config = loadTestConfig({
      BASH_WORKSPACE_ROOT: path.join(tempDir, "bash"),
      FILE_CACHE_DIR: path.join(tempDir, "cache"),
    });
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9903, firstName: "LazyFiles", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Lazy files" });
    const firstBytes = Buffer.from("first remote attachment");
    const secondBytes = Buffer.from("second remote attachment");
    const first = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      mimeType: "text/plain",
      name: "first.txt",
      path: null,
      size: firstBytes.length,
      contentMd: firstBytes.toString(),
      isInline: true,
    });
    const second = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      mimeType: "text/plain",
      name: "second.txt",
      path: null,
      size: secondBytes.length,
      contentMd: secondBytes.toString(),
      isInline: true,
    });
    for (const file of [first, second]) {
      await repos.files.rememberSource(file.id, {
        transport: "matrix",
        connectionKey: "main",
        remoteKey: `mxc://example/${file.id}`,
        locator: { url: `mxc://example/${file.id}` },
        mimeType: "text/plain",
      });
    }
    const payloads = new Map([
      [`mxc://example/${first.id}`, firstBytes],
      [`mxc://example/${second.id}`, secondBytes],
    ]);
    const fetch = vi.fn(async (source: Parameters<ChatFileSourceAdapter["fetch"]>[0]) => payloads.get(source.remoteKey)!);
    const resolver = new FileResolver(
      repos.files,
      new FileByteCache(config),
      new ManagedFileStore(config),
    );
    resolver.registry.register({ transport: "matrix", connectionKey: "main", fetch });
    const bash = createPiToolAdapters({
      buildInput: () => ({
        config,
        db: db!,
        repos,
        user,
        thread,
        resolveFile: (file, signal) => resolver.resolveFile(file, signal),
      }),
    }).find((tool) => tool.name === "bash")!;

    const metadata = await bash.execute("metadata", {
      script: `ls /attachments; find /attachments -maxdepth 1 -type f; stat /attachments/${first.id}`,
    }, undefined, undefined, {} as never);
    expect(metadata.details).toMatchObject({ exit_code: 0, input_files: [] });
    expect(fetch).not.toHaveBeenCalled();

    const firstRead = await bash.execute("first-read", {
      script: `wc -c /attachments/${first.id}`,
    }, undefined, undefined, {} as never);
    expect(firstRead.details).toMatchObject({ exit_code: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(repos.files.get(first.id)).resolves.toMatchObject({
      path: path.join(config.BASH_WORKSPACE_ROOT, ".chat-files", String(first.id), "content"),
    });
    await expect(repos.files.get(second.id)).resolves.toMatchObject({ path: null });

    await bash.execute("first-read-again", {
      script: `sha256sum /attachments/${first.id}`,
    }, undefined, undefined, {} as never);
    expect(fetch).toHaveBeenCalledTimes(1);

    const copyOnWrite = await bash.execute("copy-on-write", {
      script: `printf changed > /attachments/${first.id}; cat /attachments/${first.id}`,
    }, undefined, undefined, {} as never);
    expect((copyOnWrite.details as { stdout: string }).stdout).toBe("changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(config.BASH_WORKSPACE_ROOT, ".chat-files", String(first.id), "content")))
      .resolves.toEqual(firstBytes);
  });
});

function resolvedFile(bytes: Buffer, fileId: number) {
  return {
    path: "",
    bytes,
    mimeType: "image/png",
    size: bytes.length,
    contentSha256: "test-hash",
    expiresAt: Number.POSITIVE_INFINITY,
    source: { transport: "test", connectionKey: "default", remoteKey: String(fileId), locator: {} },
  };
}
