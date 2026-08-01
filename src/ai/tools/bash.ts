import { z } from "zod";
import { resolveThreadFileDescriptors } from "../../e2b/threadFiles.js";
import { sandboxWorkingDirectory } from "../../e2b/paths.js";
import type { SandboxThreadFileSyncResult } from "../../sandbox/types.js";
import { asRecord } from "../../util/records.js";
import { bashModelHint, normalizeBashCwd } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

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
};

const EMPTY_THREAD_FILES: SandboxThreadFileSyncResult = {
  directory: "/home/user/telegram-files",
  available: 0,
};

export function createBashTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Run Bash in this Telegram thread's persistent custom E2B Base toolbox. Logical cwd / is /home/user/workspace. Telegram attachments visible to this thread are restored automatically into /home/user/telegram-files, which is bot-managed and read-only; copy a file into the workspace before changing it. No storage is shared with other sandboxes. OfficeCLI, ImageMagick, ZIP utilities, Python, Node.js, Git, compilers, and common diagnostics are preinstalled; Chromium is intentionally absent because browser work uses Camofox. The bot does not install missing tools automatically. Files, processes, repositories, and user-requested package changes inside the sandbox persist across pause/resume.",
    inputSchema: z.object({
      script: z.string().min(1).max(20_000),
      cwd: z.string().regex(/^\//, "cwd must be an absolute virtual path").default("/"),
      stdin: z.string().max(100_000).default(""),
      args: z.array(z.string().max(4096)).max(32).default([]),
    }),
    execute: async ({ script, cwd = "/", stdin = "", args = [] }, signal) => {
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
        const threadFiles = await resolveThreadFileDescriptors(input, signal);
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
          threadFiles,
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
      const readOnlyReminder =
        "Telegram files are read-only in /home/user/telegram-files; copy them to /home/user/workspace before editing.";
      return {
        type: "json",
        value: {
          ...result,
          read_only_files_notice: readOnlyReminder,
          ...(hint ? { model_hint: hint } : {}),
        },
      };
    },
  });
}

function normalizeLogicalCwd(value: string): string {
  const requested = normalizeBashCwd(value);
  return requested === normalizeBashCwd(process.cwd()) ? "/" : requested;
}
