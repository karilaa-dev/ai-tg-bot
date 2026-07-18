import path from "node:path";
import fs from "node:fs/promises";
import { Bash, InMemoryFs, MountableFs, ReadWriteFs } from "just-bash";
import { z } from "zod";
import { MAX_FILE_BYTES } from "../../files/limits.js";
import { threadChainScope } from "../../memory/retrieval.js";
import { asRecord } from "../../util/records.js";
import { bashModelHint, normalizeBashCwd, truncateBashOutput } from "./helpers.js";
import { MAX_BASH_RESPONSE_BYTES, defineBotTool, type ToolBuildInput } from "./types.js";

const MAX_BASH_INPUT_FILES = 5;

type MountedInputFile = {
  file_id: number;
  path: string;
  name: string;
  size: number;
};

export function createBashTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Run a bash script in this thread's persistent just-bash virtual workspace. The filesystem is isolated per chat thread. To process exact bytes from chat attachments, pass their numeric ids in input_file_ids; each file is mounted only for this call at /attachments/<file_id> and exposed as CHAT_FILE_<file_id>. Use js-exec -c '...' for JavaScript, python3/python for local computation, and curl -fsSL for public raw URLs/APIs, optionally piped to jq. Do not use Python urllib/requests for web fetching; use curl for HTTPS/network data. If the user asks to search the internet/web/online or verify against online sources, include curl here or use web_search/web_extract before claiming online verification. For exact numeric verification, runtime comparisons, or constant-digit checks, prefer one simple bash call that computes all values, fetches any raw reference data, checks equality/lengths/counts, and emits compact JSON. Avoid command substitution $() and process substitution <(...); write js-exec/python3/curl outputs to temp files and compare/read those files. If part of a multi-step check fails, retry only the failed part and preserve already-successful values. Avoid node and unsupported shell setup such as set -o pipefail; node is only a help stub. Localhost/private network ranges are blocked.",
    inputSchema: z.object({
      script: z.string().min(1).max(20_000),
      cwd: z.string().regex(/^\//, "cwd must be an absolute virtual path").default("/"),
      stdin: z.string().max(100_000).default(""),
      args: z.array(z.string().max(4096)).max(32).default([]),
      raw_script: z.boolean().default(false),
      input_file_ids: z.array(z.number().int().positive()).max(MAX_BASH_INPUT_FILES).default([]),
    }),
    execute: async ({ script, cwd = "/", stdin = "", args = [], raw_script = false, input_file_ids = [] }, signal) => {
      input.logger?.info("tool bash starting", {
        threadId: input.thread.id,
        scriptChars: script.length,
        stdinChars: stdin.length,
        args: args.length,
        inputFileIds: input_file_ids,
      });
      const result = await runBashTool(input, {
        script,
        cwd,
        stdin,
        args,
        rawScript: raw_script,
        inputFileIds: input_file_ids,
      }, signal);
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
    inputFileIds: number[];
  },
  externalSignal?: AbortSignal,
): Promise<{
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cwd: string;
  input_files: MountedInputFile[];
  error?: string;
}> {
  const root = path.resolve(input.config.BASH_WORKSPACE_ROOT, `thread-${input.thread.id}`);
  await fs.mkdir(root, { recursive: true });
  const cwd = normalizeBashCwd(command.cwd);
  const mounted = await mountChatFiles(input, root, command.inputFileIds, externalSignal);
  const env = {
    TZ: "UTC",
    ...Object.fromEntries(mounted.files.map((file) => [`CHAT_FILE_${file.file_id}`, file.path])),
  };
  const bash = new Bash({
    fs: mounted.fs,
    cwd: "/",
    env,
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
      env,
      replaceEnv: true,
      rawScript: command.rawScript,
      signal: externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal,
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
      input_files: mounted.files,
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
      input_files: mounted.files,
      error: timedOut ? `timed out after ${input.config.BASH_TIMEOUT_MS}ms` : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mountChatFiles(
  input: ToolBuildInput,
  root: string,
  requestedIds: number[],
  signal?: AbortSignal,
): Promise<{ fs: MountableFs; files: MountedInputFile[] }> {
  const ids = [...new Set(requestedIds)];
  const memory = new InMemoryFs();
  const files: MountedInputFile[] = [];
  if (ids.length) {
    if (!input.resolveFile) throw new Error("Chat attachment byte access is unavailable.");
    const scope = await threadChainScope(input.repos, input.thread);
    const allowedIds = new Set(scope.fileIds);
    const rows = await input.repos.files.listByIds(ids);
    const byId = new Map(rows.map((file) => [file.id, file]));
    for (const id of ids) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
      const file = byId.get(id);
      if (!file || !allowedIds.has(id)) throw new Error(`Input file #${id} is not available in this thread.`);
      const bytes = (await input.resolveFile(file, signal)).bytes;
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`Input file #${id} exceeds the file size limit.`);
      const virtualPath = `/attachments/${id}`;
      await memory.writeFile(`/${id}`, bytes);
      files.push({ file_id: id, path: virtualPath, name: file.name, size: bytes.length });
    }
  }
  return {
    fs: new MountableFs({
      base: new ReadWriteFs({ root, allowSymlinks: false }),
      mounts: [{ mountPoint: "/attachments", filesystem: memory }],
    }),
    files,
  };
}
