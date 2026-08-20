import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = path.resolve("docker/import-migration.sh");

let tempDir: string;
let environment: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-import-wrapper-"));
  const binDir = path.join(tempDir, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "npm"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$PWD\" \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  const currentUid = process.getuid?.() ?? 1000;
  const currentGid = process.getgid?.() ?? 1000;
  environment = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    UPGRADE_MODE: "import",
    AI_TG_BOT_ENTRYPOINT_TEST: "1",
    AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP: "1",
    APP_UID: String(currentUid === 0 ? 1000 : currentUid),
    APP_GID: String(currentGid === 0 ? 1000 : currentGid),
    APP_DATA_ROOT: path.join(tempDir, "app-data"),
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Dokploy migration import wrapper", () => {
  it("runs the existing importer through the non-root entrypoint", async () => {
    const result = await execFileAsync("/bin/sh", [wrapper], { env: environment });

    expect(result.stdout.trim().split("\n")).toEqual([
      path.resolve("."),
      "run",
      "upgrade:migrate",
      "--",
      "--from",
      "/app/data/import",
    ]);
    expect(result.stderr).not.toContain("bot started");
  });

  it("accepts no arguments", async () => {
    await expect(execFileAsync("/bin/sh", [wrapper, "extra"], { env: environment }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("Usage:") });
  });

  it("requires import mode", async () => {
    await expect(execFileAsync("/bin/sh", [wrapper], {
      env: { ...environment, UPGRADE_MODE: "" },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("requires UPGRADE_MODE=import"),
    });
  });
});
