import { randomUUID } from "node:crypto";
import path from "node:path";
import { TimeoutError } from "e2b";
import { throwIfAborted, raceWithAbort } from "../files/cancel.js";
import type { Logger } from "../logger.js";
import type { SandboxCommandRequest, SandboxCommandResult, SandboxThreadFileSyncResult } from "../sandbox/types.js";
import { quoteShellToken } from "../util/shell.js";
import { buildBoundedCommandCapture, commandOutputReadLimit } from "./commandCapture.js";
import { type E2BSandbox } from "./client.js";
import { E2B_RUNTIME_TMP, E2B_TELEGRAM_FILES, E2B_WORKSPACE } from "./paths.js";

export async function executeSandboxCommand(
  sandbox: E2BSandbox,
  request: SandboxCommandRequest,
  timeoutMs: number,
  threadFiles: SandboxThreadFileSyncResult,
  requestTimeoutMs: number,
  logger?: Logger,
): Promise<SandboxCommandResult> {
  throwIfAborted(request.signal);
  const runRoot = path.posix.join(E2B_RUNTIME_TMP, randomUUID());
  const stdinPath = path.posix.join(runRoot, "stdin");
  const stdoutPath = path.posix.join(runRoot, "stdout");
  const stderrPath = path.posix.join(runRoot, "stderr");
  await runControl(
    sandbox,
    `umask 077 && mkdir -p ${quoteShellToken(runRoot)} && chown user ${quoteShellToken(runRoot)} && chmod 700 ${quoteShellToken(runRoot)}`,
    requestTimeoutMs,
    request.signal,
  );
  await sandbox.writeFile(stdinPath, request.stdin, "user", request.signal);
  const command = buildBoundedCommandCapture({
    command: request.command,
    args: request.args,
    stdinPath,
    stdoutPath,
    stderrPath,
    maxOutputChars: request.maxOutputChars,
  });
  let exitCode: number | null = null;
  let timedOut = false;
  let errorText: string | undefined;
  try {
    const handle = await sandbox.runBackground(command, {
      cwd: request.workingDir,
      envs: {
        ...request.env,
        AGENT_WORKSPACE: E2B_WORKSPACE,
        TELEGRAM_FILES_DIR: E2B_TELEGRAM_FILES,
      },
      user: "user",
      timeoutMs,
      signal: request.signal,
    });
    try {
      throwIfAborted(request.signal);
      const result = await raceWithAbort(handle.wait(), request.signal);
      exitCode = result.exitCode;
      if (result.error) errorText = result.error;
    } catch (error) {
      if (request.signal?.aborted) {
        await handle.kill().catch(() => undefined);
        throw request.signal.reason ?? error;
      }
      const commandError = commandErrorResult(error);
      exitCode = commandError.exitCode;
      timedOut = commandError.timedOut;
      errorText = commandError.error;
    }
    const [stdoutBytes, stderrBytes] = await Promise.all([
      readIfExists(sandbox, stdoutPath, request.signal),
      readIfExists(sandbox, stderrPath, request.signal),
    ]);
    const stdout = truncateUtf8(stdoutBytes, request.maxOutputChars);
    const stderr = truncateUtf8(stderrBytes, request.maxOutputChars);
    const readLimit = commandOutputReadLimit(request.maxOutputChars);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      timedOut,
      stdoutTruncated: stdout.truncated || stdoutBytes.length >= readLimit,
      stderrTruncated: stderr.truncated || stderrBytes.length >= readLimit,
      threadFiles,
      ...(errorText ? { error: errorText } : {}),
    };
  } finally {
    await runControl(
      sandbox,
      `rm -rf -- ${quoteShellToken(runRoot)}`,
      requestTimeoutMs,
    ).catch((error) => {
      logger?.warn("failed to clean E2B command files", {
        sandboxId: sandbox.id,
        runRoot,
        error: String(error),
      });
    });
  }
}

export async function runControl(
  sandbox: E2BSandbox,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await runCommandResult(sandbox, command, timeoutMs, signal, "root");
}

export async function runCommandResult(
  sandbox: E2BSandbox,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  user = "root",
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await sandbox.run(command, { timeoutMs, signal, user });
    return result;
  } catch (error) {
    const result = commandErrorResult(error);
    throw new Error(result.error || `sandbox command failed with exit code ${String(result.exitCode)}`);
  }
}

async function readIfExists(sandbox: E2BSandbox, filePath: string, signal?: AbortSignal): Promise<Buffer> {
  if (!await sandbox.fileExists(filePath, "user", signal)) return Buffer.alloc(0);
  return Buffer.from(await sandbox.readFile(filePath, "user", signal));
}

function commandErrorResult(error: unknown): { exitCode: number | null; timedOut: boolean; error: string } {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  const message = String(record.error ?? record.message ?? error);
  return {
    exitCode,
    timedOut: error instanceof TimeoutError,
    error: message,
  };
}

function truncateUtf8(bytes: Buffer, maxChars: number): { text: string; truncated: boolean } {
  const text = bytes.toString("utf8");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
