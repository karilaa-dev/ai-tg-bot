import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("docker/entrypoint.sh");

let tempDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-entrypoint-"));
  const currentUid = process.getuid?.() ?? 1000;
  const currentGid = process.getgid?.() ?? 1000;
  env = {
    ...process.env,
    AI_TG_BOT_ENTRYPOINT_TEST: "1",
    AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP: "1",
    APP_UID: String(currentUid === 0 ? 1000 : currentUid),
    APP_GID: String(currentUid === 0 ? 1000 : currentGid),
    APP_DATA_ROOT: path.join(tempDir, "app-data"),
    AGENT_SHARED_ROOT: path.join(tempDir, "shared"),
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("container entrypoint", () => {
  it("prepares persistent directories and launches the application", async () => {
    const result = await runEntrypoint(env);

    expect(JSON.parse(result.stdout)).toEqual({ uid: process.getuid?.() });
    await expect(fs.stat(env.APP_DATA_ROOT!)).resolves.toMatchObject({});
    await expect(fs.stat(env.AGENT_SHARED_ROOT!)).resolves.toMatchObject({});
  });

  it.skipIf((process.getuid?.() ?? 1) !== 0)(
    "drops identity and capabilities through setpriv when started as root",
    async () => {
      const binDir = path.join(tempDir, "bin");
      const setprivLog = path.join(tempDir, "setpriv.args");
      await fs.mkdir(binDir);
      await fs.writeFile(path.join(binDir, "setpriv"), [
        "#!/bin/sh",
        `printf '%s\\n' \"$@\" > ${shellQuote(setprivLog)}`,
        "while [ \"$1\" != \"--\" ]; do shift; done",
        "shift",
        "exec \"$@\"",
        "",
      ].join("\n"), { mode: 0o755 });

      await runEntrypoint({
        ...env,
        PATH: `${binDir}:${env.PATH}`,
        AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP: "0",
      });

      const args = await fs.readFile(setprivLog, "utf8");
      expect(args).toContain(`--reuid\n${env.APP_UID}\n`);
      expect(args).toContain(`--regid\n${env.APP_GID}\n`);
      expect(args).toContain("--clear-groups\n");
      expect(args).toContain("--bounding-set=-all\n");
      expect(args).toContain("--no-new-privs\n");
    },
  );

  it("refuses to launch as application UID zero", async () => {
    await expect(runEntrypoint({ ...env, APP_UID: "0" })).rejects.toMatchObject({
      stderr: expect.stringContaining("APP_UID must not be 0"),
    });
  });

  it("refuses to launch with application GID zero", async () => {
    await expect(runEntrypoint({ ...env, APP_GID: "0" })).rejects.toMatchObject({
      stderr: expect.stringContaining("APP_GID must not be 0"),
    });
  });
});

function runEntrypoint(environment: NodeJS.ProcessEnv) {
  return execFileAsync("/bin/sh", [
    entrypoint,
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify({ uid: process.getuid?.() }))",
  ], { env: environment });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
