import { z } from "zod";
import { sandboxWorkingDirectory } from "../../e2b/paths.js";
import type { SandboxThreadFileSyncResult } from "../../sandbox/types.js";
import { asRecord } from "../../util/records.js";
import { bashModelHint, normalizeBashCwd } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";
import { createInspectWorkspaceImagesTool, ImagePathsSchema, type InspectWorkspaceImagesResult } from "./inspectWorkspaceImages.js";
import { toolResultFailed } from "../../pi/toolOutcome.js";

type BashToolResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cwd: string;
  thread_files: SandboxThreadFileSyncResult;
  error?: string;
  inspection?: InspectWorkspaceImagesResult;
};

const EMPTY_THREAD_FILES: SandboxThreadFileSyncResult = {
  directory: "/home/user/telegram-files",
  available: 0,
  files: [],
};

export function createBashTool(input: ToolBuildInput) {
  const inspector = createInspectWorkspaceImagesTool(input);
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Run Bash in the persistent thread workspace. Logical cwd / maps to /home/user/workspace. Bind diagnostics to 127.0.0.1, requested published websites to 0.0.0.0. Optional inspect_images returns up to four workspace images after a successful command. If inspection fails, retry only inspect_workspace_images; command output is retained.",
    inputSchema: z.object({
      script: z.string().min(1).max(20_000),
      cwd: z.string().regex(/^\//, "cwd must be an absolute virtual path").default("/"),
      stdin: z.string().max(100_000).default(""),
      args: z.array(z.string().max(4096)).max(32).default([]),
      inspect_images: ImagePathsSchema.optional(),
    }),
    execute: async ({ script, cwd = "/", stdin = "", args = [], inspect_images }, signal) => {
      const logicalCwd = normalizeLogicalCwd(cwd);
      input.logger?.info("tool bash starting", {
        threadId: input.thread.id,
        scriptChars: script.length,
        stdinChars: stdin.length,
        args: args.length,
      });
      let result: BashToolResult;
      try {
        if (!input.commandRuntime) throw new Error("E2B command runtime is unavailable.");
        const executed = await input.commandRuntime.execute({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          command: "bash",
          args: ["-c", script, "bash", ...args],
          env: { TZ: "UTC" },
          stdin,
          workingDir: sandboxWorkingDirectory(logicalCwd),
          timeoutMs: input.config.BASH_TIMEOUT_MS,
          maxOutputChars: input.config.BASH_MAX_OUTPUT_CHARS,
          signal,
        });
        result = {
          stdout: executed.stdout,
          stderr: executed.stderr,
          exit_code: executed.exitCode,
          timed_out: executed.timedOut,
          stdout_truncated: executed.stdoutTruncated,
          stderr_truncated: executed.stderrTruncated,
          cwd: logicalCwd,
          thread_files: executed.threadFiles,
          ...(executed.error ? { error: executed.error } : {}),
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        result = {
          stdout: "",
          stderr: "",
          exit_code: null,
          timed_out: false,
          stdout_truncated: false,
          stderr_truncated: false,
          cwd: logicalCwd,
          thread_files: EMPTY_THREAD_FILES,
          error: String(error),
        };
      }
      if (inspect_images && !toolResultFailed(result)) {
        result.inspection = await inspector.execute({ paths: inspect_images }, signal);
        if ("error" in result.inspection) {
          result.error = `Command succeeded; image inspection failed: ${result.inspection.error}. Retry inspect_workspace_images only.`;
        }
      }
      input.logger?.info("tool bash complete", {
        threadId: input.thread.id,
        exitCode: result.exit_code,
        timedOut: result.timed_out,
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
        synchronizedFiles: result.thread_files.available,
        error: result.error,
      });
      return result;
    },
    toModelOutput: ({ input: toolInput, output }) => {
      const result = asRecord(output);
      if (!result) return { type: "json", value: output };
      const hint = bashModelHint(result, toolInput);
      const { inspection, ...command } = output;
      const summary = { ...command, ...(hint ? { model_hint: hint } : {}) };
      if (inspection && "images" in inspection) {
        return {
          type: "content",
          value: [
            { type: "text", text: JSON.stringify(summary) },
            { type: "text", text: `Inspected: ${inspection.images.map((image) => image.path).join(", ")}` },
            ...inspection.images.map((image) => ({ type: "image-data", data: image.image_base64, mediaType: image.media_type })),
          ],
        };
      }
      return {
        type: "json",
        value: summary,
      };
    },
    toToolDetails: ({ output }) => ({
      ...output,
      ...(output.inspection && "images" in output.inspection ? {
        inspection: { inspected: true, images: output.inspection.images.map(({ image_base64: _data, ...metadata }) => metadata) },
      } : {}),
    }),
  });
}

function normalizeLogicalCwd(value: string): string {
  const requested = normalizeBashCwd(value);
  return requested === normalizeBashCwd(process.cwd()) ? "/" : requested;
}
