import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBoundedCommandCapture } from "../../src/e2b/commandCapture.js";

const execFileAsync = promisify(execFile);

describe("E2B command capture", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-e2b-capture-"));
    await fs.writeFile(path.join(tempDir, "stdin"), "");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not wait for a redirected background server to exit", async () => {
    const command = buildBoundedCommandCapture({
      command: "bash",
      args: ["-c", "nohup sh -c 'sleep 2' > server.log 2>&1 & printf ready"],
      stdinPath: path.join(tempDir, "stdin"),
      stdoutPath: path.join(tempDir, "stdout"),
      stderrPath: path.join(tempDir, "stderr"),
      maxOutputChars: 100,
    });

    await execFileAsync("bash", ["-c", command], {
      cwd: tempDir,
      timeout: 1_000,
    });

    await expect(fs.readFile(path.join(tempDir, "stdout"), "utf8")).resolves.toBe("ready");
    await expect(fs.readFile(path.join(tempDir, "stderr"), "utf8")).resolves.toBe("");
  });
});
