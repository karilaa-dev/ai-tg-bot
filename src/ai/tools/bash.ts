import fs from "node:fs/promises";
import { z } from "zod";
import { stageChatFiles, type StagedAttachments, type StagedInputFile } from "../../sandbox/attachments.js";
import { formatSandboxError } from "../../opensandbox/client.js";
import { promoteLegacyThreadWorkspace } from "../../sandbox/migrateData.js";
import { botSharedRoot, botThreadWorkspace, guestCwd } from "../../sandbox/paths.js";
import { asRecord } from "../../util/records.js";
import { bashModelHint, normalizeBashCwd } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const MAX_BASH_INPUT_FILES = 5;

type BashCommand = {
  script: string;
  cwd: string;
  stdin: string;
  args: string[];
  inputFileIds: number[];
};

type BashToolResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cwd: string;
  input_files: StagedInputFile[];
  error?: string;
};

export function createBashTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Run a real Bash script in this user's persistent OpenSandbox environment. Omit cwd and use relative paths for normal work. Logical cwd / means this thread's workspace, not the Linux filesystem root; this mapping is expected and does not need investigation. Inside commands the physical workspace may appear under /data/threads/<thread-id>/workspace. Never pass the bot host path or probe /home/agent or /workspace to locate files. Use /data/shared only for files intentionally shared with the user's other threads. Python, Node.js, zip, git, curl, jq, SQLite, and common Linux tools are available in the configured runner image. Chat attachments are not mounted automatically: pass up to five authorized file ids in input_file_ids to stage immutable copies for this call at the returned paths and through CHAT_FILE_<id>. The sandbox starts lazily and pauses after its idle timeout; /data and the container state persist until the sandbox is replaced. Outbound networking depends on the deployment's firewall policy and must not be treated as a private-network security boundary.",
    inputSchema: z.object({
      script: z.string().min(1).max(20_000),
      cwd: z.string().regex(/^\//, "cwd must be an absolute virtual path").default("/"),
      stdin: z.string().max(100_000).default(""),
      args: z.array(z.string().max(4096)).max(32).default([]),
      raw_script: z.boolean().default(false),
      input_file_ids: z.array(z.number().int().positive()).max(MAX_BASH_INPUT_FILES).default([]),
    }),
    execute: async ({ script, cwd = "/", stdin = "", args = [], input_file_ids = [] }, signal) => {
      input.logger?.info("tool bash starting", {
        threadId: input.thread.id,
        scriptChars: script.length,
        stdinChars: stdin.length,
        args: args.length,
        inputFileIds: input_file_ids,
      });
      const result = await runBashTool(input, { script, cwd, stdin, args, inputFileIds: input_file_ids }, signal);
      input.logger?.info("tool bash complete", {
        threadId: input.thread.id,
        exitCode: result.exit_code,
        timedOut: result.timed_out,
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
        error: result.error,
      });
      return result;
    },
    toModelOutput: ({ input, output }) => {
      const result = asRecord(output);
      if (!result) return { type: "json", value: output };
      const hint = bashModelHint(result, input);
      return { type: "json", value: hint ? { ...result, model_hint: hint } : result };
    },
  });
}

async function runBashTool(
  input: ToolBuildInput,
  command: BashCommand,
  signal?: AbortSignal,
): Promise<BashToolResult> {
  const { config, thread, user } = input;
  const requestedCwd = normalizeBashCwd(command.cwd);
  const logicalCwd = requestedCwd === normalizeBashCwd(process.cwd()) ? "/" : requestedCwd;
  const workingDir = guestCwd(thread.id, logicalCwd);
  let stagedFiles: StagedAttachments = {
    files: [],
    env: {},
    async cleanup() {},
  };
  let cleanupError: string | undefined;
  let toolResult: BashToolResult;
  try {
    if (!input.commandRuntime) throw new Error("OpenSandbox command runtime is unavailable.");
    const result = await input.commandRuntime.execute({
      userId: user.tg_id,
      command: "bash",
      args: ["-c", command.script, "bash", ...command.args],
      env: { TZ: "UTC" },
      stdin: command.stdin,
      workingDir,
      timeoutMs: config.BASH_TIMEOUT_MS,
      maxOutputChars: config.BASH_MAX_OUTPUT_CHARS,
      signal,
    }, {
      async beforeExecute() {
        await promoteLegacyThreadWorkspace(config, user.tg_id, thread.id);
        await Promise.all([
          fs.mkdir(botThreadWorkspace(config, user.tg_id, thread.id), { recursive: true }),
          fs.mkdir(botSharedRoot(config, user.tg_id), { recursive: true }),
        ]);
        stagedFiles = await stageChatFiles(input, command.inputFileIds, signal);
        return { env: stagedFiles.env };
      },
      async afterExecute() {
        try {
          await stagedFiles.cleanup();
        } catch (error) {
          cleanupError = formatSandboxError(error);
          input.logger?.warn("sandbox attachment cleanup failed", {
            threadId: thread.id,
            error: cleanupError,
          });
        }
      },
    });
    toolResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      cwd: logicalCwd,
      input_files: stagedFiles.files,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    toolResult = {
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
      cwd: logicalCwd,
      input_files: stagedFiles.files,
      error: formatSandboxError(error),
    };
  }

  if (cleanupError) {
    toolResult = {
      ...toolResult,
      error: [toolResult.error, `attachment cleanup failed: ${cleanupError}`].filter(Boolean).join("; "),
    };
  }
  return toolResult;
}
