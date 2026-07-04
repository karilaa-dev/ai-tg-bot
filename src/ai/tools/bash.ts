import path from "node:path";
import fs from "node:fs/promises";
import { Bash, ReadWriteFs } from "just-bash";
import { z } from "zod";
import { asRecord } from "../../util/records.js";
import { bashModelHint, normalizeBashCwd, truncateBashOutput } from "./helpers.js";
import { MAX_BASH_RESPONSE_BYTES, defineBotTool, type ToolBuildInput } from "./types.js";

export function createBashTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Run a bash script in this thread's persistent just-bash virtual workspace. The filesystem is isolated per Telegram thread. Use js-exec -c '...' for JavaScript, python3/python for local computation, and curl -fsSL for public raw URLs/APIs, optionally piped to jq. Do not use Python urllib/requests for web fetching; use curl for HTTPS/network data. If the user asks to search the internet/web/online or verify against online sources, include curl here or use web_search/web_extract before claiming online verification. For exact numeric verification, runtime comparisons, or constant-digit checks, prefer one simple bash call that computes all values, fetches any raw reference data, checks equality/lengths/counts, and emits compact JSON. Avoid command substitution $() and process substitution <(...); write js-exec/python3/curl outputs to temp files and compare/read those files. If part of a multi-step check fails, retry only the failed part and preserve already-successful values. Avoid node and unsupported shell setup such as set -o pipefail; node is only a help stub. Localhost/private network ranges are blocked.",
    inputSchema: z.object({
      script: z.string().min(1).max(20_000),
      cwd: z.string().regex(/^\//, "cwd must be an absolute virtual path").default("/"),
      stdin: z.string().max(100_000).default(""),
      args: z.array(z.string().max(4096)).max(32).default([]),
      raw_script: z.boolean().default(false),
    }),
    execute: async ({ script, cwd = "/", stdin = "", args = [], raw_script = false }) => {
      input.logger?.info("tool bash starting", {
        threadId: input.thread.id,
        scriptChars: script.length,
        stdinChars: stdin.length,
        args: args.length,
      });
      const result = await runBashTool(input, {
        script,
        cwd,
        stdin,
        args,
        rawScript: raw_script,
      });
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
  command: {
    script: string;
    cwd: string;
    stdin: string;
    args: string[];
    rawScript: boolean;
  },
): Promise<{
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cwd: string;
  error?: string;
}> {
  const root = path.resolve(input.config.BASH_WORKSPACE_ROOT, `thread-${input.thread.id}`);
  await fs.mkdir(root, { recursive: true });
  const cwd = normalizeBashCwd(command.cwd);
  const bash = new Bash({
    fs: new ReadWriteFs({ root, allowSymlinks: false }),
    cwd: "/",
    env: { TZ: "UTC" },
    python: true,
    javascript: true,
    network: {
      dangerouslyAllowFullInternetAccess: true,
      denyPrivateRanges: true,
      timeoutMs: input.config.BASH_TIMEOUT_MS,
      maxResponseSize: MAX_BASH_RESPONSE_BYTES,
    },
    defenseInDepth: true,
  });
  const controller = new AbortController();
  let timedOut = false;
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.config.BASH_TIMEOUT_MS);
  try {
    const result = await bash.exec(command.script, {
      args: command.args,
      cwd,
      env: { TZ: "UTC" },
      replaceEnv: true,
      rawScript: command.rawScript,
      signal: controller.signal,
      stdin: command.stdin,
    });
    const stdout = truncateBashOutput(result.stdout, input.config.BASH_MAX_OUTPUT_CHARS);
    const stderr = truncateBashOutput(result.stderr, input.config.BASH_MAX_OUTPUT_CHARS);
    const elapsedTimedOut = result.exitCode === 124 && Date.now() - startedAt >= input.config.BASH_TIMEOUT_MS;
    const didTimeOut = timedOut || elapsedTimedOut;
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exit_code: didTimeOut ? null : result.exitCode,
      timed_out: didTimeOut,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      cwd,
      ...(didTimeOut ? { error: `timed out after ${input.config.BASH_TIMEOUT_MS}ms` } : {}),
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: timedOut,
      stdout_truncated: false,
      stderr_truncated: false,
      cwd,
      error: timedOut ? `timed out after ${input.config.BASH_TIMEOUT_MS}ms` : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
