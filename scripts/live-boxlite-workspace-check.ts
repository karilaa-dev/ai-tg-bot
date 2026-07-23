import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createBoxClient } from "../src/boxlite/client.js";
import { botThreadWorkspace, guestThreadWorkspace } from "../src/boxlite/paths.js";
import type { BoxClient, BoxExecution, BoxHandle, BoxOutputStream } from "../src/boxlite/types.js";
import { boxCreateOptions } from "../src/boxlite/userRuntimeManager.js";
import { createLiveBoxliteConfig } from "./boxlite-live-config.js";

const IMAGE = "python:slim";
const MOUNT_MARKER = "BOXLITE_WORKSPACE_MOUNT_OK";
const CWD_MARKER = "BOXLITE_WORKSPACE_CWD_OK";
const USER_ID = 2_147_483_645;
const THREAD_ID = 2_147_483_645;
const MARKER_FILE = ".boxlite-workspace-live-check";

type PythonCheck = {
  label: string;
  workingDir: string;
  script: string;
  expectedMarker: string;
};

const { config, tempRoot } = await createLiveBoxliteConfig("boxlite-workspace");
const boxName = `${config.BOXLITE_BOX_NAME_PREFIX}-workspace-live-check-${randomUUID()}`;
const botWorkspace = botThreadWorkspace(config, USER_ID, THREAD_ID);
const guestWorkspace = guestThreadWorkspace(THREAD_ID);
const botMarkerPath = path.join(botWorkspace, MARKER_FILE);
let client: BoxClient | undefined;
let box: BoxHandle | undefined;
let failure: Error | undefined;

try {
  await fs.mkdir(botWorkspace, { recursive: true });
  await fs.rm(botMarkerPath, { force: true });

  client = await createBoxClient(config);
  const created = await client.getOrCreate(
    {
      ...boxCreateOptions(config, USER_ID),
      image: IMAGE,
      workingDir: "/",
      user: "root",
    },
    boxName,
  );
  box = created.box;
  if (!box.info().running) await box.start();

  await runPythonCheck(box, {
    label: "mount visibility check",
    workingDir: "/",
    script: [
      "import os",
      `workspace = ${JSON.stringify(guestWorkspace)}`,
      "assert os.path.isdir(workspace), f'workspace missing: {workspace}'",
      "assert os.access(workspace, os.W_OK), f'workspace not writable: {workspace}'",
      `print(${JSON.stringify(MOUNT_MARKER)})`,
    ].join("; "),
    expectedMarker: MOUNT_MARKER,
  });

  await runPythonCheck(box, {
    label: "OCI cwd check",
    workingDir: guestWorkspace,
    script: [
      "from pathlib import Path",
      `Path(${JSON.stringify(MARKER_FILE)}).write_text(${JSON.stringify(`${CWD_MARKER}\n`)}, encoding='utf-8')`,
      `print(${JSON.stringify(CWD_MARKER)})`,
    ].join("; "),
    expectedMarker: CWD_MARKER,
  });

  const hostMarker = await fs.readFile(botMarkerPath, "utf8");
  if (hostMarker !== `${CWD_MARKER}\n`) {
    throw new Error(`unexpected bot-host marker content: ${JSON.stringify(hostMarker)}`);
  }

  process.stdout.write(`${MOUNT_MARKER}\n${CWD_MARKER}\n`);
  process.stdout.write(
    `BoxLite mounted ${config.AGENT_SHARED_ROOT} at /data, executed from ${guestWorkspace}, and reflected the write to ${botWorkspace}.\n`,
  );
} catch (error) {
  failure = boxliteError(error);
}

const cleanupErrors = await cleanup(client, box, boxName, botMarkerPath, tempRoot);
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    failure ? `${IMAGE} workspace check and cleanup both failed` : `${IMAGE} workspace check cleanup failed`,
  );
}
if (failure) throw failure;

async function runPythonCheck(box: BoxHandle, check: PythonCheck): Promise<void> {
  let execution: BoxExecution;
  try {
    execution = await box.exec(
      "python3",
      ["-c", check.script],
      [["TZ", "UTC"]],
      false,
      "root",
      30,
      check.workingDir,
    );
  } catch (error) {
    throw new Error(`${check.label} could not start in ${check.workingDir}: ${errorMessage(error)}`);
  }

  const [stdin, stdoutStream, stderrStream] = await Promise.all([
    execution.stdin(),
    execution.stdout(),
    execution.stderr(),
  ]);
  await stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readOutput(stdoutStream),
    readOutput(stderrStream),
    execution.wait(),
  ]);
  if (result.exitCode !== 0) {
    const details = stderr || result.errorMessage || stdout;
    throw new Error(`${check.label} in ${check.workingDir} failed with exit code ${result.exitCode}: ${details}`);
  }
  if (stdout.trim() !== check.expectedMarker) {
    throw new Error(`${check.label} returned unexpected output in ${check.workingDir}: ${stdout.trim()}`);
  }
}

async function cleanup(
  client: BoxClient | undefined,
  box: BoxHandle | undefined,
  name: string,
  markerPath: string,
  home: string,
): Promise<Error[]> {
  const errors: Error[] = [];
  if (box) {
    try {
      await box.stop();
    } catch (error) {
      errors.push(boxliteError(error));
    }
  }
  if (client) {
    try {
      await client.remove(name, true);
    } catch (error) {
      errors.push(boxliteError(error));
    }
    try {
      await client.shutdown();
    } catch (error) {
      errors.push(boxliteError(error));
    }
  }
  try {
    await fs.rm(markerPath, { force: true });
  } catch (error) {
    errors.push(boxliteError(error));
  }
  try {
    await fs.rm(home, { recursive: true, force: true });
  } catch (error) {
    errors.push(boxliteError(error));
  }
  return errors;
}

async function readOutput(stream: BoxOutputStream): Promise<string> {
  let output = "";
  while (true) {
    const chunk = await stream.next();
    if (chunk === null) return output;
    output += chunk;
  }
}

function boxliteError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
