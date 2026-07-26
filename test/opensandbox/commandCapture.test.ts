import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBoundedCommandCapture,
  commandOutputReadLimit,
} from "../../src/opensandbox/commandCapture.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe("bounded OpenSandbox command capture", () => {
  it("bounds both streams without terminating a noisy command", async () => {
    const files = await captureFiles();
    const maxOutputChars = 5;
    const command = buildBoundedCommandCapture({
      command: "bash",
      args: ["-c", "printf '%050d' 0; printf '%050d' 1 >&2; exit 23"],
      ...files,
      maxOutputChars,
    });

    await expect(execFileAsync("/bin/sh", ["-c", command])).rejects.toMatchObject({ code: 23 });

    const captureLimit = commandOutputReadLimit(maxOutputChars) - 1;
    const [stdout, stderr] = await Promise.all([
      fs.readFile(files.stdoutPath, "utf8"),
      fs.readFile(files.stderrPath, "utf8"),
    ]);
    expect(stdout).toBe("0".repeat(captureLimit));
    expect(stderr).toBe(`${"0".repeat(49)}1`.slice(0, captureLimit));
    await expect(fs.stat(files.stdoutPath)).resolves.toMatchObject({ size: captureLimit });
    await expect(fs.stat(files.stderrPath)).resolves.toMatchObject({ size: captureLimit });
  });

  it("preserves short output and quoted file paths exactly", async () => {
    const files = await captureFiles("capture files with spaces");
    const command = buildBoundedCommandCapture({
      command: "bash",
      args: ["-c", "printf 'no-newline'; printf 'warning!' >&2"],
      ...files,
      maxOutputChars: 100,
    });

    await execFileAsync("/bin/sh", ["-c", command]);

    await expect(fs.readFile(files.stdoutPath, "utf8")).resolves.toBe("no-newline");
    await expect(fs.readFile(files.stderrPath, "utf8")).resolves.toBe("warning!");
  });

  it("reports a capture failure instead of masking it with the drain", async () => {
    const files = await captureFiles();
    const command = buildBoundedCommandCapture({
      command: "bash",
      args: ["-c", "printf output"],
      ...files,
      stdoutPath: path.dirname(files.stdoutPath),
      maxOutputChars: 10,
    });

    await expect(execFileAsync("/bin/sh", ["-c", command])).rejects.toMatchObject({
      code: expect.any(Number),
    });
  });

  it("creates empty files for silent streams", async () => {
    const files = await captureFiles();
    const command = buildBoundedCommandCapture({
      command: "bash",
      args: ["-c", "true"],
      ...files,
      maxOutputChars: 10,
    });

    await execFileAsync("/bin/sh", ["-c", command]);

    await expect(fs.readFile(files.stdoutPath)).resolves.toHaveLength(0);
    await expect(fs.readFile(files.stderrPath)).resolves.toHaveLength(0);
  });
});

async function captureFiles(suffix = "capture"): Promise<{
  stdinPath: string;
  stdoutPath: string;
  stderrPath: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "command-capture-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, suffix);
  await fs.mkdir(root, { recursive: true });
  const stdinPath = path.join(root, "stdin");
  await fs.writeFile(stdinPath, "");
  return {
    stdinPath,
    stdoutPath: path.join(root, "stdout"),
    stderrPath: path.join(root, "stderr"),
  };
}
