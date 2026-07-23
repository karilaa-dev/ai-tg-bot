import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  createOpenSandboxClient,
  createOpenSandboxClientProvider,
  type OpenSandboxClient,
  type OpenSandboxInfo,
} from "../src/opensandbox/client.js";
import { userSandboxMetadata } from "../src/opensandbox/spec.js";
import { UserOpenSandboxRuntimeManager } from "../src/opensandbox/userRuntimeManager.js";
import {
  botOutboxRoot,
  botSharedRoot,
  botThreadWorkspace,
  botUserRoot,
  guestThreadWorkspace,
} from "../src/sandbox/paths.js";
import type { SandboxCommandResult } from "../src/sandbox/types.js";

const USER_ID = 8_000_000_000_000_000 + randomInt(0, 1_000_000_000_000);
const THREAD_ID = 8_000_000_000 + randomInt(0, 1_000_000_000);
const RUN_ID = randomUUID();
const IDLE_PAUSE_MS = 2_000;
const STATE_WAIT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
const TIMEOUT_CHECK_MS = 1_200;

const baseConfig = loadConfig({
  ...process.env,
  BOT_TOKEN: "unused-by-opensandbox-live-check",
  OPENROUTER_API_KEY: "unused-by-opensandbox-live-check",
  TAVILY_API_KEY: "unused-by-opensandbox-live-check",
});
const config: AppConfig = {
  ...baseConfig,
  OPEN_SANDBOX_DEPLOYMENT_ID: `live-opensandbox-${process.pid}-${RUN_ID.slice(0, 12)}`,
  OPEN_SANDBOX_IDLE_PAUSE_MS: IDLE_PAUSE_MS,
};

const userRoot = botUserRoot(config, USER_ID);
const hostWorkspace = botThreadWorkspace(config, USER_ID, THREAD_ID);
const hostShared = botSharedRoot(config, USER_ID);
const guestWorkspace = guestThreadWorkspace(THREAD_ID);
const outboxRunRoot = path.join(botOutboxRoot(config), `live-opensandbox-${RUN_ID}`);
const exportDestination = path.join(outboxRunRoot, "exported.txt");
const hostInputPath = path.join(hostWorkspace, "host-visible.txt");
const guestOutputPath = path.join(hostWorkspace, "guest-visible.txt");
const hostSharedPath = path.join(hostShared, "host-shared.txt");
const guestSharedPath = path.join(hostShared, "guest-shared.txt");
const hostMarker = `HOST_TO_GUEST_${RUN_ID}`;
const guestMarker = `GUEST_TO_HOST_${RUN_ID}`;
const sharedHostMarker = `HOST_SHARED_${RUN_ID}`;
const sharedGuestMarker = `GUEST_SHARED_${RUN_ID}`;
const stdinMarker = `STDIN_${RUN_ID}`;
const envMarker = `ENV_${RUN_ID}`;
const exportMarker = `EXPORT_${RUN_ID}`;

let manager: UserOpenSandboxRuntimeManager | undefined;
let adminClient: OpenSandboxClient | undefined;
let failure: Error | undefined;
const knownSandboxIds = new Set<string>();
let sandboxId: string | undefined;
let publicHttps: { verified: boolean; detail?: string } = { verified: false };

