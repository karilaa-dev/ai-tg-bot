import { createHash } from "node:crypto";
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
import { ThreadE2BSandboxRuntimeManager } from "../../src/e2b/threadRuntimeManager.js";
import type { SandboxCommandRequest, SandboxThreadFile } from "../../src/sandbox/types.js";
import { deferred } from "../helpers/async.js";

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
    expect(result.threadFiles).toEqual({ directory: E2B_TELEGRAM_FILES, available: 0 });
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
    lease.release();

    await vi.waitFor(() => {
      expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(E2B_WEBSITE_IDLE_PAUSE_MS);
    });
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
    followUpLease.release();
    await vi.waitFor(() => {
      expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(10 * 60_000);
    });

    now += 8 * 60_000;
    const lateFollowUpLease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    lateFollowUpLease.release();
    await vi.waitFor(() => {
      expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(E2B_IDLE_PAUSE_MS);
    });
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
    sandbox.files.set(workspacePath, Buffer.from("version two"));
    const second = await runtime.readWorkspaceFile({
      userId,
      threadId,
      virtualPath: "/report.txt",
      maxBytes: 100,
      preserveSource: true,
    });

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
    expect(sandbox.readFileCalls).toContainEqual({ path: first.sourceCanonicalPath, user: "root" });
  });

  it("reuses an outbound artifact locally and falls back to Telegram after sandbox loss", async () => {
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
    await runtime.execute(commandRequest(userId, threadId, [descriptor]));

    expect(client.telegramDownloadCalls).toBe(0);
    expect(original.files.get(`${E2B_TELEGRAM_FILES}/${stored.id}--outbound.txt`)).toEqual(bytes);

    await runtime.dispose();
    client.sandboxes.clear();
    runtime = createRuntime();
    await runtime.execute(commandRequest(userId, threadId, [descriptor]));

    expect(client.telegramDownloadCalls).toBe(1);
    expect(client.onlySandbox().files.get(`${E2B_TELEGRAM_FILES}/${stored.id}--outbound.txt`)).toEqual(bytes);
  });

  it("accepts a Telegram-reencoded outbound photo as best-effort recovery", async () => {
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

  function createRuntime(): ThreadE2BSandboxRuntimeManager {
    return new ThreadE2BSandboxRuntimeManager({
      config,
      repos,
      client,
      downloadTelegramBytes: async (fileId) => {
        client.telegramDownloadCalls += 1;
        const bytes = client.telegramFiles.get(fileId);
        if (!bytes) throw new Error("Telegram file unavailable");
        return bytes;
      },
    });
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

class FakeClient implements E2BClient {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly telegramFiles = new Map<string, Buffer>();
  telegramDownloadCalls = 0;
  createCalls = 0;
  connectCalls = 0;
  killCalls = 0;
  nextGetInfoError?: unknown;
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
    return [...this.sandboxes.values()]
      .filter((sandbox) => Object.entries(metadata).every(([key, value]) => sandbox.metadata[key] === value))
      .map((sandbox) => sandbox.info());
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
  readonly controlCommands: string[] = [];
  readonly timeoutCalls: number[] = [];
  startedAt = new Date();
  running = true;
  pauseCalls = 0;
  backgroundCalls = 0;
  inventoryCalls = 0;
  failSeal = false;
  failIndexWrite = false;
  failWebsiteScope = false;
  nextWaitError?: unknown;
  readonly readFilePaths: string[] = [];
  readonly readFileCalls: Array<{ path: string; user: string }> = [];
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
    for (const match of command.matchAll(/mv -f ('[^']*'|\S+) ('[^']*'|\S+)/g)) {
      const source = unquote(match[1]!);
      const destination = unquote(match[2]!);
      const bytes = this.files.get(source);
      if (bytes) {
        this.files.set(destination, bytes);
        this.files.delete(source);
      }
    }
    for (const match of command.matchAll(/rm -f ('[^']*'|\S+)/g)) {
      this.files.delete(unquote(match[1]!));
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

  async writeFile(filePath: string, data: string | Buffer | Uint8Array): Promise<void> {
    if (this.failIndexWrite && filePath.includes("/index-")) {
      throw new Error("index write failed");
    }
    this.files.set(filePath, Buffer.from(data));
  }

  async readFile(filePath: string, user = "user"): Promise<Uint8Array> {
    this.readFilePaths.push(filePath);
    this.readFileCalls.push({ path: filePath, user });
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
    this.timeoutCalls.push(timeoutMs);
  }

  async pause(): Promise<boolean> {
    this.pauseCalls += 1;
    this.running = false;
    return true;
  }
}

function unquote(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1) : value;
}
