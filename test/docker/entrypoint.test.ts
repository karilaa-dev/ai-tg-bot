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
  const cgroupRoot = path.join(tempDir, "cgroup");
  const procRoot = path.join(tempDir, "proc");
  const procSys = path.join(procRoot, "sys");
  const procCgroupFile = path.join(procRoot, "self-cgroup");
  const kvmDevice = path.join(tempDir, "kvm");
  const appDataRoot = path.join(tempDir, "app-data");
  const sharedRoot = path.join(tempDir, "data");
  const boxliteHome = path.join(tempDir, "boxlite");

  await fs.mkdir(procSys, { recursive: true });
  await fs.mkdir(cgroupRoot, { recursive: true });
  await fs.writeFile(path.join(cgroupRoot, "cgroup.controllers"), "cpu memory pids\n");
  await fs.writeFile(path.join(cgroupRoot, "cgroup.procs"), "");
  await fs.writeFile(path.join(cgroupRoot, "cgroup.subtree_control"), "");
  await fs.writeFile(procCgroupFile, "0::/\n");
  await fs.writeFile(kvmDevice, "");
  await fs.chmod(kvmDevice, 0o666);

  const currentUid = process.getuid?.() ?? 1000;
  const currentGid = process.getgid?.() ?? 1000;
  env = {
    ...process.env,
    BOXLITE_ENTRYPOINT_TEST: "1",
    BOXLITE_TEST_CGROUP_ROOT: cgroupRoot,
    BOXLITE_TEST_PROC_CGROUP_FILE: procCgroupFile,
    BOXLITE_TEST_PROC_ROOT: procRoot,
    BOXLITE_TEST_PROC_SYS: procSys,
    BOXLITE_TEST_KVM_DEVICE: kvmDevice,
    BOXLITE_TEST_APP_DATA_ROOT: appDataRoot,
    BOXLITE_TEST_CURRENT_UID: "0",
    BOXLITE_TEST_SKIP_PRIVILEGE_DROP: "1",
    APP_UID: String(currentUid === 0 ? 1000 : currentUid),
    APP_GID: String(currentUid === 0 ? 1000 : currentGid),
    AGENT_SHARED_ROOT: sharedRoot,
    BOXLITE_HOME: boxliteHome,
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("container entrypoint", () => {
  it("delegates cgroups and launches the application when preflight succeeds", async () => {
    const result = await runEntrypoint(env);

    expect(JSON.parse(result.stdout)).toEqual({ reason: null });
    const cgroupRoot = env.BOXLITE_TEST_CGROUP_ROOT!;
    await expect(fs.readFile(path.join(cgroupRoot, "cgroup.subtree_control"), "utf8"))
      .resolves.toBe("+cpu +memory +pids\n");
    await expect(fs.readFile(path.join(cgroupRoot, "boxlite", "cgroup.subtree_control"), "utf8"))
      .resolves.toBe("+cpu +memory +pids\n");
    await expect(fs.readFile(path.join(cgroupRoot, "boxlite", "app", "cgroup.procs"), "utf8"))
      .resolves.toMatch(/^\d+\n$/);
    expect((await fs.stat(path.join(cgroupRoot, "boxlite"))).uid).toBe(Number(env.APP_UID));
    expect((await fs.stat(env.BOXLITE_HOME!)).isDirectory()).toBe(true);
  });

  it("keeps online-only startup available and exports a missing-KVM reason", async () => {
    await fs.rm(env.BOXLITE_TEST_KVM_DEVICE!);

    const result = await runEntrypoint(env);

    expect(JSON.parse(result.stdout)).toEqual({
      reason: expect.stringContaining("/dev/kvm is missing"),
    });
    expect(result.stderr).toContain("Online-only bot features will remain available");
  });

  it("keeps startup available when proc sys remains read-only", async () => {
    const result = await runEntrypoint({
      ...env,
      BOXLITE_TEST_PROC_SYS_VFS_OPTIONS: "ro,nosuid,nodev,noexec",
    });

    expect(JSON.parse(result.stdout)).toEqual({
      reason: expect.stringContaining("/proc/sys read-only"),
    });
  });

  it("drops identity and capabilities through setpriv", async () => {
    const binDir = path.join(tempDir, "bin");
    const setprivLog = path.join(tempDir, "setpriv.args");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "stat"), "#!/bin/sh\nprintf '42\\n'\n", { mode: 0o755 });
    await fs.writeFile(path.join(binDir, "setpriv"), [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > ${shellQuote(setprivLog)}`,
      "while [ \"$1\" != \"--\" ]; do shift; done",
      "shift",
      "exec \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = await runEntrypoint({
      ...env,
      PATH: `${binDir}:${env.PATH}`,
      BOXLITE_TEST_SKIP_PRIVILEGE_DROP: "0",
    });

    expect(JSON.parse(result.stdout)).toEqual({ reason: null });
    const args = await fs.readFile(setprivLog, "utf8");
    expect(args).toContain(`--reuid\n${env.APP_UID}\n`);
    expect(args).toContain(`--regid\n${env.APP_GID}\n`);
    expect(args).toContain("--groups\n42\n");
    expect(args).toContain("--bounding-set=-all\n");
    expect(args).toContain("--no-new-privs\n");
  });

  it("refuses to launch the bot as application UID zero", async () => {
    await expect(runEntrypoint({ ...env, APP_UID: "0" })).rejects.toMatchObject({
      stderr: expect.stringContaining("APP_UID must not be 0"),
    });
  });
});

async function runEntrypoint(environment: NodeJS.ProcessEnv) {
  return execFileAsync("/bin/sh", [
    entrypoint,
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify({ reason: process.env.BOXLITE_UNAVAILABLE_REASON ?? null }))",
  ], { env: environment });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
