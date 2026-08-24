import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMaterializeChatFilesTool } from "../../src/ai/tools/materializeChatFiles.js";
import { createRenderPdfPagesTool } from "../../src/ai/tools/renderPdfPages.js";
import { createSearchInFileTool } from "../../src/ai/tools/searchInFile.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../../src/db/types.js";
import { createLogger } from "../../src/logger.js";
import type { CommandRuntime, SandboxCommandResult } from "../../src/sandbox/types.js";
import { telegramFileSource } from "../../src/files/telegramSource.js";

describe("sandbox document tools", () => {
  let db: AppDatabase;
  let repos: Repos;
  let user: UserRow;
  let thread: ThreadRow;
  let pdf: FileRow;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config);
    await db.initialize();
    repos = createRepos(db.db, db.search);
    user = await repos.users.ensure({ tgId: 910, firstName: "PDF", lang: "en" });
    thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "file",
      content: { text: "PDF" },
      textPlain: "PDF",
    });
    pdf = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "pdf",
      mimeType: "application/pdf",
      extractionStatus: "source_only",
      name: "scan.pdf",
      size: 123,
      isInline: false,
    });
    await repos.files.rememberTelegramObservation(pdf.id, telegramFileSource({
      fileId: "telegram-pdf",
      fileUniqueId: "unique-pdf",
      mimeType: "application/pdf",
    }), {
      direction: "inbound",
      mediaKind: "document",
      telegramMessageId: 5,
      refs: [{ fileId: "telegram-pdf", fileUniqueId: "unique-pdf", size: 123, primary: true }],
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("materializes only requested scoped IDs and returns exact read-only paths", async () => {
    const runtime = fakeRuntime(pdf.id);
    const tool = createMaterializeChatFilesTool(buildInput(runtime));

    const result = await tool.execute({ file_ids: [pdf.id] });

    expect(runtime.materializeFiles).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ fileId: pdf.id, name: "scan.pdf" })],
    }));
    expect(result).toEqual({
      directory: "/home/user/telegram-files",
      files: [expect.objectContaining({
        file_id: pdf.id,
        path: `/home/user/telegram-files/${pdf.id}--scan.pdf`,
        status: "available",
      })],
    });
  });

  it("returns model-visible JPEG content for scanned PDF pages and removes temporary files", async () => {
    const runtime = fakeRuntime(pdf.id);
    const tool = createRenderPdfPagesTool(buildInput(runtime));

    const result = await tool.execute({ file_id: pdf.id, pages: [2, 1, 2] });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.pages.map((page) => page.page)).toEqual([2, 1]);
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.execute).mock.calls[0]?.[0]).toMatchObject({
      command: "bash",
      args: expect.arrayContaining([`/home/user/telegram-files/${pdf.id}--scan.pdf`]),
    });
    expect(vi.mocked(runtime.execute).mock.calls[1]?.[0]).toMatchObject({ command: "rm" });
    const model = await tool.toModelOutput?.({ toolCallId: "render", input: { file_id: pdf.id, pages: [2, 1] }, output: result });
    expect(model).toMatchObject({
      type: "content",
      value: expect.arrayContaining([expect.objectContaining({ type: "image-data", mediaType: "image/jpeg" })]),
    });
  });

  it("routes source-only PDF lexical search to the sandbox", async () => {
    const result = await createSearchInFileTool(buildInput(fakeRuntime(pdf.id))).execute({
      file_id: pdf.id,
      query: "needle",
      limit: 5,
    });
    expect(result).toMatchObject({ error: "sandbox_required", file_id: pdf.id });
  });

  function buildInput(commandRuntime: CommandRuntime) {
    return {
      config: loadTestConfig(),
      db,
      repos,
      user,
      thread,
      logger: createLogger(loadTestConfig()),
      commandRuntime,
    } as never;
  }
});

function fakeRuntime(fileId: number): CommandRuntime {
  const materializeFiles = vi.fn(async () => ({
    directory: "/home/user/telegram-files",
    available: 1,
    files: [{
      fileId,
      originalName: "scan.pdf",
      mimeType: "application/pdf",
      path: `/home/user/telegram-files/${fileId}--scan.pdf`,
      status: "available" as const,
    }],
  }));
  const execute = vi.fn(async () => commandResult());
  return {
    materializeFiles,
    execute,
    readWorkspaceFile: vi.fn(async (request) => ({
      sandboxId: "sandbox-1",
      canonicalPath: request.virtualPath,
      bytes: Buffer.from(`jpeg:${request.virtualPath}`),
      size: Buffer.byteLength(`jpeg:${request.virtualPath}`),
      contentSha256: "hash",
      sourceCanonicalPath: null,
    })),
    readSourceFile: vi.fn(async () => Buffer.alloc(0)),
    publishWebsite: vi.fn(async () => { throw new Error("not used"); }),
    dispose: vi.fn(async () => undefined),
  };
}

function commandResult(): SandboxCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    threadFiles: { directory: "/home/user/telegram-files", available: 1, files: [] },
  };
}
