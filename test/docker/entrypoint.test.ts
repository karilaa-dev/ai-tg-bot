import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quoteShellToken } from "../../src/util/shell.js";

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
    APP_GID: String(currentGid === 0 ? 1000 : currentGid),
    APP_DATA_ROOT: path.join(tempDir, "app-data"),
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
  });

  it("URL-encodes the PostgreSQL password when constructing DB_URL", async () => {
    const result = await runEntrypoint(
      { ...env, POSTGRES_PASSWORD: "complex:/?#[]@!$&'()*+,;=% password" },
      "printf '%s' \"$DB_URL\"",
    );

    expect(result.stdout).toBe(
      "postgres://aibot:complex%3A%2F%3F%23%5B%5D%40!%24%26'()*%2B%2C%3B%3D%25%20password@postgres:5432/aibot",
    );
  });

  it("preserves an explicit external DB_URL even when POSTGRES_PASSWORD is present", async () => {
    const external = "postgresql://dokploy:secret@dokploy-postgres:5432/aibot";
    const result = await runEntrypoint(
      { ...env, DB_URL: external, POSTGRES_PASSWORD: "compose-only" },
      "printf '%s' \"$DB_URL\"",
    );

    expect(result.stdout).toBe(external);
  });

  it.each([
    "sqlite:/app/data/bot.db",
    "sqlite:./data/bot.db",
  ])("replaces the legacy Compose SQLite URL %s", async (dbUrl) => {
    const result = await runEntrypoint(
      { ...env, DB_URL: dbUrl, POSTGRES_PASSWORD: "compose-password" },
      "printf '%s' \"$DB_URL\"",
    );

    expect(result.stdout).toBe("postgres://aibot:compose-password@postgres:5432/aibot");
  });

  it("keeps import mode idle without starting the bot", async () => {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "sleep"), [
      "#!/bin/sh",
      "printf '%s' \"$*\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = await runEntrypointDefault({
      ...env,
      PATH: `${binDir}:${env.PATH}`,
      UPGRADE_MODE: "import",
    });

    expect(result.stdout).toBe("infinity");
    expect(result.stderr).toContain("Telegram polling is disabled");
  });

  it("overrides the image's default bot command in import mode", async () => {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "sleep"), [
      "#!/bin/sh",
      "printf '%s' \"$*\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = await execFileAsync("/bin/sh", [entrypoint, "node", "dist/src/main.js"], {
      env: { ...env, PATH: `${binDir}:${env.PATH}`, UPGRADE_MODE: "import" },
    });

    expect(result.stdout).toBe("infinity");
    expect(result.stderr).toContain("Telegram polling is disabled");
  });

  it("uses the normal bot command when upgrade mode is unset", async () => {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "node"), [
      "#!/bin/sh",
      "printf '%s' \"$*\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = await runEntrypointDefault({ ...env, PATH: `${binDir}:${env.PATH}` });
    expect(result.stdout).toBe("dist/src/main.js");
  });

  it("allows an explicit migration command in import mode", async () => {
    const result = await runEntrypoint(
      { ...env, UPGRADE_MODE: "import" },
      "printf 'migration-command'",
    );
    expect(result.stdout).toBe("migration-command");
  });

  it("fails closed for an unknown upgrade mode", async () => {
    await expect(runEntrypoint({ ...env, UPGRADE_MODE: "typo" })).rejects.toMatchObject({
      stderr: expect.stringContaining("UPGRADE_MODE must be unset or 'import'"),
    });
  });

  it.skipIf((process.getuid?.() ?? 1) !== 0)(
    "drops identity and capabilities through setpriv when started as root",
    async () => {
      const binDir = path.join(tempDir, "bin");
      const setprivLog = path.join(tempDir, "setpriv.args");
      await fs.mkdir(binDir);
      await fs.writeFile(path.join(binDir, "setpriv"), [
        "#!/bin/sh",
        `printf '%s\\n' \"$@\" > ${quoteShellToken(setprivLog)}`,
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

function runEntrypoint(
  environment: NodeJS.ProcessEnv,
  command = "printf '{\"uid\":%s}' \"$(id -u)\"",
) {
  return execFileAsync("/bin/sh", [
    entrypoint,
    "/bin/sh",
    "-c",
    command,
  ], { env: environment });
}

function runEntrypointDefault(environment: NodeJS.ProcessEnv) {
  return execFileAsync("/bin/sh", [entrypoint], { env: environment });
}
