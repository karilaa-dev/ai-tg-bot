import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBoxClientProvider } from "../src/boxlite/client.js";
import { botSharedRoot } from "../src/boxlite/paths.js";
import type { BoxCommandResult } from "../src/boxlite/types.js";
import { UserBoxRuntimeManager } from "../src/boxlite/userRuntimeManager.js";
import { createLogger } from "../src/logger.js";
import { createLiveBoxliteConfig } from "./boxlite-live-config.js";

const USER_ID = 2_147_483_647;
const MARKER_FILE = ".boxlite-local-live-check";
const MARKER = "BOXLITE_LOCAL_WORKSPACE_OK";
const { config, tempRoot } = await createLiveBoxliteConfig("boxlite-live", {
  BOXLITE_IDLE_STOP_MS: "100",
});
const logger = createLogger(config);
const manager = new UserBoxRuntimeManager({
  config,
  clientProvider: createBoxClientProvider(config),
  logger,
});
let failure: Error | undefined;

try {
  const hostSharedRoot = botSharedRoot(config, USER_ID);
  const hostMarkerPath = path.join(hostSharedRoot, MARKER_FILE);
  await fs.mkdir(hostSharedRoot, { recursive: true });

  const writeResult = await execute(`printf '%s\\n' ${shellQuote(MARKER)} > ${shellQuote(MARKER_FILE)}`);
  assertSuccess(writeResult, "configured guest workspace write");
  await expectHostMarker(hostMarkerPath);

  const publicResult = await execute("curl -fsS --max-time 15 https://example.com >/dev/null");
  assertSuccess(publicResult, "public HTTPS");

  const deniedUrls = (process.env.BOXLITE_EGRESS_DENY_TEST_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const url of deniedUrls) {
    const result = await execute(`curl -ksS --max-time 5 -o /dev/null -- ${shellQuote(url)}`);
    if (result.exitCode === 0) {
      throw new Error(`deployment egress policy allowed a denied test URL: ${url}`);
    }
  }

  await delay(500);
  const restartResult = await execute(`test "$(cat ${shellQuote(MARKER_FILE)})" = ${shellQuote(MARKER)}`);
  assertSuccess(restartResult, "idle stop/restart workspace persistence");

  process.stdout.write(
    `BoxLite local runtime check passed with image ${config.BOXLITE_AGENT_IMAGE} as guest user ${config.BOXLITE_GUEST_USER}.\n`,
  );
  process.stdout.write("Configured guest workspace writes and idle stop/restart persistence passed.\n");
  if (deniedUrls.length > 0) {
    process.stdout.write(`Configured deny-list connectivity probes failed as expected (${deniedUrls.length} URLs).\n`);
  } else {
    process.stdout.write(
      "Private, local, and metadata egress was not tested. Set BOXLITE_EGRESS_DENY_TEST_URLS to deployment-specific URLs and verify the firewall separately.\n",
    );
  }
} catch (error) {
  failure = boxliteError(error);
}

const cleanupErrors: Error[] = [];
try {
  await manager.dispose();
} catch (error) {
  cleanupErrors.push(boxliteError(error));
}
try {
  await fs.rm(tempRoot, { recursive: true, force: true });
} catch (error) {
  cleanupErrors.push(boxliteError(error));
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    failure ? "BoxLite live check and cleanup both failed" : "BoxLite live check cleanup failed",
  );
}
if (failure) throw failure;

function execute(script: string): Promise<BoxCommandResult> {
  return manager.execute({
    userId: USER_ID,
    command: "bash",
    args: ["-c", script, "bash"],
    env: { TZ: "UTC" },
    stdin: "",
    workingDir: "/data/shared",
    timeoutMs: 20_000,
    maxOutputChars: 4000,
  });
}

function assertSuccess(result: BoxCommandResult, label: string): void {
  if (result.exitCode === 0) return;

  const detail = result.stderr || result.error || result.stdout;
  const flags = [
    result.timedOut ? "timed out" : undefined,
    result.stdoutTruncated ? "stdout truncated" : undefined,
    result.stderrTruncated ? "stderr truncated" : undefined,
  ].filter(Boolean);
  throw new Error(
    `${label} failed with exit code ${String(result.exitCode)}`
      + `${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`
      + `${detail ? `: ${detail}` : ""}`,
  );
}

async function expectHostMarker(markerPath: string): Promise<void> {
  const content = await fs.readFile(markerPath, "utf8");
  if (content !== `${MARKER}\n`) {
    throw new Error(`unexpected host workspace marker: ${JSON.stringify(content)}`);
  }
}

function boxliteError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
