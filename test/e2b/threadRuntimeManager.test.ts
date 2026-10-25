import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { SandboxNotFoundError, TimeoutError } from "e2b";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import {
  E2B_IDLE_PAUSE_MS,
  E2B_WEBSITE_IDLE_PAUSE_MS,
  type E2BClient,
  type E2BCommandHandle,
  type E2BSandbox,
} from "../../src/e2b/client.js";
import { E2B_FILE_SOURCES, E2B_TELEGRAM_FILES, E2B_WORKSPACE } from "../../src/e2b/paths.js";
import { e2bFileSource } from "../../src/e2b/fileSource.js";
import { ThreadE2BSandboxRuntimeManager } from "../../src/e2b/threadRuntimeManager.js";
import { resolveThreadFileDescriptors } from "../../src/e2b/threadFiles.js";
import { MAX_FILE_BYTES, TG_DOWNLOAD_MAX_BYTES } from "../../src/files/limits.js";
import type { SandboxCommandRequest, SandboxThreadFile } from "../../src/sandbox/types.js";
import { WebFileSourceAdapter, webFileSource } from "../../src/web/file-source.js";
import { deferred } from "../helpers/async.js";
import { officeBundle, OFFICE_BUNDLE_PATH } from "../../src/e2b/officeBundle.js";

