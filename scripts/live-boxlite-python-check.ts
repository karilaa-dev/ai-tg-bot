import fs from "node:fs/promises";
import { createBoxClient } from "../src/boxlite/client.js";
import type { BoxClient, BoxHandle, BoxOutputStream } from "../src/boxlite/types.js";
import { boxCreateOptions } from "../src/boxlite/userRuntimeManager.js";
import { createLiveBoxliteConfig } from "./boxlite-live-config.js";

const IMAGE = "python:slim";
const MARKER = "BOXLITE_PYTHON_SMOKE_OK";
const USER_ID = 2_147_483_646;
const { config, tempRoot } = await createLiveBoxliteConfig("boxlite-python");
const boxName = `${config.BOXLITE_BOX_NAME_PREFIX}-python-slim-live-check`;
let client: BoxClient | undefined;
let box: BoxHandle | undefined;
let failure: Error | undefined;

try {
  client = await createBoxClient(config);

  const existing = await client.get(boxName);
  if (existing) await client.remove(boxName, true);

  const options = {
    ...boxCreateOptions(config, USER_ID),
    image: IMAGE,
    workingDir: "/",
    volumes: [],
    user: "root",
  };
  const created = await client.getOrCreate(options, boxName);
  box = created.box;
  if (!box.info().running) await box.start();

  const execution = await box.exec(
    "python3",
    ["-c", `import platform; print('${MARKER}', platform.python_version())`],
    [["TZ", "UTC"]],
    false,
    "root",
    30,
    "/",
  );
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
    throw new Error(`${IMAGE} smoke command failed with exit code ${result.exitCode}: ${details}`);
  }
  if (!stdout.startsWith(`${MARKER} `)) {
    throw new Error(`unexpected ${IMAGE} smoke output: ${stdout.trim()}`);
  }
  process.stdout.write(`${stdout.trim()}\n`);
  process.stdout.write(`BoxLite pulled, started, and executed the public ${IMAGE} image successfully.\n`);
} catch (error) {
  failure = boxliteError(error);
}

const cleanupErrors = await cleanup(client, box, boxName, tempRoot);
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    failure ? `${IMAGE} live check and cleanup both failed` : `${IMAGE} live check cleanup failed`,
  );
}
if (failure) throw failure;

async function cleanup(
  client: BoxClient | undefined,
  box: BoxHandle | undefined,
  name: string,
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
