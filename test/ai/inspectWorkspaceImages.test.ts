import { describe, expect, it, vi } from "vitest";
import { createInspectWorkspaceImagesTool } from "../../src/ai/tools/inspectWorkspaceImages.js";
import { createBashTool } from "../../src/ai/tools/bash.js";
import { loadTestConfig } from "../../src/config.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import type { CommandRuntime, SandboxCommandRequest, SandboxCommandResult } from "../../src/sandbox/types.js";

const JPEG = Buffer.from([255, 216, 255, 224, 0]);

describe("inspect_workspace_images", () => {
  it("returns command output and images in one call, keeping base64 out of details", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.execute).mockResolvedValueOnce(commandResult("built successfully"));
    const bash = createPiToolAdapters({ buildInput: () => buildInput(runtime) }).find((tool) => tool.name === "bash")!;
    const result = await bash.execute("build", { script: "build", inspect_images: ["/preview.png", "/detail.png"] }, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("built successfully") });
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(2);
    expect(JSON.stringify(result.details)).not.toContain(JPEG.toString("base64"));
  });

  it("retains a successful command after inspection failure and permits inspection-only repair", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.execute)
      .mockResolvedValueOnce(commandResult("artifact built"))
      .mockResolvedValueOnce({ ...commandResult(""), exitCode: 2, stderr: "missing preview" });
    const tool = createBashTool(buildInput(runtime));
    const output = await tool.execute({ script: "build", cwd: "/", stdin: "", args: [], inspect_images: ["/preview.png"] });
    expect(output).toMatchObject({ stdout: "artifact built", exit_code: 0, error: expect.stringContaining("Retry inspect_workspace_images only") });
    const repaired = await createInspectWorkspaceImagesTool(buildInput(runtime)).execute({ paths: ["/preview.png", "/detail.png"] });
    expect(repaired).toMatchObject({ inspected: true });
    expect(vi.mocked(runtime.execute).mock.calls.filter(([request]) => request.args?.includes("build"))).toHaveLength(1);
  });

  it("skips image inspection after nonzero exit or timeout and validates the shared path limit", async () => {
    for (const failure of [{ exitCode: 7 }, { timedOut: true }]) {
      const runtime = fakeRuntime();
      vi.mocked(runtime.execute).mockResolvedValueOnce({ ...commandResult("partial"), ...failure });
      const tool = createBashTool(buildInput(runtime));
      await tool.execute({ script: "build", cwd: "/", stdin: "", args: [], inspect_images: ["/preview.png"] });
      expect(runtime.execute).toHaveBeenCalledTimes(1);
      expect(runtime.readWorkspaceFile).not.toHaveBeenCalled();
      expect(tool.inputSchema.safeParse({ script: "build", inspect_images: Array(5).fill("/p.png") }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ script: "build", inspect_images: ["/p.png", "/home/user/workspace/p.png"] }).success).toBe(false);
    }
  });

  it("returns normalized workspace images to the model and removes its previews", async () => {
    const runtime = fakeRuntime();
    const tool = createInspectWorkspaceImagesTool(buildInput(runtime));

    const output = await tool.execute({ paths: ["/collage.jpg", "/detail.png"] });
    const model = await tool.toModelOutput!({
      toolCallId: "inspect",
      input: { paths: ["/collage.jpg", "/detail.png"] },
      output,
    });
    const details = await tool.toToolDetails!({
      toolCallId: "inspect",
      input: { paths: ["/collage.jpg", "/detail.png"] },
      output,
    });

    expect(output).toMatchObject({
      inspected: true,
      images: [
        { path: "/collage.jpg", media_type: "image/jpeg", width: 1600, height: 1200 },
        { path: "/detail.png", media_type: "image/jpeg", width: 900, height: 1400 },
      ],
    });
    expect(model).toMatchObject({
      type: "content",
      value: [
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image-data", mediaType: "image/jpeg" }),
        expect.objectContaining({ type: "image-data", mediaType: "image/jpeg" }),
      ],
    });
    expect(details).not.toHaveProperty("image_base64");
    expect(JSON.stringify(details)).not.toContain(JPEG.toString("base64"));
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.execute).mock.calls[0]?.[0]).toMatchObject({
      command: "bash",
      args: expect.arrayContaining([
        "/home/user/workspace/collage.jpg",
        "/home/user/workspace/detail.png",
      ]),
    });
    expect(vi.mocked(runtime.execute).mock.calls[1]?.[0]).toMatchObject({ command: "rm" });
    expect(runtime.readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it("limits one visual inspection call to four unique paths", () => {
    const tool = createInspectWorkspaceImagesTool(buildInput(fakeRuntime()));

    expect(tool.inputSchema.safeParse({
      paths: ["/1.png", "/2.png", "/3.png", "/4.png", "/5.png"],
    }).success).toBe(false);
    expect(tool.inputSchema.safeParse({
      paths: ["/same.png", "/home/user/workspace/same.png"],
    }).success).toBe(false);
  });

  it("describes mandatory final-image QA and model-only delivery", () => {
    const tool = createInspectWorkspaceImagesTool(buildInput(fakeRuntime()));

    expect(tool.description).toContain("final collage");
    expect(tool.description).toContain("model-only");
    expect(tool.description).toContain("before create_file");
  });

  it("exposes each preview as Pi vision content without persisting image bytes in details", async () => {
    const commandRuntime = fakeRuntime();
    const inspect = createPiToolAdapters({
      buildInput: () => buildInput(commandRuntime),
    }).find((tool) => tool.name === "inspect_workspace_images")!;

    const result = await inspect.execute(
      "inspect",
      { paths: ["/collage.jpg", "/detail.png"] },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
      expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
    ]);
    expect(JSON.stringify(result.details)).not.toContain(JPEG.toString("base64"));
  });
});

function buildInput(commandRuntime: CommandRuntime) {
  return {
    config: loadTestConfig(),
    repos: {},
    user: { tg_id: 9 },
    thread: { id: 10 },
    commandRuntime,
  } as never;
}

function fakeRuntime(): CommandRuntime {
  return {
    materializeFiles: vi.fn(async () => ({ directory: "/home/user/telegram-files", available: 0, files: [] })),
    execute: vi.fn(async (request: SandboxCommandRequest) => commandResult(
      request.command === "bash" ? "1 1600 1200\n2 900 1400\n" : "",
    )),
    readWorkspaceFile: vi.fn(async (request) => ({
      sandboxId: "sandbox-1",
      canonicalPath: request.virtualPath,
      sourceCanonicalPath: null,
      bytes: JPEG,
      size: JPEG.length,
      contentSha256: "hash",
    })),
    readSourceFile: vi.fn(async () => Buffer.alloc(0)),
    publishWebsite: vi.fn(async () => { throw new Error("not used"); }),
    dispose: vi.fn(async () => undefined),
  };
}

function commandResult(stdout: string): SandboxCommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    threadFiles: { directory: "/home/user/telegram-files", available: 0, files: [] },
  };
}
