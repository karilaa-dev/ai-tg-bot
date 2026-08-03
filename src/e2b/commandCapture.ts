import { quoteShellToken, shellJoin } from "../util/shell.js";

const UTF8_MAX_BYTES_PER_CHAR = 4;

export function commandOutputReadLimit(maxOutputChars: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, maxOutputChars) * UTF8_MAX_BYTES_PER_CHAR + 4);
}

export function buildBoundedCommandCapture(input: {
  command: string;
  args: string[];
  stdinPath: string;
  stdoutPath: string;
  stderrPath: string;
  maxOutputChars: number;
}): string {
  const captureLimit = commandOutputReadLimit(input.maxOutputChars);
  const capture = (outputPath: string) => [
    `head -c ${captureLimit} > ${quoteShellToken(outputPath)}`,
    "head_status=$?",
    "cat > /dev/null",
    "drain_status=$?",
    "if [ \"$head_status\" -ne 0 ]; then exit \"$head_status\"; fi",
    "exit \"$drain_status\"",
  ].join("; ");
  const script = [
    "umask 077",
    `exec 3> >(${capture(input.stdoutPath)})`,
    "stdout_capture_pid=$!",
    `exec 4> >(${capture(input.stderrPath)})`,
    "stderr_capture_pid=$!",
    `${shellJoin([input.command, ...input.args])} < ${quoteShellToken(input.stdinPath)} >&3 2>&4 3>&- 4>&-`,
    "command_status=$?",
    "exec 3>&- 4>&-",
    "wait \"$stdout_capture_pid\"",
    "stdout_capture_status=$?",
    "wait \"$stderr_capture_pid\"",
    "stderr_capture_status=$?",
    "if [ \"$stdout_capture_status\" -ne 0 ]; then exit \"$stdout_capture_status\"; fi",
    "if [ \"$stderr_capture_status\" -ne 0 ]; then exit \"$stderr_capture_status\"; fi",
    "exit \"$command_status\"",
  ].join("; ");
  // Process substitution is Bash syntax. Invoke Bash explicitly so correctness
  // does not depend on whichever outer shell the E2B command API uses.
  return shellJoin(["bash", "-c", script]);
}
