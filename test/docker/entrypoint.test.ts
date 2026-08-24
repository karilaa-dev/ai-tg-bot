import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quoteShellToken } from "../../src/util/shell.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("docker/entrypoint.sh");
const applicationUid = "1000";
const applicationGid = "1000";

let tempDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-entrypoint-"));
  env = {
    ...process.env,
    AI_TG_BOT_ENTRYPOINT_TEST: "1",
    AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP: "1",
    APP_DATA_ROOT: path.join(tempDir, "app-data"),
    PI_CODING_AGENT_DIR: path.join(tempDir, "app-data", "pi"),
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
    await expect(fs.stat(env.PI_CODING_AGENT_DIR!)).resolves.toMatchObject({});
  });

  it("assigns a custom Pi directory to the application identity", async () => {
    const binDir = path.join(tempDir, "identity-bin");
    const chownLog = path.join(tempDir, "chown.args");
    const piDirectory = path.join(tempDir, "custom-pi");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "id"), [
      "#!/bin/sh",
      "if [ \"${1:-}\" = \"-u\" ]; then printf '0'; else exec /usr/bin/id \"$@\"; fi",
      "",
    ].join("\n"), { mode: 0o755 });
    await fs.writeFile(path.join(binDir, "chown"), [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > ${quoteShellToken(chownLog)}`,
      "",
    ].join("\n"), { mode: 0o755 });

    await runEntrypoint({
      ...env,
      PATH: `${binDir}:${env.PATH}`,
      PI_CODING_AGENT_DIR: piDirectory,
    });

    expect(await fs.readFile(chownLog, "utf8")).toBe([
      "-R",
      `${applicationUid}:${applicationGid}`,
      env.APP_DATA_ROOT,
      piDirectory,
      "",
    ].join("\n"));
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

  it("uses the normal bot command when no command is supplied", async () => {
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

  it("prepares persistent data and launches Node through a fixed, capability-free identity as root", async () => {
    const harness = await installRootHarness();

    await runEntrypointDefault({
      ...env,
      PATH: `${harness.binDir}:${env.PATH}`,
      AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP: "0",
    });

    await expect(fs.stat(env.APP_DATA_ROOT!)).resolves.toMatchObject({});
    await expect(fs.stat(env.PI_CODING_AGENT_DIR!)).resolves.toMatchObject({});
    expect(await fs.readFile(harness.chownLog, "utf8")).toBe([
      "-R",
      `${applicationUid}:${applicationGid}`,
      env.APP_DATA_ROOT,
      env.PI_CODING_AGENT_DIR,
      "",
    ].join("\n"));
    expect((await fs.readFile(harness.setprivLog, "utf8")).trim().split("\n")).toEqual([
      "--reuid",
      applicationUid,
      "--regid",
      applicationGid,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "--",
      "node",
      "dist/src/main.js",
    ]);
    expect(await fs.readFile(harness.nodeLog, "utf8")).toBe("dist/src/main.js\n");
  });

  it("ignores legacy APP_UID and APP_GID overrides", async () => {
    const harness = await installRootHarness();

    await runEntrypointDefault({
      ...env,
      PATH: `${harness.binDir}:${env.PATH}`,
      AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP: "0",
      APP_UID: "2345",
      APP_GID: "3456",
    });

    const chownArgs = await fs.readFile(harness.chownLog, "utf8");
    const setprivArgs = await fs.readFile(harness.setprivLog, "utf8");
    expect(chownArgs).toContain(`${applicationUid}:${applicationGid}`);
    expect(setprivArgs).toContain(`--reuid\n${applicationUid}\n`);
    expect(setprivArgs).toContain(`--regid\n${applicationGid}\n`);
    expect(`${chownArgs}\n${setprivArgs}`).not.toMatch(/2345|3456/);
  });
});

async function installRootHarness() {
  const binDir = path.join(tempDir, "root-bin");
  const chownLog = path.join(tempDir, "root-chown.args");
  const setprivLog = path.join(tempDir, "setpriv.args");
  const nodeLog = path.join(tempDir, "node.args");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "id"), [
    "#!/bin/sh",
    "if [ \"${1:-}\" = \"-u\" ]; then printf '0'; else exec /usr/bin/id \"$@\"; fi",
    "",
  ].join("\n"), { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "chown"), [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" > ${quoteShellToken(chownLog)}`,
    "",
  ].join("\n"), { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "setpriv"), [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" > ${quoteShellToken(setprivLog)}`,
    "while [ \"$1\" != \"--\" ]; do shift; done",
    "shift",
    "exec \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "node"), [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" > ${quoteShellToken(nodeLog)}`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { binDir, chownLog, setprivLog, nodeLog };
}

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