try {
  await fs.mkdir(hostWorkspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(hostShared, { recursive: true, mode: 0o700 });
  await fs.mkdir(outboxRunRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(hostInputPath, `${hostMarker}\n`, { mode: 0o600 });
  await fs.writeFile(hostSharedPath, `${sharedHostMarker}\n`, { mode: 0o600 });

  adminClient = await createOpenSandboxClient(config);
  manager = createManager(config);

  const execution = await execute(manager, {
    script: [
      "set -euo pipefail",
      `test \"$(pwd)\" = ${shellQuote(guestWorkspace)}`,
      `test \"$LIVE_CHECK_ENV\" = ${shellQuote(envMarker)}`,
      "IFS= read -r live_stdin",
      `test \"$live_stdin\" = ${shellQuote(stdinMarker)}`,
      `test \"$(cat host-visible.txt)\" = ${shellQuote(hostMarker)}`,
      `test \"$(cat /data/shared/host-shared.txt)\" = ${shellQuote(sharedHostMarker)}`,
      `printf '%s\\n' ${shellQuote(guestMarker)} > guest-visible.txt`,
      `printf '%s\\n' ${shellQuote(sharedGuestMarker)} > /data/shared/guest-shared.txt`,
      "printf 'execution-ok\\n'",
    ].join("\n"),
    stdin: `${stdinMarker}\n`,
    env: { LIVE_CHECK_ENV: envMarker, TZ: "UTC" },
  });
  assertSuccess(execution, "command execution with stdin, environment, and cwd");
  assertEqual(execution.stdout, "execution-ok\n", "command stdout");
  await assertFile(guestOutputPath, `${guestMarker}\n`, "guest-to-host workspace visibility");
  await assertFile(guestSharedPath, `${sharedGuestMarker}\n`, "guest-to-host shared visibility");

  const initial = await waitForSingleSandbox(adminClient, config, "Running");
  sandboxId = initial.id;
  knownSandboxIds.add(initial.id);

  const httpsResult = await execute(manager, {
    script: "curl -fsS --max-time 15 https://example.com/ >/dev/null",
  });
  if (httpsResult.exitCode === 0) {
    publicHttps = { verified: true };
  } else {
    publicHttps = { verified: false, detail: resultDetail(httpsResult) };
  }

  const timed = await execute(manager, {
    script: "printf 'timeout-started\\n'; sleep 30",
    timeoutMs: TIMEOUT_CHECK_MS,
  });
  if (!timed.timedOut || timed.exitCode !== null) {
    throw new Error(`timeout interruption returned an unexpected result: ${JSON.stringify(timed)}`);
  }
  const afterTimeout = await execute(manager, { script: "printf 'reuse-after-timeout-ok\\n'" });
  assertSuccess(afterTimeout, "sandbox reuse after timeout interruption");
  assertEqual(afterTimeout.stdout, "reuse-after-timeout-ok\n", "post-timeout stdout");
  await assertSameSingleSandbox(adminClient, config, sandboxId, "post-timeout reuse");

  const exportWrite = await execute(manager, {
    script: `printf '%s\\n' ${shellQuote(exportMarker)} > exported.txt`,
  });
  assertSuccess(exportWrite, "export source creation");
  await manager.exportFile({
    userId: USER_ID,
    guestPath: `${guestWorkspace}/exported.txt`,
    hostDestination: exportDestination,
    maxBytes: 1024,
  });
  await assertFile(exportDestination, `${exportMarker}\n`, "safe regular-file export");
  await expectRejected(
    manager.exportFile({
      userId: USER_ID,
      guestPath: "/etc/passwd",
      hostDestination: path.join(outboxRunRoot, "unsafe-export"),
      maxBytes: 1024 * 1024,
    }),
    "outside /data export",
  );

  await waitForSandboxState(adminClient, sandboxId, "Paused", STATE_WAIT_MS);
  const afterIdlePause = await execute(manager, { script: "printf 'resume-after-idle-ok\\n'" });
  assertSuccess(afterIdlePause, "resume after idle pause");
  assertEqual(afterIdlePause.stdout, "resume-after-idle-ok\n", "post-idle-resume stdout");
  await assertSameSingleSandbox(adminClient, config, sandboxId, "idle pause/resume");

  const firstManager = manager;
  manager = undefined;
  await firstManager.dispose();
  await waitForSandboxState(adminClient, sandboxId, "Paused", STATE_WAIT_MS);

  manager = createManager(config);
  const adopted = await execute(manager, { script: "printf 'adopted-sandbox-ok\\n'" });
  assertSuccess(adopted, "manager recreation and sandbox adoption");
  assertEqual(adopted.stdout, "adopted-sandbox-ok\n", "adoption stdout");
  await assertSameSingleSandbox(adminClient, config, sandboxId, "manager recreation/adoption");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    deploymentId: config.OPEN_SANDBOX_DEPLOYMENT_ID,
    userId: USER_ID,
    threadId: THREAD_ID,
    sandboxId,
    image: config.OPEN_SANDBOX_IMAGE,
    publicHttps,
    checks: [
      "real command execution",
      "stdin, environment, and cwd",
      "bidirectional workspace and shared host visibility",
      "timeout interruption and reuse",
      "safe export and out-of-root rejection",
      "idle pause and resume",
      "manager disposal, recreation, adoption, and no duplicate sandbox",
    ],
  }, null, 2)}\n`);
} catch (error) {
  failure = toError(error);
}

const cleanupErrors: Error[] = [];
if (manager) {
  const current = manager;
  manager = undefined;
  try {
    await current.dispose();
  } catch (error) {
    cleanupErrors.push(toError(error));
  }
}
if (adminClient) {
  try {
    const infos = await adminClient.list(userSandboxMetadata(config, USER_ID));
    for (const info of infos) knownSandboxIds.add(info.id);
  } catch (error) {
    cleanupErrors.push(toError(error));
  }
  for (const id of knownSandboxIds) {
    try {
      await adminClient.kill(id);
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  }
  try {
    await adminClient.close();
  } catch (error) {
    cleanupErrors.push(toError(error));
  }
}
for (const cleanupPath of [userRoot, outboxRunRoot]) {
  try {
    await fs.rm(cleanupPath, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(toError(error));
  }
}

if (cleanupErrors.length > 0) {
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    failure ? "OpenSandbox live check and cleanup both failed" : "OpenSandbox live check cleanup failed",
  );
}
if (failure) throw failure;

function createManager(liveConfig: AppConfig): UserOpenSandboxRuntimeManager {
  return new UserOpenSandboxRuntimeManager({
    config: liveConfig,
    clientProvider: createOpenSandboxClientProvider(liveConfig),
  });
}

function execute(
  runtime: UserOpenSandboxRuntimeManager,
  input: {
    script: string;
    stdin?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<SandboxCommandResult> {
  return runtime.execute({
    userId: USER_ID,
    command: "bash",
    args: ["-c", input.script, "opensandbox-live-check"],
    env: input.env ?? { TZ: "UTC" },
    stdin: input.stdin ?? "",
    workingDir: guestWorkspace,
    timeoutMs: input.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxOutputChars: 8_000,
  });
}

async function waitForSingleSandbox(
  client: OpenSandboxClient,
  liveConfig: AppConfig,
  expectedState?: string,
): Promise<OpenSandboxInfo> {
  const deadline = Date.now() + STATE_WAIT_MS;
  let last: OpenSandboxInfo[] = [];
  while (Date.now() < deadline) {
    last = await client.list(userSandboxMetadata(liveConfig, USER_ID));
    if (last.length === 1 && (!expectedState || last[0]?.state === expectedState)) return last[0]!;
    await delay(250);
  }
  throw new Error(
    `expected one${expectedState ? ` ${expectedState}` : ""} managed sandbox, observed ${summarizeInfos(last)}`,
  );
}

async function assertSameSingleSandbox(
  client: OpenSandboxClient,
  liveConfig: AppConfig,
  expectedId: string,
  label: string,
): Promise<void> {
  const info = await waitForSingleSandbox(client, liveConfig, "Running");
  knownSandboxIds.add(info.id);
  if (info.id !== expectedId) {
    throw new Error(`${label} used sandbox ${info.id}, expected ${expectedId}`);
  }
}

async function waitForSandboxState(
  client: OpenSandboxClient,
  id: string,
  expectedState: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const info = await client.getInfo(id);
    lastState = info.state;
    if (lastState === expectedState) return;
    if (lastState === "Deleted" || lastState === "Error") break;
    await delay(250);
  }
  throw new Error(`sandbox ${id} did not reach ${expectedState}; last state was ${lastState}`);
}

function assertSuccess(result: SandboxCommandResult, label: string): void {
  if (result.exitCode === 0 && !result.timedOut && !result.error) return;
  throw new Error(`${label} failed: ${resultDetail(result)}`);
}

function resultDetail(result: SandboxCommandResult): string {
  const flags = [
    `exit=${String(result.exitCode)}`,
    result.timedOut ? "timed-out" : undefined,
    result.error ? `error=${result.error}` : undefined,
    result.stdoutTruncated ? "stdout-truncated" : undefined,
    result.stderrTruncated ? "stderr-truncated" : undefined,
  ].filter(Boolean);
  const output = result.stderr || result.stdout;
  return `${flags.join(", ")}${output ? `, output=${JSON.stringify(output)}` : ""}`;
}

async function assertFile(filePath: string, expected: string, label: string): Promise<void> {
  const actual = await fs.readFile(filePath, "utf8");
  assertEqual(actual, expected, label);
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function expectRejected(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

function summarizeInfos(infos: OpenSandboxInfo[]): string {
  if (infos.length === 0) return "none";
  return infos.map((info) => `${info.id}:${info.state}`).join(", ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
