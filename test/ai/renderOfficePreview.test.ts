import { describe, expect, it, vi } from "vitest";

import { createRenderOfficePreviewTool } from "../../src/ai/tools/renderOfficePreview.js";
import { loadTestConfig } from "../../src/config.js";
import type { CommandRuntime, SandboxCommandRequest, SandboxCommandResult } from "../../src/sandbox/types.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

describe("render_office_preview", () => {
  it("instructs the model to visually inspect every presentation slide", () => {
    const tool = createRenderOfficePreviewTool(buildInput(fakeRuntime("not used")));

    expect(tool.description).toContain("once for every slide");
    expect(tool.description).toContain("overlap, clipping, wrapping, contrast, spacing, and alignment");
  });

  it("renders sanitized OfficeCLI HTML as a model-only image and cleans up", async () => {
    const runtime = fakeRuntime("<!doctype html><html><body onload='steal()'><script>steal()</script><h1>Slide</h1></body></html>");
    const browserRuntime = fakeBrowserRuntime();
    const tool = createRenderOfficePreviewTool(buildInput(runtime, browserRuntime));

    const output = await tool.execute({ path: "/deck.pptx", page: 2 });
    const model = await tool.toModelOutput!({ toolCallId: "preview", input: { path: "/deck.pptx", page: 2 }, output });
    const details = await tool.toToolDetails!({ toolCallId: "preview", input: { path: "/deck.pptx", page: 2 }, output });

    expect(output).toMatchObject({ rendered: true, path: "/deck.pptx", page: 2, size: PNG.length });
    expect(browserRuntime.renderOfficeHtml).toHaveBeenCalledWith(
      expect.not.stringContaining("steal"),
      { selector: '.slide-container[data-slide="2"] .slide' },
      undefined,
    );
    expect(model).toMatchObject({ type: "content" });
    expect(details).not.toHaveProperty("image_base64");
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(runtime.execute.mock.calls[1]![0]).toMatchObject({ command: "rm" });
  });

  it("rejects unsupported files before using the sandbox", async () => {
    const runtime = fakeRuntime("not used");
    const tool = createRenderOfficePreviewTool(buildInput(runtime));
    await expect(tool.execute({ path: "/notes.txt", page: 1 })).resolves.toEqual({
      error: "Office preview path must end in .docx, .pptx, or .xlsx.",
    });
    expect(runtime.execute).not.toHaveBeenCalled();
  });
});

function buildInput(runtime: ReturnType<typeof fakeRuntime>, browserRuntime = fakeBrowserRuntime()) {
  return {
    config: loadTestConfig({
      BROWSER_USE_API_KEY: "secret",
    }),
    repos: {
      threads: { chain: async (thread: unknown) => [thread] },
      messages: { listIdsForScopes: async () => [] },
      files: {
        listForMessages: async () => [],
        listForThreads: async () => [],
        listRecoverableIds: async (fileIds: number[]) => fileIds,
        listByIds: async () => [],
        listTelegramFileRefs: async () => [],
      },
    },
    user: { tg_id: 9 },
    thread: { id: 10 },
    commandRuntime: runtime,
    browserRuntime,
  } as never;
}

function fakeBrowserRuntime() {
  return {
    renderOfficeHtml: vi.fn(async () => ({
      bytes: PNG,
      mediaType: "image/png",
      session_remaining_seconds: 240,
    })),
  };
}

function fakeRuntime(html: string) {
  return {
    materializeFiles: vi.fn(async () => ({ directory: "/home/user/telegram-files", available: 0, files: [] })),
    execute: vi.fn(async (_request: SandboxCommandRequest): Promise<SandboxCommandResult> => commandResult()),
    readWorkspaceFile: vi.fn(async () => ({
      sandboxId: "sandbox-1",
      canonicalPath: "/home/user/workspace/preview.html",
      sourceCanonicalPath: null,
      bytes: Buffer.from(html),
      size: Buffer.byteLength(html),
      contentSha256: "0".repeat(64),
    })),
    readSourceFile: vi.fn(async () => Buffer.alloc(0)),
    publishWebsite: vi.fn(async () => { throw new Error("not used"); }),
    dispose: vi.fn(async () => undefined),
  } satisfies CommandRuntime;
}

function commandResult(): SandboxCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    threadFiles: { directory: "/home/user/telegram-files", available: 0, files: [] },
  };
}