describe("thread E2B runtime manager", () => {
  let config: AppConfig;
  let db: AppDatabase;
  let repos: Repos;
  let client: FakeClient;
  let runtime: ThreadE2BSandboxRuntimeManager;
  let userId: number;
  let threadId: number;

  beforeEach(async () => {
    config = loadTestConfig();
    db = createDatabase(config);
    await db.initialize();
    repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7001, firstName: "E2B", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Sandbox" });
    userId = user.tg_id;
    threadId = thread.id;
    client = new FakeClient();
    runtime = createRuntime();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await runtime.dispose();
    await db.destroy();
  });

  it("caches source scans for ordinary commands and refreshes them before exports", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await expect(runtime.execute(commandRequest(userId, threadId))).resolves.toMatchObject({ stdout: "ok" });
    const sandbox = client.onlySandbox();
    const scans = () => sandbox.controlCommands.filter(command => command.includes("source_root=sys.argv[1]"));
    expect(scans()).toHaveLength(1);

    await runtime.execute(commandRequest(userId, threadId));
    expect(scans()).toHaveLength(1);
    sandbox.files.set(`${E2B_WORKSPACE}/export.stl`, Buffer.from("export"));
    const exported = await runtime.readWorkspaceFile({
      userId, threadId, virtualPath: "/export.stl", maxBytes: 100, preserveSource: true,
    });
    expect(exported.bytes).toEqual(Buffer.from("export"));
    expect(scans()).toHaveLength(2);

    now += 59_999;
    await runtime.execute(commandRequest(userId, threadId));
    expect(scans()).toHaveLength(2);
    now += 1;
    await runtime.execute(commandRequest(userId, threadId));
    expect(scans()).toHaveLength(3);
  });

  it("reads captured stdout and stderr concurrently", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const original = sandbox.readFile.bind(sandbox);
    const both = deferred<void>();
    const started = new Set<string>();
    vi.spyOn(sandbox, "readFile").mockImplementation(async (...args) => {
      if (/\/(stdout|stderr)$/u.test(args[0])) {
        started.add(args[0].split("/").at(-1)!);
        if (started.size === 2) both.resolve();
        await both.promise;
      }
      return original(...args);
    });
    const result = await runtime.execute(commandRequest(userId, threadId));
    expect(started).toEqual(new Set(["stdout", "stderr"]));
    expect(result.stdout).toBe("ok");
  });

  it("kills a command cancelled during startup without starting an unobserved wait", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const controller = new AbortController();
    const wait = vi.fn(async () => { throw new Error("Command exited with code 137"); });
    const kill = vi.fn(async () => true);
    vi.spyOn(sandbox, "runBackground").mockImplementation(async () => {
      controller.abort(new Error("cancelled during startup"));
      return { pid: 123, wait, kill };
    });

    await expect(runtime.execute({ ...commandRequest(userId, threadId), signal: controller.signal }))
      .rejects.toThrow("cancelled during startup");
    expect(kill).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(["stdout", "stderr"])("propagates transport failures while checking captured %s", async (stream) => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const original = sandbox.fileExists.bind(sandbox);
    vi.spyOn(sandbox, "fileExists").mockImplementation(async (filePath) => {
      if (filePath.endsWith(`/${stream}`)) throw new Error("output transport unavailable");
      return original(filePath);
    });

    await expect(runtime.execute(commandRequest(userId, threadId)))
      .rejects.toThrow("output transport unavailable");
  });

  it("propagates cancellation during output collection", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const controller = new AbortController();
    const original = sandbox.fileExists.bind(sandbox);
    vi.spyOn(sandbox, "fileExists").mockImplementation(async (filePath) => {
      if (/\/(stdout|stderr)$/u.test(filePath)) {
        controller.abort(new Error("output collection cancelled"));
        throw controller.signal.reason;
      }
      return original(filePath);
    });

    await expect(runtime.execute({ ...commandRequest(userId, threadId), signal: controller.signal }))
      .rejects.toThrow("output collection cancelled");
  });

  it("allows genuinely missing output captures", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const original = sandbox.fileExists.bind(sandbox);
    vi.spyOn(sandbox, "fileExists").mockImplementation(async (filePath) =>
      /\/(stdout|stderr)$/u.test(filePath) ? false : original(filePath));

    await expect(runtime.execute(commandRequest(userId, threadId)))
      .resolves.toMatchObject({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
  });

  it("creates one sandbox per thread and synchronizes Telegram files once as read-only", async () => {
    client.telegramFiles.set("tg-hello", Buffer.from("hello"));
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      contentSha256: createHash("sha256").update("hello").digest("hex"),
      mimeType: "text/plain",
      name: "../draft?.txt",
      size: 5,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      telegramMessageId: 44,
      refs: [{
        fileId: "tg-hello",
        fileUniqueId: "unique-hello",
        size: 5,
        primary: true,
      }],
    });
    const file: SandboxThreadFile = {
      fileId: stored.id,
      messageId: 44,
      name: "../draft?.txt",
      mimeType: "text/plain",
      expectedSize: 5,
      expectedSha256: createHash("sha256").update("hello").digest("hex"),
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: "tg-hello",
        telegramSize: 5,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: Date.now(),
      }],
    };

    const first = await runtime.execute(commandRequest(userId, threadId, [file]));
    const second = await runtime.execute(commandRequest(userId, threadId, [file]));
    const sandbox = client.onlySandbox();
    const restoredPath = `${E2B_TELEGRAM_FILES}/${stored.id}--draft_.txt`;
    sandbox.files.set(restoredPath, Buffer.from("x"));
    await runtime.dispose();
    runtime = createRuntime();
    const repaired = await runtime.execute(commandRequest(userId, threadId, [file]));

    expect(first.threadFiles).toMatchObject({ directory: E2B_TELEGRAM_FILES, available: 1 });
    expect(second.threadFiles.available).toBe(1);
    expect(repaired.threadFiles.available).toBe(1);
    expect(client.createCalls).toBe(1);
    expect(sandbox.metadata.template_ref).toBe(config.E2B_TEMPLATE);
    expect(client.telegramDownloadCalls).toBe(2);
    expect(sandbox.inventoryCalls).toBe(2);
    expect(sandbox.files.get(restoredPath)?.toString()).toBe("hello");
    expect(sandbox.controlCommands.some((command) =>
      command.includes("find '/home/user/telegram-files' -type f -exec chmod 444")))
      .toBe(true);
    expect(sandbox.controlCommands.some((command) =>
      command.includes("chmod 555 '/home/user/telegram-files'")))
      .toBe(true);
    expect(sandbox.controlCommands.some((command) =>
      command.includes("chown root '/home/user/telegram-files'")))
      .toBe(true);
    expect(await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, threadId))
      .toMatchObject({ sandbox_id: sandbox.id, thread_id: threadId, user_id: userId });
    expect(await repos.sandboxFileRestores.listForSandbox(config.E2B_DEPLOYMENT_ID, sandbox.id))
      .toMatchObject([{
        file_id: stored.id,
        telegram_file_ref_id: telegramRef!.id,
        status: "available",
        restored_size: 5,
      }]);
    expect(sandbox.writeFileCalls.some((call) =>
      call.user === "root"
      && call.requestTimeoutMs === config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS))
      .toBe(true);
  });

  it("writes binary assets atomically into this thread workspace and cleans staging files", async () => {
    const bytes = Buffer.from([0, 255, 12, 7]);
    await runtime.writeWorkspaceFile({userId,threadId,virtualPath:"/assets/generated.png",bytes});
    const sandbox = client.onlySandbox();
    expect(sandbox.files.get(`${E2B_WORKSPACE}/assets/generated.png`)).toEqual(bytes);
    expect([...sandbox.files.keys()].some(name=>name.includes("/.write-"))).toBe(false);
    expect(sandbox.writeFileCalls.some(call=>call.user === "user" && call.path.includes("/.write-"))).toBe(true);
  });

  it("rejects writes through a parent symlink outside the workspace", async () => {
    await runtime.execute(commandRequest(userId,threadId));
    const sandbox=client.onlySandbox();
    const original=sandbox.run.bind(sandbox);
    vi.spyOn(sandbox,"run").mockImplementation(async command=>command.startsWith("'realpath'") ? {stdout:"/etc\n",stderr:"",exitCode:0} : original(command));
    await expect(runtime.writeWorkspaceFile({userId,threadId,virtualPath:"/escape/file.png",bytes:Buffer.from("image")})).rejects.toThrow("escapes");
    expect(sandbox.writeFileCalls.some(call=>call.user === "user" && call.path.includes("/.write-"))).toBe(false);
  });

  it("upgrades Office once without replacing the sandbox or touching user files", async () => {
    await runtime.execute(commandRequest(userId,threadId));
    const sandbox=client.onlySandbox();
    sandbox.files.set(`${E2B_WORKSPACE}/keep.txt`,Buffer.from("keep"));
    await runtime.execute(commandRequest(userId,threadId));
    expect(sandbox.controlCommands.filter(command=>command.includes(".staging-") && command.includes("/install.sh'"))).toHaveLength(1);
    const toolboxChecks = () => sandbox.controlCommands.filter(command => command.includes("/tmp/ai-tg-bot-toolbox-upgrade.lock"));
    expect(toolboxChecks()).toHaveLength(1);
    expect(sandbox.writeFileCalls.some(call => call.path.startsWith(OFFICE_BUNDLE_PATH + "/"))).toBe(false);
    expect(sandbox.files.get("/opt/office/installed-revision")?.toString()).toBe((await officeBundle()).revision);
    await runtime.dispose();
    runtime = createRuntime();
    await runtime.execute(commandRequest(userId, threadId));
    expect(sandbox.controlCommands.filter(command=>command.includes(".staging-") && command.includes("/install.sh'"))).toHaveLength(1);
    expect(toolboxChecks()).toHaveLength(2);
    expect(sandbox.files.get(`${E2B_WORKSPACE}/keep.txt`)?.toString()).toBe("keep");
    expect(client.createCalls).toBe(1);
    expect(client.killCalls).toBe(0);
  });

  it("leaves the active bundle untouched on a failed upload and retries in a fresh directory", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    await runtime.dispose();
    runtime = createRuntime();
    sandbox.files.set("/opt/office/installed-revision", Buffer.from("previous revision"));
    sandbox.files.set(`${OFFICE_BUNDLE_PATH}/obsolete.txt`, Buffer.from("old asset"));
    const before = Buffer.from(sandbox.files.get(`${OFFICE_BUNDLE_PATH}/install.sh`)!);
    const original = sandbox.writeFile.bind(sandbox);
    let failedPath = "";
    const writer = vi.spyOn(sandbox, "writeFile").mockImplementation(async (...args) => {
      if (args[0].includes(".staging-")) {
        failedPath = args[0];
        throw new Error("upload interrupted");
      }
      return original(...args);
    });
    await expect(runtime.execute(commandRequest(userId, threadId))).rejects.toThrow("upload interrupted");
    expect(sandbox.files.get(`${OFFICE_BUNDLE_PATH}/install.sh`)).toEqual(before);
    expect(sandbox.files.get(`${OFFICE_BUNDLE_PATH}/obsolete.txt`)?.toString()).toBe("old asset");
    expect(sandbox.controlCommands.some(command => command.startsWith("'rm' '-rf' '--'") && failedPath.startsWith(command.split("'")[7]!))).toBe(true);
    writer.mockRestore();
    await runtime.execute(commandRequest(userId, threadId));
    expect(sandbox.files.has(`${OFFICE_BUNDLE_PATH}/obsolete.txt`)).toBe(false);
    expect(sandbox.writeFileCalls.filter(call => call.path.includes(".staging-")).every(call => call.path !== failedPath)).toBe(true);
  });

  it("reconnects a mapped sandbox after the configured template version changes", async () => {
    const originalTemplateRef = config.E2B_TEMPLATE;
    await runtime.execute(commandRequest(userId, threadId));
    const originalSandbox = client.onlySandbox();
    await runtime.dispose();

    config = { ...config, E2B_TEMPLATE: "ai-tg-bot-tools:v3.0.0" };
    runtime = createRuntime();
    await runtime.execute(commandRequest(userId, threadId));

    expect(client.createCalls).toBe(1);
    expect(client.connectCalls).toBe(1);
    expect(client.onlySandbox().id).toBe(originalSandbox.id);
    expect(client.onlySandbox().metadata.template_ref).toBe(originalTemplateRef);
  });

  it("materializes requested files selectively and preserves earlier restorations additively", async () => {
    client.telegramFiles.set("tg-first", Buffer.from("first"));
    client.telegramFiles.set("tg-second", Buffer.from("second"));
    const files: SandboxThreadFile[] = [
      descriptor(8_001, "first.txt", "tg-first", 9_001, 5),
      descriptor(8_002, "second.txt", "tg-second", 9_002, 6),
    ];

    const first = await runtime.materializeFiles({ userId, threadId, files: [files[0]!] });
    const second = await runtime.materializeFiles({ userId, threadId, files: [files[1]!] });
    const command = await runtime.execute(commandRequest(userId, threadId));

    expect(first.files).toEqual([expect.objectContaining({ fileId: 8_001, status: "available" })]);
    expect(second.files).toEqual([expect.objectContaining({ fileId: 8_002, status: "available" })]);
    expect(client.telegramDownloadCalls).toBe(2);
    const sandbox = client.onlySandbox();
    expect(sandbox.files.get(`${E2B_TELEGRAM_FILES}/8001--first.txt`)?.toString()).toBe("first");
    expect(sandbox.files.get(`${E2B_TELEGRAM_FILES}/8002--second.txt`)?.toString()).toBe("second");
    const index = JSON.parse(await sandbox.readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index.files.map((file: { file_id: number }) => file.file_id)).toEqual([8_001, 8_002]);
    expect(command.threadFiles.available).toBe(2);
  });

  it.each([false, true])("restores durable web bytes after sandbox replacement (failed Telegram: %s)", async (failedTelegram) => {
    const bytes = Buffer.from("#!/bin/sh\ntouch /tmp/do-not-execute-web-attachment\n");
    const file = await storeWebDescriptor("../upload?.sh", bytes);
    if (failedTelegram) {
      file.telegramRefs = descriptor(file.fileId, file.name, "tg-missing-web", 9_111, bytes.length).telegramRefs;
    }
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    const first = await runtime.materializeFiles({ userId, threadId, files: [file] });
    expect(first.files).toEqual([expect.objectContaining({ fileId: file.fileId, status: "available" })]);
    const destination = `${E2B_TELEGRAM_FILES}/${file.fileId}--upload_.sh`;
    expect(client.onlySandbox().files.get(destination)).toEqual(bytes);
    expect(client.onlySandbox().backgroundCalls).toBe(0);
    expect(fetch).toHaveBeenCalledWith(webFileSource(file.fileId, "text/plain"), expect.any(AbortSignal), MAX_FILE_BYTES);
    await runtime.dispose();
    client.sandboxes.clear();
    runtime = createRuntime();

    const restored = await runtime.materializeFiles({ userId, threadId, files: [file] });
    const sandbox = client.onlySandbox();
    expect(restored.available).toBe(1);
    expect(sandbox.files.get(destination)).toEqual(bytes);
    expect(client.createCalls).toBe(2);
    expect(client.telegramDownloadCalls).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sandbox.backgroundCalls).toBe(0);
    expect(sandbox.controlCommands.join("\n")).not.toContain("do-not-execute-web-attachment");
    const writes = sandbox.writeFileCalls.filter(call => call.path.includes("/restore-"));
    expect(writes).toEqual([expect.objectContaining({ user: "root" })]);
    expect(sandbox.controlCommands.some(command => command.includes(`chmod 444 '${writes[0]?.path}'`))).toBe(true);
    expect(sandbox.controlCommands.some(command => command.includes(`chmod 555 '${E2B_TELEGRAM_FILES}'`))).toBe(true);
    expect([...sandbox.files.keys()].some(name => name.includes("/restore-"))).toBe(false);
    expect(await repos.sandboxFileRestores.listForSandbox(config.E2B_DEPLOYMENT_ID, sandbox.id))
      .toMatchObject([{ file_id: file.fileId, status: "available", telegram_file_ref_id: null, restored_size: bytes.length }]);
  });

  it("prefers canonical web bytes even when a Telegram representation is available", async () => {
    const file = await storeWebDescriptor("shared.txt", Buffer.from("hello"));
    client.telegramFiles.set("tg-web-valid", Buffer.from("hello"));
    file.telegramRefs = descriptor(file.fileId, file.name, "tg-web-valid", 9_112, 5).telegramRefs;
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    expect((await runtime.materializeFiles({ userId, threadId, files: [file] })).available).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.telegramDownloadCalls).toBe(0);
  });

  it.each(["read", "size", "hash"])("restores a canonical Telegram document after a web %s failure", async (failure) => {
    const bytes = Buffer.from("hello");
    const file = await storeWebDescriptor("fallback.txt", bytes);
    await addTelegramDocument(file, bytes);
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    if (failure === "read") fetch.mockRejectedValueOnce(new Error("web read unavailable"));
    else fetch.mockResolvedValueOnce(Buffer.from(failure === "size" ? "shorter?" : "wrong"));

    const result = await runtime.materializeFiles({ userId, threadId, files: [file] });
    const sandbox = client.onlySandbox();
    expect(result.available).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.telegramDownloadCalls).toBe(1);
    expect(sandbox.files.get(`${E2B_TELEGRAM_FILES}/${file.fileId}--fallback.txt`)).toEqual(bytes);
    expect(await repos.sandboxFileRestores.listForSandbox(config.E2B_DEPLOYMENT_ID, sandbox.id))
      .toMatchObject([{ file_id: file.fileId, status: "available", telegram_file_ref_id: file.telegramRefs[0]?.id,
        restored_size: bytes.length, restored_sha256: file.expectedSha256 }]);
    expect([...sandbox.files.keys()].some(name => name.includes("/restore-"))).toBe(false);
  });

  it.each(["hash", "unknown size", "different size"])("rejects a corrupt Telegram document fallback with %s", async (failure) => {
    const file = await storeWebDescriptor("corrupt.txt", Buffer.from("hello"));
    const corrupt = Buffer.from(failure === "different size" ? "wrong length" : "wrong");
    await addTelegramDocument(file, corrupt, failure === "unknown size" ? null : corrupt.length);
    vi.spyOn(WebFileSourceAdapter.prototype, "fetch").mockRejectedValueOnce(new Error("web read unavailable"));

    const result = await runtime.materializeFiles({ userId, threadId, files: [file] });
    const sandbox = client.onlySandbox();
    expect(result.files).toEqual([expect.objectContaining({ fileId: file.fileId, path: null, errorCode: "file_unavailable" })]);
    expect(client.telegramDownloadCalls).toBe(1);
    expect(sandbox.writeFileCalls.filter(call => call.path.includes("/restore-"))).toEqual([]);
    expect(sandbox.files.has(`${E2B_TELEGRAM_FILES}/${file.fileId}--corrupt.txt`)).toBe(false);
  });

  it("does not download an oversized Telegram fallback after web failure", async () => {
    const file = await storeWebDescriptor("large.txt", Buffer.from("hello"));
    await addTelegramDocument(file, Buffer.from("hello"), TG_DOWNLOAD_MAX_BYTES + 1);
    vi.spyOn(WebFileSourceAdapter.prototype, "fetch").mockRejectedValueOnce(new Error("web read unavailable"));

    const result = await runtime.materializeFiles({ userId, threadId, files: [file] });
    expect(result.files).toEqual([expect.objectContaining({ fileId: file.fileId, path: null, errorCode: "file_unavailable" })]);
    expect(client.telegramDownloadCalls).toBe(0);
    expect(client.onlySandbox().writeFileCalls.filter(call => call.path.includes("/restore-"))).toEqual([]);
  });

  it("restores a valid empty web attachment", async () => {
    const file = await storeWebDescriptor("empty.txt", Buffer.alloc(0));
    expect((await runtime.materializeFiles({ userId, threadId, files: [file] })).available).toBe(1);
    expect(client.onlySandbox().files.get(`${E2B_TELEGRAM_FILES}/${file.fileId}--empty.txt`)).toEqual(Buffer.alloc(0));
  });

  it("materializes a 50 MiB web source after Telegram acceptance and sandbox replacement", async () => {
    const bytes = Buffer.alloc(MAX_FILE_BYTES, 0xa5);
    const file = await storeWebDescriptor("maximum.bin", bytes);
    file.telegramRefs = descriptor(file.fileId, file.name, "too-large-for-getFile", 9_113, MAX_FILE_BYTES).telegramRefs;
    for (let attempt = 0; attempt < 2; attempt++) {
      const restored = await runtime.materializeFiles({ userId, threadId, files: [file] });
      expect(restored.available).toBe(1);
      expect(client.onlySandbox().files.get(`${E2B_TELEGRAM_FILES}/${file.fileId}--maximum.bin`)?.equals(bytes)).toBe(true);
      expect(client.telegramDownloadCalls).toBe(0);
      await runtime.dispose();
      client.sandboxes.clear();
      runtime = createRuntime();
    }
  }, 30_000);

  it("retains immutable snapshots whose accepted Telegram document cannot be downloaded", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const bytes = Buffer.alloc(TG_DOWNLOAD_MAX_BYTES + 1, 0xa5);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const canonicalPath = `${E2B_FILE_SOURCES}/${hash}`;
    sandbox.files.set(canonicalPath, bytes);
    const file = await repos.files.insertFile({ userId, threadId, type: "other", name: "large.bin",
      size: bytes.length, contentSha256: hash, isInline: false });
    await repos.files.rememberSource(file.id, e2bFileSource(config, { userId, threadId, fileId: file.id,
      sandboxId: sandbox.id, sourceCanonicalPath: canonicalPath, size: bytes.length, contentSha256: hash }));
    await repos.files.rememberTelegramFileRefs(file.id, { direction: "outbound", mediaKind: "document",
      refs: [{ fileId: "accepted-large-file", size: bytes.length, primary: true }] });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await runtime.execute(commandRequest(userId, threadId));
    expect(sandbox.files.has(canonicalPath)).toBe(true);
    expect((await repos.files.listSources(file.id)).map(source => source.transport)).toContain("e2b");
  });

  it.each(["missing", "size", "hash", "declared limit", "actual limit"])("rejects a web blob with %s failure before staging", async (failure) => {
    const file = await storeWebDescriptor("broken.txt", Buffer.from("hello"));
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    if (failure === "missing") await db.db.execute(sql`delete from web_file_blobs where file_id = ${file.fileId}`);
    if (failure === "size") file.expectedSize = 6;
    if (failure === "hash") file.expectedSha256 = "0".repeat(64);
    if (failure === "declared limit") file.expectedSize = MAX_FILE_BYTES + 1;
    if (failure === "actual limit") {
      await db.db.execute(sql`update web_file_blobs set bytes = ${Buffer.alloc(MAX_FILE_BYTES + 1)} where file_id = ${file.fileId}`);
    }

    const result = await runtime.materializeFiles({ userId, threadId, files: [file] });
    const sandbox = client.onlySandbox();
    expect(result.available).toBe(0);
    expect(result.files).toEqual([expect.objectContaining({ fileId: file.fileId, path: null, errorCode: "file_unavailable" })]);
    expect(sandbox.writeFileCalls.filter(call => call.path.includes("/restore-"))).toEqual([]);
    expect(sandbox.files.has(`${E2B_TELEGRAM_FILES}/${file.fileId}--broken.txt`)).toBe(false);
    if (failure === "declared limit") expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "connection", "remote key"])("requires a matching registered web source (%s)", async (failure) => {
    const file = await storeWebDescriptor("private.txt", Buffer.from("hello"));
    if (failure === "missing") await db.db.execute(sql`delete from file_sources where file_id = ${file.fileId}`);
    if (failure === "connection") await db.db.execute(sql`update file_sources set connection_key = 'other' where file_id = ${file.fileId}`);
    if (failure === "remote key") await db.db.execute(sql`update file_sources set remote_key = '999999' where file_id = ${file.fileId}`);
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    expect((await runtime.materializeFiles({ userId, threadId, files: [file] })).available).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary private file ID but restores an explicit cross-user attachment grant", async () => {
    const owner = await repos.users.ensure({ tgId: 7002, firstName: "Other", lang: "en" });
    const privateThread = await repos.threads.create({ userId: owner.tg_id, topicId: null, title: "Private" });
    const privateFile = await storeWebDescriptor("private-original.txt", Buffer.from("hello"), { userId: owner.tg_id, threadId: privateThread.id });
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    expect((await runtime.materializeFiles({ userId, threadId, files: [privateFile] })).available).toBe(0);
    expect(fetch).not.toHaveBeenCalled();

    const message = await repos.messages.insert({ threadId, role: "user", content: [], textPlain: "shared" });
    await repos.files.attachToMessage(message.id, privateFile.fileId, { displayName: "shared.txt" });
    const thread = await repos.threads.get(threadId);
    if (!thread) throw new Error("missing thread fixture");
    const files = await resolveThreadFileDescriptors({ repos, thread });
    const result = await runtime.materializeFiles({ userId, threadId, files });
    expect(result.files).toEqual([expect.objectContaining({ fileId: privateFile.fileId, originalName: "shared.txt", status: "available" })]);
    expect(fetch).toHaveBeenCalledOnce();
    const sandbox = client.onlySandbox();
    expect(sandbox.files.get(`${E2B_TELEGRAM_FILES}/${privateFile.fileId}--shared.txt`)).toEqual(Buffer.from("hello"));
    expect(await sandbox.readText(`${E2B_TELEGRAM_FILES}/INDEX.json`)).not.toContain("private-original");
  });

  it.each([true, false])("does not bypass a private web file's scope with forged Telegram fallback refs (web adapter: %s)", async (webAdapter) => {
    await runtime.dispose();
    runtime = createRuntime(webAdapter);
    const owner = await repos.users.ensure({ tgId: 7002, firstName: "Other", lang: "en" });
    const privateThread = await repos.threads.create({ userId: owner.tg_id, topicId: null, title: "Private" });
    const bytes = Buffer.from("private bytes");
    const file = await storeWebDescriptor("private.txt", bytes, { userId: owner.tg_id, threadId: privateThread.id });
    file.telegramRefs = descriptor(file.fileId, file.name, "forged-private-ref", 9_114, bytes.length).telegramRefs;
    client.telegramFiles.set("forged-private-ref", bytes);
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");

    const result = await runtime.materializeFiles({ userId, threadId, files: [file] });
    expect(result.available).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(client.telegramDownloadCalls).toBe(0);
    expect(client.onlySandbox().files.has(`${E2B_TELEGRAM_FILES}/${file.fileId}--private.txt`)).toBe(false);
    expect(client.onlySandbox().writeFileCalls.filter(call => call.path.includes("/restore-"))).toEqual([]);
  });

  it.each([false, true])("rejects a different user's thread before sandbox access (cached: %s)", async (cached) => {
    const file = await storeWebDescriptor("private.txt", Buffer.from("hello"));
    const other = await repos.users.ensure({ tgId: 7002, firstName: "Other", lang: "en" });
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    if (cached) {
      expect((await runtime.materializeFiles({ userId, threadId, files: [file] })).available).toBe(1);
      fetch.mockClear();
    }
    const createCalls = client.createCalls;
    const connectCalls = client.connectCalls;
    await expect(runtime.materializeFiles({ userId: other.tg_id, threadId, files: [file] }))
      .rejects.toThrow("Sandbox thread does not belong to this user");
    expect(fetch).not.toHaveBeenCalled();
    expect(client.createCalls).toBe(createCalls);
    expect(client.connectCalls).toBe(connectCalls);
  });

  it("restores only ancestor attachments before the fork boundary", async () => {
    const before = await storeWebDescriptor("before.txt", Buffer.from("before"));
    const after = await storeWebDescriptor("after.txt", Buffer.from("after"));
    await addTelegramDocument(after, Buffer.from("after"));
    const fork = await repos.threads.create({ userId, topicId: null, title: "Fork", parentThreadId: threadId, forkPointMessageId: before.messageId });
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    const result = await runtime.materializeFiles({ userId, threadId: fork.id, files: [before, after] });
    expect(result.available).toBe(1);
    expect(result.files).toEqual([
      expect.objectContaining({ fileId: before.fileId, status: "available" }),
      expect.objectContaining({ fileId: after.fileId, path: null }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(webFileSource(before.fileId, "text/plain"), expect.any(AbortSignal), MAX_FILE_BYTES);
    expect(client.telegramDownloadCalls).toBe(0);
  });

  it("propagates cancellation during web fetching and seals the sandbox directory", async () => {
    const file = await storeWebDescriptor("cancelled.txt", Buffer.from("hello"));
    await addTelegramDocument(file, Buffer.from("hello"));
    const controller = new AbortController();
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch").mockImplementationOnce(async () => {
      controller.abort(new Error("web download cancelled"));
      return Buffer.from("hello");
    });
    await expect(runtime.materializeFiles({ userId, threadId, files: [file], signal: controller.signal }))
      .rejects.toThrow("web download cancelled");
    await runtime.dispose();
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.telegramDownloadCalls).toBe(0);
    const sandbox = client.onlySandbox();
    expect(sandbox.writeFileCalls.filter(call => call.path.includes("/restore-"))).toEqual([]);
    expect(sandbox.controlCommands.some(command => command.includes(`chmod 555 '${E2B_TELEGRAM_FILES}'`))).toBe(true);
  });

  it("propagates a standalone web AbortError without Telegram fallback", async () => {
    const file = await storeWebDescriptor("cancelled.txt", Buffer.from("hello"));
    await addTelegramDocument(file, Buffer.from("hello"));
    const cancellation = new Error("web fetch cancelled");
    cancellation.name = "AbortError";
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch").mockRejectedValueOnce(cancellation);

    await expect(runtime.materializeFiles({ userId, threadId, files: [file] })).rejects.toBe(cancellation);
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.telegramDownloadCalls).toBe(0);
    const sandbox = client.onlySandbox();
    expect(sandbox.writeFileCalls.filter(call => call.path.includes("/restore-"))).toEqual([]);
    expect(sandbox.controlCommands.some(command => command.includes(`chmod 555 '${E2B_TELEGRAM_FILES}'`))).toBe(true);
  });

  it.each([true, false])("distinguishes staging control cancellation from recoverable failure (cancelled: %s)", async (cancelled) => {
    const bytes = Buffer.from("hello");
    const file = await storeWebDescriptor("staging.txt", bytes);
    await addTelegramDocument(file, bytes);
    await runtime.materializeFiles({ userId, threadId, files: [] });
    const sandbox = client.onlySandbox();
    const failure = new Error("staging command interrupted");
    if (cancelled) failure.name = "AbortError";
    const run = sandbox.run.bind(sandbox);
    let interrupted = false;
    vi.spyOn(sandbox, "run").mockImplementation(async (...args) => {
      if (!interrupted && args[0].includes("/restore-") && args[0].includes("mv -f")) {
        interrupted = true;
        throw failure;
      }
      return run(...args);
    });

    const restoration = runtime.materializeFiles({ userId, threadId, files: [file] });
    if (cancelled) {
      await expect(restoration).rejects.toBe(failure);
      expect(client.telegramDownloadCalls).toBe(0);
      expect(sandbox.files.has(`${E2B_TELEGRAM_FILES}/${file.fileId}--staging.txt`)).toBe(false);
    } else {
      expect((await restoration).available).toBe(1);
      expect(client.telegramDownloadCalls).toBe(1);
      expect(sandbox.files.get(`${E2B_TELEGRAM_FILES}/${file.fileId}--staging.txt`)).toEqual(bytes);
    }
    await runtime.dispose();
    expect([...sandbox.files.keys()].some(name => name.includes("/restore-"))).toBe(false);
    expect(sandbox.controlCommands.some(command => command.includes(`chmod 555 '${E2B_TELEGRAM_FILES}'`))).toBe(true);
  });

  it("keeps adapter failure details out of the sandbox index and persisted restore status", async () => {
    const file = await storeWebDescriptor("unavailable.txt", Buffer.from("hello"));
    vi.spyOn(WebFileSourceAdapter.prototype, "fetch").mockRejectedValueOnce(new Error("private-db-detail-and-credentials"));
    expect((await runtime.materializeFiles({ userId, threadId, files: [file] })).available).toBe(0);
    const sandbox = client.onlySandbox();
    expect(await sandbox.readText(`${E2B_TELEGRAM_FILES}/INDEX.json`)).not.toContain("private-db-detail-and-credentials");
    expect(JSON.stringify(await repos.sandboxFileRestores.listForSandbox(config.E2B_DEPLOYMENT_ID, sandbox.id)))
      .not.toContain("private-db-detail-and-credentials");
  });

  it("cleans partial web staging and seals the directory when a write is cancelled", async () => {
    const file = await storeWebDescriptor("cancelled.txt", Buffer.from("hello"));
    await runtime.materializeFiles({ userId, threadId, files: [] });
    const sandbox = client.onlySandbox();
    const controller = new AbortController();
    const writeFile = sandbox.writeFile.bind(sandbox);
    vi.spyOn(sandbox, "writeFile").mockImplementation(async (...args) => {
      await writeFile(...args);
      if (args[0].includes("/restore-")) {
        controller.abort(new Error("web staging cancelled"));
        throw controller.signal.reason;
      }
    });
    await expect(runtime.materializeFiles({ userId, threadId, files: [file], signal: controller.signal }))
      .rejects.toThrow("web staging cancelled");
    await runtime.dispose();
    expect([...sandbox.files.keys()].some(name => name.includes("/restore-"))).toBe(false);
    expect(sandbox.files.has(`${E2B_TELEGRAM_FILES}/${file.fileId}--cancelled.txt`)).toBe(false);
    expect(sandbox.controlCommands.at(-1)).toContain(`chmod 555 '${E2B_TELEGRAM_FILES}'`);
  });

  it("ignores traversal names read from a tampered sandbox index", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const outsidePath = "/home/etc/hosts";
    sandbox.files.set(outsidePath, Buffer.from("must survive"));
    sandbox.files.set(`${E2B_TELEGRAM_FILES}/INDEX.json`, Buffer.from(JSON.stringify({
      version: 2,
      generated_at: new Date().toISOString(),
      files: [{
        file_id: 999,
        message_id: null,
        original_name: "hosts",
        sandbox_name: "../../etc/hosts",
        mime_type: "text/plain",
        size: 12,
        sha256: null,
        status: "available",
      }],
    })));
    await runtime.dispose();
    runtime = createRuntime();

    await runtime.execute(commandRequest(userId, threadId));

    expect(sandbox.files.get(outsidePath)?.toString()).toBe("must survive");
    const rewritten = JSON.parse(await sandbox.readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(rewritten.files).toEqual([]);
  });

  it("records a partial restore failure without surfacing failure details in the command result", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      mimeType: "text/plain",
      name: "missing.txt",
      size: 7,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      refs: [{ fileId: "tg-missing", size: 7, primary: true }],
    });
    const result = await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));

    expect(result.exitCode).toBe(0);
    expect(result.threadFiles).toMatchObject({ directory: E2B_TELEGRAM_FILES, available: 0 });
    expect(result.threadFiles).not.toHaveProperty("failed");
    const index = JSON.parse(await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index).toMatchObject({
      version: 2,
      files: [{
        file_id: stored.id,
        status: "error",
        error_code: "file_unavailable",
      }],
    });
    expect(await repos.sandboxFileRestores.listForSandbox(
      config.E2B_DEPLOYMENT_ID,
      client.onlySandbox().id,
    )).toMatchObject([{
      file_id: stored.id,
      status: "error",
      error_code: "file_unavailable",
    }]);

    await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));
    expect(client.telegramDownloadCalls).toBe(1);
    expect(client.onlySandbox().inventoryCalls).toBe(1);

    now += 5 * 60_000 + 1;
    await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));
    expect(client.telegramDownloadCalls).toBe(2);
    expect(client.onlySandbox().inventoryCalls).toBe(2);
  });

  it("redacts configured Telegram tokens from persisted restore diagnostics", async () => {
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      mimeType: "text/plain",
      name: "secret-error.txt",
      size: 7,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      refs: [{ fileId: "tg-secret-error", size: 7, primary: true }],
    });
    const leakedUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/documents/file.txt`;
    const encodedToken = encodeURIComponent(config.BOT_TOKEN);
    await runtime.dispose();
    runtime = new ThreadE2BSandboxRuntimeManager({
      config,
      repos,
      client,
      downloadTelegramBytes: async () => {
        throw new Error(`download failed at ${leakedUrl}; token=${encodedToken}`);
      },
    });

    await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));

    const indexText = await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`);
    expect(indexText).not.toContain(config.BOT_TOKEN);
    expect(indexText).not.toContain(encodedToken);
    expect(indexText).toContain("[redacted]");
    const records = await repos.sandboxFileRestores.listForSandbox(
      config.E2B_DEPLOYMENT_ID,
      client.onlySandbox().id,
    );
    expect(records[0]?.error_detail).not.toContain(config.BOT_TOKEN);
    expect(records[0]?.error_detail).not.toContain(encodedToken);
  });

  it("refreshes restored bytes when the logical file descriptor changes", async () => {
    const original = Buffer.from("old");
    const updated = Buffer.from("updated");
    client.telegramFiles.set("tg-changing", original);
    const base: SandboxThreadFile = {
      fileId: 2_900,
      messageId: 90,
      name: "changing.txt",
      mimeType: "text/plain",
      expectedSize: original.length,
      expectedSha256: createHash("sha256").update(original).digest("hex"),
      telegramRefs: [{
        id: 3_900,
        telegramFileId: "tg-changing",
        telegramSize: original.length,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: Date.now(),
      }],
    };
    await runtime.execute(commandRequest(userId, threadId, [base]));
    const sandboxPath = `${E2B_TELEGRAM_FILES}/${base.fileId}--changing.txt`;
    expect(client.onlySandbox().files.get(sandboxPath)).toEqual(original);

    client.telegramFiles.set("tg-changing", updated);
    const refreshed: SandboxThreadFile = {
      ...base,
      expectedSize: updated.length,
      expectedSha256: createHash("sha256").update(updated).digest("hex"),
      telegramRefs: [{ ...base.telegramRefs[0]!, telegramSize: updated.length }],
    };
    await runtime.execute(commandRequest(userId, threadId, [refreshed]));

    expect(client.telegramDownloadCalls).toBe(2);
    expect(client.onlySandbox().files.get(sandboxPath)).toEqual(updated);
    const index = JSON.parse(await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index.files).toContainEqual(expect.objectContaining({
      file_id: base.fileId,
      descriptor_size: updated.length,
      descriptor_sha256: refreshed.expectedSha256,
      size: updated.length,
      sha256: refreshed.expectedSha256,
    }));

    client.telegramFiles.delete("tg-changing");
    const unavailable: SandboxThreadFile = {
      ...refreshed,
      expectedSize: 6,
      expectedSha256: createHash("sha256").update("latest").digest("hex"),
      telegramRefs: [{ ...refreshed.telegramRefs[0]!, telegramSize: 6 }],
    };
    await runtime.execute(commandRequest(userId, threadId, [unavailable]));

    expect(client.onlySandbox().files.has(sandboxPath)).toBe(false);
    const failedIndex = JSON.parse(await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(failedIndex.files).toContainEqual(expect.objectContaining({
      file_id: base.fileId,
      descriptor_sha256: unavailable.expectedSha256,
      status: "error",
    }));
  });

  it("scales the sandbox operation window by projected restore batches", async () => {
    const files: SandboxThreadFile[] = Array.from({ length: 9 }, (_, index) => ({
      fileId: 3_000 + index,
      messageId: null,
      name: `${index}.txt`,
      mimeType: "text/plain",
      expectedSize: 1,
      expectedSha256: null,
      telegramRefs: [],
    }));

    await runtime.execute(commandRequest(userId, threadId, files));

    const projectedBatches = Math.ceil(files.length / config.TELEGRAM_FILE_RESTORE_CONCURRENCY);
    const expectedWindowMs = 30_000
      + projectedBatches * config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS
      + 5 * 60_000;
    expect(client.onlySandbox().timeoutCalls).toContain(expectedWindowMs);
  });

  it("does not repeatedly rotate a file-heavy sandbox when synchronization is cached", async () => {
    const files: SandboxThreadFile[] = Array.from({ length: 40 }, (_, index) => ({
      fileId: 4_000 + index,
      messageId: null,
      name: `${index}.txt`,
      mimeType: "text/plain",
      expectedSize: 1,
      expectedSha256: null,
      telegramRefs: [],
    }));

    await runtime.execute(commandRequest(userId, threadId, files));
    const sandbox = client.onlySandbox();
    const rotationsAfterFirstSync = sandbox.pauseCalls;
    await runtime.execute(commandRequest(userId, threadId, files));

    expect(sandbox.pauseCalls).toBe(rotationsAfterFirstSync);
    expect(sandbox.inventoryCalls).toBe(1);
  });

  it("preserves the primary synchronization error when directory sealing also fails", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    sandbox.failIndexWrite = true;
    sandbox.failSeal = true;
    const file: SandboxThreadFile = {
      fileId: 991,
      messageId: null,
      name: "broken.txt",
      mimeType: "text/plain",
      expectedSize: 1,
      expectedSha256: null,
      telegramRefs: [],
    };

    await expect(runtime.execute(commandRequest(userId, threadId, [file])))
      .rejects.toMatchObject({
        name: "AggregateError",
        message: expect.stringContaining("index write failed"),
      });
  });

  it("waits for every restore worker to stop before sealing after cancellation", async () => {
    await runtime.dispose();
    const bothStarted = deferred<void>();
    const releaseDelayedWorker = deferred<void>();
    let started = 0;
    runtime = new ThreadE2BSandboxRuntimeManager({
      config,
      repos,
      client,
      downloadTelegramBytes: async (fileId, signal) => {
        if (!signal) throw new Error("test restore requires a cancellation signal");
        started += 1;
        if (started === 2) bothStarted.resolve();
        if (fileId === "abort-first") {
          return new Promise<Buffer>((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        await releaseDelayedWorker.promise;
        throw new Error("delayed restore worker stopped");
      },
    });
    const files: SandboxThreadFile[] = ["abort-first", "delay-second"].map((telegramFileId, index) => ({
      fileId: 1_200 + index,
      messageId: null,
      name: `${index}.txt`,
      mimeType: "text/plain",
      expectedSize: 1,
      expectedSha256: null,
      telegramRefs: [{
        id: 2_200 + index,
        telegramFileId,
        telegramSize: 1,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: Date.now(),
      }],
    }));
    const controller = new AbortController();
    const execution = runtime.execute({
      ...commandRequest(userId, threadId, files),
      signal: controller.signal,
    });
    void execution.catch(() => undefined);
    await bothStarted.promise;

    controller.abort(new Error("restore cancelled"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.onlySandbox().controlCommands.some((command) =>
      command.includes("find '/home/user/telegram-files' -type f -exec chmod 444")))
      .toBe(false);

    releaseDelayedWorker.resolve();
    await expect(execution).rejects.toThrow("restore cancelled");
    // execute() rejects promptly on abort; the queued operation finishes cleanup.
    await vi.waitFor(() => {
      expect(client.onlySandbox().controlCommands.some((command) =>
        command.includes("find '/home/user/telegram-files' -type f -exec chmod 444")))
        .toBe(true);
    });
  });

  it("preserves the publication window without resetting it after later turns", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const lease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    const published = await runtime.publishWebsite({
      userId,
      threadId,
      port: 3000,
      siteDirectory: "/site",
      path: "/demo",
    });
    await lease.release();
    expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(E2B_WEBSITE_IDLE_PAUSE_MS);
    expect(published).toMatchObject({
      url: "https://3000-sandbox-1.e2b.test/demo",
      siteDirectory: `${E2B_WORKSPACE}/site`,
      pausesAfterMinutes: 15,
    });

    now += 5 * 60_000;
    const sourcePath = `${E2B_FILE_SOURCES}/published-source`;
    client.onlySandbox().files.set(sourcePath, Buffer.from("source"));
    await expect(runtime.readSourceFile({
      sandboxId: client.onlySandbox().id,
      userId,
      threadId,
      canonicalPath: sourcePath,
      maxBytes: 100,
    })).resolves.toEqual(Buffer.from("source"));
    expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(10 * 60_000);

    const followUpLease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(10 * 60_000);
    await followUpLease.release();
    expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(10 * 60_000);

    now += 8 * 60_000;
    const lateFollowUpLease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    await lateFollowUpLease.release();
    expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(E2B_IDLE_PAUSE_MS);
  });

  it("starts the website idle window only after E2B accepts the timeout", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const lease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    await runtime.publishWebsite({
      userId,
      threadId,
      port: 3000,
      siteDirectory: "/site",
      path: "/",
    });
    const sandbox = client.onlySandbox();
    const attemptsBeforeRelease = sandbox.timeoutAttempts;
    sandbox.nextSetTimeoutError = new Error("timeout arm failed");
    await expect(lease.release()).resolves.toBeUndefined();
    expect(sandbox.timeoutAttempts).toBeGreaterThan(attemptsBeforeRelease);

    now += 5 * 60_000;
    const retryLease = runtime.acquireActivityLease(userId, threadId);
    await retryLease.release();
    expect(sandbox.timeoutCalls.at(-1)).toBe(E2B_WEBSITE_IDLE_PAUSE_MS);
  });

  it("preserves immutable versions when the same workspace path is overwritten", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const workspacePath = `${E2B_WORKSPACE}/report.txt`;
    sandbox.files.set(workspacePath, Buffer.from("version one"));
    const first = await runtime.readWorkspaceFile({
      userId,
      threadId,
      virtualPath: "/report.txt",
      maxBytes: 100,
      preserveSource: true,
    });
    const firstFile = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      contentSha256: first.contentSha256,
      mimeType: "text/plain",
      name: "report-v1.txt",
      size: first.size,
      isInline: true,
    });
    await repos.files.rememberSource(firstFile.id, e2bFileSource(config, {
      ...first,
      fileId: firstFile.id,
      sourceCanonicalPath: first.sourceCanonicalPath!,
      userId,
      threadId,
      mimeType: "text/plain",
    }));
    sandbox.files.set(workspacePath, Buffer.from("version two"));
    const second = await runtime.readWorkspaceFile({
      userId,
      threadId,
      virtualPath: "/report.txt",
      maxBytes: 100,
      preserveSource: true,
    });
    const secondFile = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      contentSha256: second.contentSha256,
      mimeType: "text/plain",
      name: "report-v2.txt",
      size: second.size,
      isInline: true,
    });
    await repos.files.rememberSource(secondFile.id, e2bFileSource(config, {
      ...second,
      fileId: secondFile.id,
      sourceCanonicalPath: second.sourceCanonicalPath!,
      userId,
      threadId,
      mimeType: "text/plain",
    }));

    expect(first.sourceCanonicalPath).toBe(`${E2B_FILE_SOURCES}/${first.contentSha256}`);
    expect(second.sourceCanonicalPath).toBe(`${E2B_FILE_SOURCES}/${second.contentSha256}`);
    expect(first.sourceCanonicalPath).not.toBe(second.sourceCanonicalPath);
    expect(sandbox.files.get(first.sourceCanonicalPath!)?.toString()).toBe("version one");
    expect(sandbox.files.get(second.sourceCanonicalPath!)?.toString()).toBe("version two");
    expect(sandbox.files.get(workspacePath)?.toString()).toBe("version two");
    await expect(runtime.readSourceFile({
      sandboxId: sandbox.id,
      userId,
      threadId,
      canonicalPath: first.sourceCanonicalPath!,
      maxBytes: 100,
    })).resolves.toEqual(Buffer.from("version one"));
    expect(sandbox.fileInfoCalls).toContainEqual({ path: first.sourceCanonicalPath, user: "root" });
    expect(sandbox.readFileCalls).toContainEqual({
      path: first.sourceCanonicalPath,
      user: "root",
      requestTimeoutMs: config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
    });
  });

  it("does not prune a fresh immutable source before its file row is registered", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const workspacePath = `${E2B_WORKSPACE}/pending.txt`;
    sandbox.files.set(workspacePath, Buffer.from("pending registration"));

    const exported = await runtime.readWorkspaceFile({
      userId,
      threadId,
      virtualPath: "/pending.txt",
      maxBytes: 100,
      preserveSource: true,
    });
    await runtime.execute(commandRequest(userId, threadId));

    expect(sandbox.files.get(exported.sourceCanonicalPath!))
      .toEqual(Buffer.from("pending registration"));
  });

  it("bounds unshared snapshots by least-recently-verified use and removes orphans", async () => {
    await runtime.dispose();
    config = loadTestConfig({ E2B_FILE_SOURCE_MAX_BYTES: 10 });
    runtime = createRuntime();
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const snapshots: Array<{ fileId: number; path: string }> = [];
    for (const [index, value] of ["first!", "second"].entries()) {
      const bytes = Buffer.from(value);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const sourcePath = `${E2B_FILE_SOURCES}/${hash}`;
      sandbox.files.set(sourcePath, bytes);
      const stored = await repos.files.insertFile({
        userId,
        threadId,
        type: "other",
        contentSha256: hash,
        mimeType: "application/octet-stream",
        name: `${index}.bin`,
        size: bytes.length,
        isInline: false,
      });
      await repos.files.rememberSource(stored.id, e2bFileSource(config, {
        sandboxId: sandbox.id,
        fileId: stored.id,
        sourceCanonicalPath: sourcePath,
        userId,
        threadId,
        size: bytes.length,
        contentSha256: hash,
        mimeType: stored.mime_type,
      }));
      snapshots.push({ fileId: stored.id, path: sourcePath });
      now += 1;
    }
    const orphanHash = "f".repeat(64);
    const orphanPath = `${E2B_FILE_SOURCES}/${orphanHash}`;
    sandbox.files.set(orphanPath, Buffer.from("orphan"));
    now += 60_000;

    await runtime.execute(commandRequest(userId, threadId));

    expect(sandbox.files.has(snapshots[0]!.path)).toBe(false);
    expect(sandbox.files.has(snapshots[1]!.path)).toBe(true);
    expect(sandbox.files.has(orphanPath)).toBe(false);
    await expect(repos.files.listSources(snapshots[0]!.fileId)).resolves.toEqual([]);
    await expect(repos.files.listSources(snapshots[1]!.fileId)).resolves.toHaveLength(1);
  });

  it("reuses an outbound artifact locally, prunes its snapshot, and falls back to Telegram after sandbox loss", async () => {
    const bytes = Buffer.from("outbound file");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      contentSha256: hash,
      mimeType: "text/plain",
      name: "outbound.txt",
      size: bytes.length,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "outbound",
      mediaKind: "document",
      refs: [{ fileId: "tg-outbound", size: bytes.length, primary: true }],
    });
    client.telegramFiles.set("tg-outbound", bytes);
    const descriptor: SandboxThreadFile = {
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "outbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    };

    await runtime.execute(commandRequest(userId, threadId));
    const original = client.onlySandbox();
    original.files.set(`${E2B_FILE_SOURCES}/${hash}`, bytes);
    await repos.files.rememberSource(stored.id, e2bFileSource(config, {
      sandboxId: original.id,
      fileId: stored.id,
      sourceCanonicalPath: `${E2B_FILE_SOURCES}/${hash}`,
      userId,
      threadId,
      size: bytes.length,
      contentSha256: hash,
      mimeType: stored.mime_type,
    }));
    await runtime.execute(commandRequest(userId, threadId, [descriptor]));

    expect(client.telegramDownloadCalls).toBe(0);
    expect(original.files.get(`${E2B_TELEGRAM_FILES}/${stored.id}--outbound.txt`)).toEqual(bytes);
    // An ordinary scan runs after the one-minute throttle window.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await runtime.execute(commandRequest(userId, threadId, [descriptor]));
    expect(original.files.has(`${E2B_FILE_SOURCES}/${hash}`)).toBe(false);
    await expect(repos.files.listSources(stored.id)).resolves.toEqual([]);

    await runtime.dispose();
    client.sandboxes.clear();
    runtime = createRuntime();
    await runtime.execute(commandRequest(userId, threadId, [descriptor]));

    expect(client.telegramDownloadCalls).toBe(1);
    expect(client.onlySandbox().files.get(`${E2B_TELEGRAM_FILES}/${stored.id}--outbound.txt`)).toEqual(bytes);
    await expect(repos.files.listSources(stored.id)).resolves.toEqual([]);
    await expect(repos.files.listRecoverableIds([stored.id])).resolves.toEqual([]);
  });

  it("keeps a shared immutable snapshot while any referencing file lacks a Telegram source", async () => {
    const bytes = Buffer.from("shared snapshot");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const first = await repos.files.insertFile({
      userId,
      threadId,
      type: "other",
      contentSha256: hash,
      mimeType: "application/octet-stream",
      name: "shared-a.bin",
      size: bytes.length,
      isInline: false,
    });
    const second = await repos.files.insertFile({
      userId,
      threadId,
      type: "other",
      contentSha256: hash,
      mimeType: "application/octet-stream",
      name: "shared-b.bin",
      size: bytes.length,
      isInline: false,
    });
    await repos.files.rememberTelegramFileRefs(first.id, {
      direction: "outbound",
      mediaKind: "document",
      refs: [{ fileId: "tg-shared", size: bytes.length, primary: true }],
    });

    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const sourcePath = `${E2B_FILE_SOURCES}/${hash}`;
    sandbox.files.set(sourcePath, bytes);
    for (const file of [first, second]) {
      await repos.files.rememberSource(file.id, e2bFileSource(config, {
        sandboxId: sandbox.id,
        fileId: file.id,
        sourceCanonicalPath: sourcePath,
        userId,
        threadId,
        size: bytes.length,
        contentSha256: hash,
        mimeType: file.mime_type,
      }));
    }

    await runtime.execute(commandRequest(userId, threadId));

    expect(sandbox.files.get(sourcePath)).toEqual(bytes);
    await expect(repos.files.listSources(first.id)).resolves.toHaveLength(1);
    await expect(repos.files.listSources(second.id)).resolves.toHaveLength(1);
  });

  it.each([false, true])("accepts a Telegram-reencoded outbound photo as best-effort recovery (web failure: %s)", async (webFailure) => {
    const original = Buffer.from("original outbound photo bytes");
    const recovered = Buffer.from("telegram photo");
    const recoveredHash = createHash("sha256").update(recovered).digest("hex");
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "image",
      contentSha256: createHash("sha256").update(original).digest("hex"),
      mimeType: "image/jpeg",
      name: "photo.jpg",
      size: original.length,
      isInline: false,
    });
    const fetch = vi.spyOn(WebFileSourceAdapter.prototype, "fetch");
    if (webFailure) {
      await repos.files.rememberSource(stored.id, webFileSource(stored.id, "image/jpeg"));
      fetch.mockRejectedValueOnce(new Error("web read unavailable"));
    }
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "outbound",
      mediaKind: "photo",
      refs: [{ fileId: "tg-photo", size: recovered.length, primary: true }],
    });
    client.telegramFiles.set("tg-photo", recovered);
    await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "outbound",
        mediaKind: "photo",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));

    const sandbox = client.onlySandbox();
    expect(fetch).toHaveBeenCalledTimes(webFailure ? 1 : 0);
    expect(client.telegramDownloadCalls).toBe(1);
    expect(sandbox.files.get(`${E2B_TELEGRAM_FILES}/${stored.id}--photo.jpg`)).toEqual(recovered);
    const index = JSON.parse(await sandbox.readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index.files[0]).toMatchObject({
      file_id: stored.id,
      status: "available",
      size: recovered.length,
      sha256: recoveredHash,
    });
  });

  it("does not let a newer smaller primary alias displace the canonical photo", async () => {
    const original = Buffer.from("largest photo representation");
    const smaller = Buffer.from("small photo");
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "image",
      contentSha256: createHash("sha256").update(original).digest("hex"),
      mimeType: "image/jpeg",
      name: "largest.jpg",
      size: original.length,
      isInline: false,
    });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "photo",
      refs: [
        { fileId: "tg-primary-missing", width: 100, height: 100, size: original.length, primary: true },
        { fileId: "tg-smaller", width: 20, height: 20, size: smaller.length, primary: false },
      ],
    });
    now += 1;
    const refs = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "photo",
      refs: [{ fileId: "tg-smaller", width: 20, height: 20, size: smaller.length, primary: true }],
    });
    client.telegramFiles.set("tg-smaller", smaller);
    await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: refs.map((ref) => ({
        id: ref.id,
        telegramFileId: ref.telegram_file_id,
        telegramSize: ref.telegram_size,
        width: ref.width,
        height: ref.height,
        direction: "inbound" as const,
        mediaKind: "photo" as const,
        isPrimary: Boolean(ref.is_primary),
        lastSeenAt: ref.last_seen_at,
      })),
    }]));

    expect(client.telegramDownloadCalls).toBe(1);
    const index = JSON.parse(await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index.files[0]).toMatchObject({
      file_id: stored.id,
      status: "error",
      error_code: "file_unavailable",
    });
  });

  it("uses conservative attachment paths for hostile Telegram names", async () => {
    const bytes = Buffer.from("safe");
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "text/plain",
      name: "../../$(touch PWN);&`x`\u202Ereport.txt",
      size: bytes.length,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      refs: [{ fileId: "tg-hostile", size: bytes.length, primary: true }],
    });
    client.telegramFiles.set("tg-hostile", bytes);
    await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        direction: "inbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));

    const index = JSON.parse(await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index.files[0].original_name).toBe(stored.name);
    expect(index.files[0].sandbox_name).toMatch(new RegExp(`^${stored.id}--[A-Za-z0-9][A-Za-z0-9._-]*$`));
    expect(index.files[0].sandbox_name).not.toMatch(/[$`;'"&\u202E]/u);
  });

  it("classifies only SDK timeout errors as sandbox timeouts", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    sandbox.nextWaitError = Object.assign(new Error("curl: operation timed out"), {
      name: "CommandExitError",
      exitCode: 28,
    });
    const processFailure = await runtime.execute(commandRequest(userId, threadId));
    expect(processFailure).toMatchObject({ exitCode: 28, timedOut: false });

    sandbox.nextWaitError = new TimeoutError("sandbox command exceeded its limit");
    const sandboxTimeout = await runtime.execute(commandRequest(userId, threadId));
    expect(sandboxTimeout.timedOut).toBe(true);
  });

  it("does not publish a website until its endpoint returns a successful status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("starting", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await runtime.execute(commandRequest(userId, threadId));

    await expect(runtime.publishWebsite({ userId, threadId, port: 3000, siteDirectory: "/site" }))
      .resolves.toMatchObject({ url: "https://3000-sandbox-1.e2b.test/" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects publication outside a dedicated workspace site directory", async () => {
    expect(() => runtime.publishWebsite({
      userId,
      threadId,
      port: 3000,
      siteDirectory: "/",
    })).toThrow("dedicated subdirectory");
    expect(() => runtime.publishWebsite({
      userId,
      threadId,
      port: 3000,
      siteDirectory: E2B_TELEGRAM_FILES,
    })).toThrow("cannot contain Telegram files");

    expect(client.createCalls).toBe(0);
  });

  it("rejects website paths that normalize to another host", () => {
    expect(() => runtime.publishWebsite({
      userId,
      threadId,
      port: 3000,
      siteDirectory: "/site",
      path: "/..//attacker.example/x",
    })).toThrow("remain relative after normalization");
    expect(client.createCalls).toBe(0);
  });

  it("rejects a listener that is not running from its declared site directory", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    client.onlySandbox().failWebsiteScope = true;

    await expect(runtime.publishWebsite({
      userId,
      threadId,
      port: 3000,
      siteDirectory: "/site",
    })).rejects.toThrow("listener is outside the declared site directory");
  });

  it("rejects an E2B file source from another sandbox or outside the workspace", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    await expect(runtime.readSourceFile({
      sandboxId: "somebody-else",
      userId,
      threadId,
      canonicalPath: `${E2B_WORKSPACE}/secret.txt`,
      maxBytes: 100,
    })).rejects.toThrow("does not belong");
    await expect(runtime.readSourceFile({
      sandboxId: client.onlySandbox().id,
      userId,
      threadId,
      canonicalPath: "/etc/passwd",
      maxBytes: 100,
    })).rejects.toThrow("outside this thread's durable file roots");
  });

  it("requires browser consent before reconnecting and immediately pauses after retrieval", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const canonicalPath = `${E2B_WORKSPACE}/saved.txt`;
    sandbox.files.set(canonicalPath, Buffer.from("saved"));
    await sandbox.pause();
    await runtime.dispose();
    runtime = createRuntime();
    const request = { sandboxId: sandbox.id, userId, threadId, canonicalPath, maxBytes: 100,
      policy: { allowSandboxResume: false, pauseAfterRead: true } };
    await expect(runtime.readSourceFile(request)).rejects.toThrow("needs its sandbox");
    expect(client.connectCalls).toBe(0);
    expect(sandbox.running).toBe(false);
    await expect(runtime.readSourceFile({ ...request, policy: { ...request.policy, allowSandboxResume: true } })).resolves.toEqual(Buffer.from("saved"));
    expect(client.connectCalls).toBe(1);
    expect(sandbox.running).toBe(false);
    expect(sandbox.pauseCalls).toBe(2);
  });

  it("pauses a sandbox resumed for a browser even when reading fails or is cancelled", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    await sandbox.pause();
    await runtime.dispose();
    runtime = createRuntime();
    const controller = new AbortController();
    const request = { sandboxId: sandbox.id, userId, threadId, canonicalPath: `${E2B_WORKSPACE}/missing.txt`, maxBytes: 100,
      policy: { allowSandboxResume: true, pauseAfterRead: true }, signal: controller.signal };
    await expect(runtime.readSourceFile(request)).rejects.toThrow();
    expect(sandbox.running).toBe(false);
    const connect = client.connect.bind(client);
    vi.spyOn(client, "connect").mockImplementation(async id => {
      const result = await connect(id);
      controller.abort();
      return result;
    });
    await expect(runtime.readSourceFile(request)).rejects.toThrow();
    expect(sandbox.running).toBe(false);
    expect(sandbox.pauseCalls).toBe(3);
  });

  it("does not pause a running sandbox used by the bot when the browser reads a file", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const canonicalPath = `${E2B_WORKSPACE}/saved.txt`;
    sandbox.files.set(canonicalPath, Buffer.from("saved"));
    await expect(runtime.readSourceFile({ sandboxId: sandbox.id, userId, threadId, canonicalPath, maxBytes: 100,
      policy: { allowSandboxResume: false, pauseAfterRead: true } })).resolves.toEqual(Buffer.from("saved"));
    expect(client.connectCalls).toBe(0);
    expect(sandbox.pauseCalls).toBe(0);
    expect(sandbox.running).toBe(true);
  });

  it("caches a source-file reconnection when it is the first operation after restart", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const sourcePath = `${E2B_WORKSPACE}/saved.txt`;
    sandbox.files.set(sourcePath, Buffer.from("saved"));
    await runtime.dispose();
    runtime = createRuntime();

    const request = {
      sandboxId: sandbox.id,
      userId,
      threadId,
      canonicalPath: sourcePath,
      maxBytes: 100,
    };
    await expect(runtime.readSourceFile(request)).resolves.toEqual(Buffer.from("saved"));
    await expect(runtime.readSourceFile(request)).resolves.toEqual(Buffer.from("saved"));

    expect(client.connectCalls).toBe(1);
  });

  it("waits for local work without arming a queued idle timeout during shutdown", async () => {
    const lease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const started = deferred<void>();
    const release = deferred<void>();
    sandbox.nextCommandGate = { started, release };
    const active = runtime.execute(commandRequest(userId, threadId));
    await started.promise;
    const timeouts = [...sandbox.timeoutCalls];
    lease.release();
    let disposed = false;
    const disposing = runtime.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(sandbox.pauseCalls).toBe(0);

    release.resolve();
    await active;
    await disposing;

    expect(sandbox.pauseCalls).toBe(0);
    expect(sandbox.running).toBe(true);
    expect(sandbox.timeoutCalls).toEqual(timeouts);
  });

  it("settles idle cleanup before handoff and leaves the successor's active sandbox running", async () => {
    const oldLease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const timeoutStarted = deferred<void>();
    const timeoutRelease = deferred<void>();
    const setTimeout = sandbox.setTimeout.bind(sandbox);
    vi.spyOn(sandbox, "setTimeout").mockImplementationOnce(async (timeoutMs) => {
      timeoutStarted.resolve();
      await timeoutRelease.promise;
      await setTimeout(timeoutMs);
    });
    let released = false;
    const releasing = Promise.resolve(oldLease.release()).then(() => { released = true; });
    await timeoutStarted.promise;
    try {
      expect(released).toBe(false);
    } finally {
      timeoutRelease.resolve();
      await releasing;
    }
    expect(sandbox.timeoutCalls.at(-1)).toBe(E2B_IDLE_PAUSE_MS);
    const successor = createRuntime();
    const lease = successor.acquireActivityLease(userId, threadId);
    const started = deferred<void>();
    const release = deferred<void>();
    sandbox.nextCommandGate = { started, release };
    const active = successor.execute({ ...commandRequest(userId, threadId), timeoutMs: 10 * 60_000 });
    try {
      await started.promise;
      const timeouts = [...sandbox.timeoutCalls];
      expect(timeouts.at(-1)).toBeGreaterThan(10 * 60_000);
      await runtime.dispose();
      expect(sandbox.pauseCalls).toBe(0);
      expect(sandbox.running).toBe(true);
      expect(sandbox.timeoutCalls).toEqual(timeouts);
      release.resolve();
      await expect(active).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      release.resolve();
      await active.catch(() => undefined);
      await lease.release();
      await successor.dispose();
    }
  });

  it("refuses to run an agent command when the Telegram directory cannot be sealed", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    expect(sandbox.backgroundCalls).toBe(1);
    sandbox.failSeal = true;
    await runtime.dispose();
    runtime = createRuntime();

    await expect(runtime.execute(commandRequest(userId, threadId)))
      .rejects.toThrow("seal failed");
    expect(sandbox.backgroundCalls).toBe(1);
  });

  it("pauses and reconnects before the one-hour continuous runtime limit", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    sandbox.startedAt = new Date(Date.now() - 56 * 60_000);
    await runtime.dispose();
    runtime = createRuntime();

    await runtime.execute(commandRequest(userId, threadId));

    expect(sandbox.pauseCalls).toBe(1);
    expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  });

  it("rejects an aborted command immediately while it is waiting for the thread queue", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const started = deferred<void>();
    const release = deferred<void>();
    sandbox.nextCommandGate = { started, release };
    const active = runtime.execute(commandRequest(userId, threadId));
    await started.promise;

    const controller = new AbortController();
    const queued = runtime.execute({
      ...commandRequest(userId, threadId),
      signal: controller.signal,
    });
    controller.abort(new Error("stopped"));

    await expect(queued).rejects.toThrow("stopped");
    release.resolve();
    await active;
  });

  it("does not hold a database transaction open while E2B creation waits", async () => {
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      mimeType: "text/plain",
      name: "concurrent.txt",
      size: 1,
      isInline: true,
    });
    const started = deferred<void>();
    const release = deferred<void>();
    client.nextCreateGate = { started, release };
    const creating = runtime.execute(commandRequest(userId, threadId));
    await started.promise;

    await expect(repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      refs: [{ fileId: "concurrent-ref", size: 1, primary: true }],
    })).resolves.toHaveLength(1);

    release.resolve();
    await expect(creating).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps one mapped sandbox when two runtime processes create concurrently", async () => {
    const secondRuntime = createRuntime();
    const bothCreating = deferred<void>();
    const release = deferred<void>();
    client.createBarrier = { count: 0, bothCreating, release };
    try {
      const first = runtime.execute(commandRequest(userId, threadId));
      const second = secondRuntime.execute(commandRequest(userId, threadId));
      await bothCreating.promise;
      release.resolve();

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(client.createCalls).toBe(2);
      expect(client.killCalls).toBe(1);
      expect(client.sandboxes.size).toBe(1);
      const sandbox = client.onlySandbox();
      await expect(repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, threadId))
        .resolves.toMatchObject({ sandbox_id: sandbox.id });
    } finally {
      await secondRuntime.dispose();
    }
  });

  it("pauses and preserves a discovered sandbox that loses an ambiguous mapping race", async () => {
    const metadata = {
      app: "ai-tg-bot",
      deployment: config.E2B_DEPLOYMENT_ID,
      template_ref: config.E2B_TEMPLATE,
      telegram_user_id: String(userId),
      thread_id: String(threadId),
    };
    const discovered = await client.create(metadata);
    let winnerId = "";
    client.afterNextList = async () => {
      const winner = await client.create(metadata);
      winnerId = winner.id;
      await repos.threadSandboxes.insertIfAbsent({
        deploymentId: config.E2B_DEPLOYMENT_ID,
        userId,
        threadId,
        sandboxId: winner.id,
      });
    };

    await runtime.execute(commandRequest(userId, threadId));

    expect(client.sandboxes.has(discovered.id)).toBe(true);
    expect(client.sandboxes.get(discovered.id)?.running).toBe(false);
    expect(client.sandboxes.get(discovered.id)?.pauseCalls).toBe(1);
    expect(client.sandboxes.has(winnerId)).toBe(true);
    expect(client.killCalls).toBe(0);
    await expect(repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, threadId))
      .resolves.toMatchObject({ sandbox_id: winnerId });
  });

  it("keeps the sandbox mapping when a transient error merely mentions 404", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandboxId = client.onlySandbox().id;
    await runtime.dispose();
    runtime = createRuntime();
    client.nextGetInfoError = new Error("gateway request failed after unrelated /404 route");

    await expect(runtime.execute(commandRequest(userId, threadId)))
      .rejects.toThrow("unrelated /404 route");
    await expect(repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, threadId))
      .resolves.toMatchObject({ sandbox_id: sandboxId });
    expect(client.createCalls).toBe(1);

    await expect(runtime.execute(commandRequest(userId, threadId))).resolves.toMatchObject({ exitCode: 0 });
    expect(client.onlySandbox().id).toBe(sandboxId);
  });

  function createRuntime(webAdapter = true): ThreadE2BSandboxRuntimeManager {
    return new ThreadE2BSandboxRuntimeManager({
      config,
      repos,
      client,
      ...(webAdapter ? { webFileSource: new WebFileSourceAdapter(db.db) } : {}),
      downloadTelegramBytes: async (fileId) => {
        client.telegramDownloadCalls += 1;
        const bytes = client.telegramFiles.get(fileId);
        if (!bytes) throw new Error("Telegram file unavailable");
        return bytes;
      },
    });
  }

  async function addTelegramDocument(file: SandboxThreadFile, bytes: Buffer, size: number | null = bytes.length): Promise<void> {
    const telegramFileId = `tg-backup-${file.fileId}`;
    const refs = await repos.files.rememberTelegramFileRefs(file.fileId, {
      direction: "outbound", mediaKind: "document", refs: [{ fileId: telegramFileId, size, primary: true }],
    });
    file.telegramRefs = refs.map(ref => ({
      id: ref.id, telegramFileId: ref.telegram_file_id, telegramSize: ref.telegram_size,
      direction: ref.direction, mediaKind: ref.media_kind, isPrimary: ref.is_primary === 1, lastSeenAt: ref.last_seen_at,
    }));
    client.telegramFiles.set(telegramFileId, bytes);
  }

  async function storeWebDescriptor(name: string, bytes: Buffer, scope = { userId, threadId }): Promise<SandboxThreadFile> {
    const message = await repos.messages.insert({ threadId: scope.threadId, role: "user", content: [], textPlain: "attachment" });
    const file = await repos.files.insertFile({
      ...scope, messageId: message.id, type: "txt", name, size: bytes.length,
      mimeType: "text/plain", contentSha256: createHash("sha256").update(bytes).digest("hex"), isInline: false,
    });
    await repos.files.rememberSource(file.id, webFileSource(file.id, "text/plain"));
    await db.db.execute(sql`insert into web_file_blobs(file_id, bytes) values (${file.id}, ${bytes})`);
    return {
      fileId: file.id, messageId: file.message_id, name: file.name, mimeType: file.mime_type,
      expectedSize: file.size, expectedSha256: file.content_sha256, telegramRefs: [],
    };
  }
});

function commandRequest(
  userId: number,
  threadId: number,
  threadFiles: SandboxThreadFile[] = [],
): SandboxCommandRequest {
  return {
    userId,
    threadId,
    command: "bash",
    args: ["-c", "printf ok"],
    env: {},
    stdin: "",
    workingDir: E2B_WORKSPACE,
    timeoutMs: 30_000,
    maxOutputChars: 1000,
    threadFiles,
  };
}

function descriptor(
  fileId: number,
  name: string,
  telegramFileId: string,
  refId: number,
  size: number,
): SandboxThreadFile {
  return {
    fileId,
    messageId: null,
    name,
    mimeType: "text/plain",
    expectedSize: size,
    expectedSha256: null,
    telegramRefs: [{
      id: refId,
      telegramFileId,
      telegramSize: size,
      direction: "inbound",
      mediaKind: "document",
      isPrimary: true,
      lastSeenAt: Date.now(),
    }],
  };
}

class FakeClient implements E2BClient {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly telegramFiles = new Map<string, Buffer>();
  telegramDownloadCalls = 0;
  createCalls = 0;
  connectCalls = 0;
  killCalls = 0;
  nextGetInfoError?: unknown;
  afterNextList?: () => Promise<void>;
  nextCreateGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };
  createBarrier?: {
    count: number;
    bothCreating: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };

  async list(metadata: Record<string, string>) {
    const matches = [...this.sandboxes.values()]
      .filter((sandbox) => Object.entries(metadata).every(([key, value]) => sandbox.metadata[key] === value))
      .map((sandbox) => sandbox.info());
    const afterList = this.afterNextList;
    this.afterNextList = undefined;
    await afterList?.();
    return matches;
  }

  async getInfo(sandboxId: string) {
    if (this.nextGetInfoError) {
      const error = this.nextGetInfoError;
      this.nextGetInfoError = undefined;
      throw error;
    }
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new SandboxNotFoundError(`Sandbox ${sandboxId} not found`);
    return sandbox.info();
  }

  async create(metadata: Record<string, string>): Promise<E2BSandbox> {
    const gate = this.nextCreateGate;
    this.nextCreateGate = undefined;
    gate?.started.resolve();
    await gate?.release.promise;
    if (this.createBarrier) {
      this.createBarrier.count += 1;
      if (this.createBarrier.count === 2) this.createBarrier.bothCreating.resolve();
      await this.createBarrier.release.promise;
    }
    this.createCalls += 1;
    const sandbox = new FakeSandbox(`sandbox-${this.createCalls}`, metadata, this.telegramFiles);
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async connect(sandboxId: string): Promise<E2BSandbox> {
    this.connectCalls += 1;
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new SandboxNotFoundError(`Sandbox ${sandboxId} not found`);
    sandbox.running = true;
    return sandbox;
  }

  async kill(sandboxId: string): Promise<boolean> {
    this.killCalls += 1;
    return this.sandboxes.delete(sandboxId);
  }

  onlySandbox(): FakeSandbox {
    expect(this.sandboxes.size).toBe(1);
    return [...this.sandboxes.values()][0]!;
  }
}

class FakeSandbox implements E2BSandbox {
  readonly files = new Map<string, Buffer>();
  readonly fileModifiedAtMs = new Map<string, number>();
  readonly controlCommands: string[] = [];
  readonly timeoutCalls: number[] = [];
  readonly writeFileCalls: Array<{ path: string; user: string; requestTimeoutMs?: number }> = [];
  timeoutAttempts = 0;
  startedAt = new Date();
  running = true;
  pauseCalls = 0;
  backgroundCalls = 0;
  inventoryCalls = 0;
  failSeal = false;
  failIndexWrite = false;
  failWebsiteScope = false;
  nextWaitError?: unknown;
  nextSetTimeoutError?: unknown;
  nextPauseError?: unknown;
  readonly readFilePaths: string[] = [];
  readonly readFileCalls: Array<{ path: string; user: string; requestTimeoutMs?: number }> = [];
  readonly fileInfoCalls: Array<{ path: string; user: string }> = [];
  nextCommandGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };

  constructor(
    readonly id: string,
    readonly metadata: Record<string, string>,
    readonly telegramFiles: Map<string, Buffer>,
  ) {}

  info() {
    return {
      sandboxId: this.id,
      state: this.running ? "running" : "paused",
      startedAt: this.startedAt,
      metadata: this.metadata,
      name: "desktop",
      templateId: "desktop",
    } as never;
  }

  async run(command: string) {
    this.controlCommands.push(command);
    if (command.startsWith("cat /opt/office/installed-revision"))
      return { stdout: this.files.get("/opt/office/installed-revision")?.toString() ?? "", stderr: "", exitCode: 0 };
    const officeInstall = command.match(/^'bash' '([^']+\.staging-[^']+)\/install.sh' '([a-f0-9]{64})'$/);
    if (officeInstall) {
      const staged = [...this.files].filter(([name]) => name.startsWith(officeInstall[1]! + "/"));
      for (const name of this.files.keys()) if (name.startsWith(OFFICE_BUNDLE_PATH + "/")) this.files.delete(name);
      for (const [name, bytes] of staged) {
        this.files.set(OFFICE_BUNDLE_PATH + name.slice(officeInstall[1]!.length), bytes);
        this.files.delete(name);
      }
      this.files.set("/opt/office/installed-revision", Buffer.from(officeInstall[2]!));
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (this.failSeal && command.includes("find '/home/user/telegram-files' -type f -exec chmod 444")) {
      throw new Error("seal failed");
    }
    const realpath = command.match(/^'realpath' '--' '([^']+)'$/)?.[1];
    if (realpath) {
      const candidate = realpath;
      return { stdout: `${candidate}\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("'python3' '-c' ") && command.includes("server_site=os.path.realpath")) {
      if (this.failWebsiteScope) throw new Error("listener is outside the declared site directory");
      return { stdout: `${E2B_WORKSPACE}/site\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("'python3' '-c' ")) {
      const candidate = command.match(/ '([^']+)'$/)?.[1];
      if (command.includes("source_root=sys.argv[1]")) {
        const prefix = `${E2B_FILE_SOURCES}/`;
        const inventory = [...this.files.entries()].flatMap(([filePath, bytes]) => {
          if (!filePath.startsWith(prefix)) return [];
          const name = filePath.slice(prefix.length);
          if (name.includes("/") || !/^[0-9a-f]{64}$/i.test(name)) return [];
          return [{ name, size: bytes.length, mtime_ms: this.fileModifiedAtMs.get(filePath) ?? 0 }];
        });
        return { stdout: JSON.stringify(inventory), stderr: "", exitCode: 0 };
      }
      if (command.includes("index_path=sys.argv[1]")) {
        this.inventoryCalls += 1;
        const indexBytes = candidate ? this.files.get(candidate) : undefined;
        const index = indexBytes
          ? JSON.parse(indexBytes.toString()) as { files?: Array<{ sandbox_name?: string }> }
          : { files: [] };
        const inventory = (index.files ?? []).flatMap((entry) => {
          if (!entry.sandbox_name) return [];
          const filePath = `${E2B_TELEGRAM_FILES}/${entry.sandbox_name}`;
          const bytes = this.files.get(filePath);
          return [{
            sandbox_name: entry.sandbox_name,
            regular: Boolean(bytes),
            size: bytes?.length ?? null,
            sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
          }];
        });
        return { stdout: JSON.stringify(inventory), stderr: "", exitCode: 0 };
      }
      const bytes = candidate ? this.files.get(candidate) : undefined;
      if (!bytes) throw new Error("not found");
      return {
        stdout: JSON.stringify({
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          head_hex: bytes.subarray(0, 4).toString("hex"),
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    for (const match of command.matchAll(/cp -- ('[^']*'|\S+) ('[^']*'|\S+)/g)) {
      const source = unquote(match[1]!);
      const destination = unquote(match[2]!);
      const bytes = this.files.get(source);
      if (bytes) this.files.set(destination, Buffer.from(bytes));
    }
    const atomicMove=command.match(/^'mv' '-T' '--' '([^']+)' '([^']+)'$/);
    if(atomicMove) {
      const bytes=this.files.get(atomicMove[1]!);
      if(bytes) {this.files.set(atomicMove[2]!,bytes);this.files.delete(atomicMove[1]!);}
    }
    for (const match of command.matchAll(/mv -f ('[^']*'|\S+) ('[^']*'|\S+)/g)) {
      const source = unquote(match[1]!);
      const destination = unquote(match[2]!);
      const bytes = this.files.get(source);
      if (bytes) {
        this.files.set(destination, bytes);
        this.fileModifiedAtMs.set(destination, this.fileModifiedAtMs.get(source) ?? Date.now());
        this.files.delete(source);
        this.fileModifiedAtMs.delete(source);
      }
    }
    for (const match of command.matchAll(/rm -f (?:-- )?('[^']*'|\S+)/g)) {
      const filePath = unquote(match[1]!);
      this.files.delete(filePath);
      this.fileModifiedAtMs.delete(filePath);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async runBackground(command: string): Promise<E2BCommandHandle> {
    this.backgroundCalls += 1;
    const gate = this.nextCommandGate;
    const waitError = this.nextWaitError;
    this.nextCommandGate = undefined;
    this.nextWaitError = undefined;
    gate?.started.resolve();
    const stdoutPath = command.match(/\/tmp\/ai-tg-bot\/[a-f0-9-]+\/stdout/)?.[0];
    const stderrPath = command.match(/\/tmp\/ai-tg-bot\/[a-f0-9-]+\/stderr/)?.[0];
    if (stdoutPath) this.files.set(stdoutPath, Buffer.from("ok"));
    if (stderrPath) this.files.set(stderrPath, Buffer.alloc(0));
    return {
      pid: 123,
      wait: async () => {
        await gate?.release.promise;
        if (waitError) throw waitError;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      kill: async () => true,
    };
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    user = "root",
    _signal?: AbortSignal,
    requestTimeoutMs?: number,
  ): Promise<void> {
    this.writeFileCalls.push({ path: filePath, user, requestTimeoutMs });
    if (this.failIndexWrite && filePath.includes("/index-")) {
      throw new Error("index write failed");
    }
    this.files.set(filePath, Buffer.from(data));
    this.fileModifiedAtMs.set(filePath, Date.now());
  }

  async readFile(
    filePath: string,
    user = "user",
    _signal?: AbortSignal,
    requestTimeoutMs?: number,
  ): Promise<Uint8Array> {
    this.readFilePaths.push(filePath);
    this.readFileCalls.push({ path: filePath, user, requestTimeoutMs });
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error("not found");
    return bytes;
  }

  async readText(filePath: string, user = "user"): Promise<string> {
    return Buffer.from(await this.readFile(filePath, user)).toString("utf8");
  }

  async fileInfo(filePath: string, user = "user") {
    this.fileInfoCalls.push({ path: filePath, user });
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error("not found");
    return { type: "file", size: bytes.length } as never;
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }

  async removeFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  getHost(port: number): string {
    return `${port}-${this.id}.e2b.test`;
  }

  async getInfo() {
    return this.info();
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    this.timeoutAttempts += 1;
    if (this.nextSetTimeoutError) {
      const error = this.nextSetTimeoutError;
      this.nextSetTimeoutError = undefined;
      throw error;
    }
    this.timeoutCalls.push(timeoutMs);
  }

  async pause(): Promise<boolean> {
    this.pauseCalls += 1;
    if (this.nextPauseError) {
      const error = this.nextPauseError;
      this.nextPauseError = undefined;
      throw error;
    }
    this.running = false;
    return true;
  }
}

function unquote(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1) : value;
}
