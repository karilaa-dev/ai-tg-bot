import { vi } from "vitest";
import type {
  CommandRuntime,
  SandboxCommandRequest,
  SandboxFileReadRequest,
  SandboxFileWriteRequest,
} from "../../src/sandbox/types.js";
import { sandboxWorkspaceFile } from "../../src/e2b/paths.js";
import { sha256Hex } from "../../src/files/hash.js";

export const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGhoAAAAASUVORK5CYII=",
  "base64",
);
export function workspaceRuntime() {
  const files = new Map<string, Buffer>();
  let checks: Array<{ name: string; status: string; issues: string[] }> = [
    { name: "ooxml_package", status: "passed", issues: [] },
    { name: "actual_file_render", status: "passed", issues: [] },
    { name: "pptx_readability", status: "passed", issues: [] },
  ];
  const runtime = {
    files,
    setChecks(value: typeof checks) {
      checks = value;
    },
    put(path: string, bytes: Buffer) {
      files.set(sandboxWorkspaceFile(path), bytes);
    },
    materializeFiles: vi.fn(async () => ({
      directory: "/home/user/telegram-files",
      available: 0,
      files: [],
    })),
    writeWorkspaceFile: vi.fn(async (request: SandboxFileWriteRequest) => {
      request.signal?.throwIfAborted();
      files.set(
        sandboxWorkspaceFile(request.virtualPath),
        Buffer.from(request.bytes),
      );
    }),
    readWorkspaceFile: vi.fn(async (request: SandboxFileReadRequest) => {
      request.signal?.throwIfAborted();
      const canonicalPath = sandboxWorkspaceFile(request.virtualPath);
      const bytes =
        files.get(canonicalPath) ??
        (canonicalPath.endsWith(".jpg") ? TEST_PNG : undefined);
      if (!bytes) throw new Error("File not found: " + request.virtualPath);
      return {
        sandboxId: "sandbox-test",
        canonicalPath,
        sourceCanonicalPath: request.preserveSource
          ? "/home/user/.ai-tg-bot/file-sources/" + sha256Hex(bytes)
          : null,
        bytes,
        size: bytes.length,
        contentSha256: sha256Hex(bytes),
      };
    }),
    execute: vi.fn(async (request: SandboxCommandRequest) => {
      request.signal?.throwIfAborted();
      let stdout = "";
      if (
        request.command === "office-files" &&
        request.args[0] === "validate"
      ) {
        const bytes = files.get(request.args[1]!)!;
        stdout = JSON.stringify({
          source_sha256: sha256Hex(bytes),
          checks,
          page_count: 2,
          renderer: "LibreOffice",
          renderer_version: "LibreOffice test",
          pdf_path: request.args[2] + "/source.pdf",
          elapsed_ms: 20,
          peak_child_rss_kib: 123,
        });
      } else if (request.command === "magick")
        stdout = request.args[0] === "identify" ? "1 1" : "ImageMagick 7";
      else if (
        request.command === "bash" &&
        request.args[1]?.includes("magick identify")
      )
        stdout = "1 1 1";
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        threadFiles: {
          directory: "/home/user/telegram-files",
          available: 0,
          files: [],
        },
      };
    }),
    readSourceFile: vi.fn(async () => TEST_PNG),
    publishWebsite: vi.fn(async () => {
      throw new Error("not used");
    }),
    dispose: vi.fn(async () => {}),
  } satisfies CommandRuntime & Record<string, unknown>;
  return runtime;
}
