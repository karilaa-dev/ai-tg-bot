import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SandboxThreadFile } from "../sandbox/types.js";
import { shellJoin } from "../util/shell.js";
import type { E2BSandbox } from "./client.js";
import { E2B_CONTROL_TMP, E2B_WORKSPACE } from "./paths.js";
import { sha256Hex } from "../files/hash.js";
import { runCommandResult } from "./sandboxCommandExecutor.js";

export const CODEX_EXECUTOR_VERSION = "0.159.2";
export const CODEX_EXECUTOR_PORT = 8765;
const EXECUTOR_ROOT = "/home/user/.ai-tg-codex-executor";
const EXECUTOR_WRAPPER = "/usr/local/bin/ai-tg-codex-executor";

export interface RemoteExecutorEndpoint {
  sandboxId: string;
  url: string;
  authBearerToken: string;
}

export interface PrepareRemoteExecutorRequest {
  userId: number;
  threadId: number;
  files: SandboxThreadFile[];
  artifacts?: Array<{ path: string; bytes: Buffer }>;
  artifactRoot?: string;
  /** False after native work has started in the current turn. */
  allowRotation?: boolean;
  signal?: AbortSignal;
  onExecutorReady(endpoint: RemoteExecutorEndpoint): Promise<void>;
}

let wrapper: Promise<string> | undefined;
function executorWrapper(): Promise<string> {
  return wrapper ??= fs.readFile(fileURLToPath(new URL("../../e2b-template/assets/ai-tg-codex-executor", import.meta.url)), "utf8");
}

/** Upgrade an existing paused v2 image in place so its workspace is preserved. */
export async function prepareNativeExecutor(
  sandbox: E2BSandbox,
  requestTimeoutMs: number,
  previous?: RemoteExecutorEndpoint,
  signal?: AbortSignal,
): Promise<RemoteExecutorEndpoint> {
  const ready = await runCommandResult(sandbox, shellJoin(["bash", "-c", `if test -x ${EXECUTOR_WRAPPER} && test "$(codex --version 2>/dev/null)" = 'codex-cli ${CODEX_EXECUTOR_VERSION}'; then printf ready; fi`]), requestTimeoutMs, signal);
  if (ready.stdout !== "ready") {
    const installed = await runCommandResult(sandbox, shellJoin(["bash", "-c", `set -euo pipefail\nflock -x /tmp/ai-tg-codex-install.lock bash -c 'if ! command -v codex >/dev/null || [ "$(codex --version)" != "codex-cli ${CODEX_EXECUTOR_VERSION}" ]; then npm install -g --omit=dev --no-audit --no-fund @openai/codex@${CODEX_EXECUTOR_VERSION}; fi'`]), 180_000, signal);
    if (installed.exitCode !== 0) throw new Error("Could not install the pinned Codex executor in the existing sandbox");
    await sandbox.writeFile(EXECUTOR_WRAPPER, await executorWrapper(), "root", signal);
    const permissions = await runCommandResult(sandbox, shellJoin(["chmod", "755", EXECUTOR_WRAPPER]), requestTimeoutMs, signal);
    if (permissions.exitCode !== 0) throw new Error("Could not prepare the Codex executor wrapper");
  }
  const endpoint = previous?.sandboxId === sandbox.id ? previous : {
    sandboxId: sandbox.id,
    url: `wss://${sandbox.getHost(CODEX_EXECUTOR_PORT)}`,
    authBearerToken: randomBytes(32).toString("hex"),
  };
  // Reuse a token across a pause/resume in this process. A bot restart rotates it
  // and restarts only the executor, never the sandbox or its workspace.
  await runCommandResult(sandbox, shellJoin(["bash", "-c", `umask 077; mkdir -p ${EXECUTOR_ROOT}; chmod 700 ${EXECUTOR_ROOT}`]), requestTimeoutMs, signal, "user");
  await sandbox.writeFile(`${EXECUTOR_ROOT}/token.new`, endpoint.authBearerToken, "user", signal);
  const result = await runCommandResult(sandbox, shellJoin(["bash", "-c", `set -euo pipefail
umask 077
mkdir -p ${EXECUTOR_ROOT}
chmod 700 ${EXECUTOR_ROOT}
exec 9>${EXECUTOR_ROOT}/start.lock
flock -x 9
if [ -f ${EXECUTOR_ROOT}/pid ] && kill -0 "$(cat ${EXECUTOR_ROOT}/pid)" 2>/dev/null && cmp -s ${EXECUTOR_ROOT}/token.new ${EXECUTOR_ROOT}/token; then
  rm -f ${EXECUTOR_ROOT}/token.new
  exit 0
fi
if [ -f ${EXECUTOR_ROOT}/pid ]; then kill "$(cat ${EXECUTOR_ROOT}/pid)" 2>/dev/null || true; fi
install -m 600 ${EXECUTOR_ROOT}/token.new ${EXECUTOR_ROOT}/token
rm -f ${EXECUTOR_ROOT}/token.new
nohup ${EXECUTOR_WRAPPER} ${EXECUTOR_ROOT}/token >${EXECUTOR_ROOT}/log 2>&1 9>&- </dev/null &
printf '%s' "$!" >${EXECUTOR_ROOT}/pid`]), requestTimeoutMs, signal, "user");
  if (result.exitCode !== 0) throw new Error("Could not start the native Codex executor");
  return endpoint;
}

export const REMOTE_EXECUTOR_CWD = E2B_WORKSPACE;

/** Stage native image outputs at the exact paths already shown to Codex. */
export async function stageNativeArtifacts(sandbox: E2BSandbox, request: PrepareRemoteExecutorRequest, timeoutMs: number, hashes?: Map<string, string>): Promise<void> {
  if (!request.artifacts?.length) return;
  const root = request.artifactRoot && path.posix.normalize(request.artifactRoot);
  if (!root || !path.posix.isAbsolute(root) || path.posix.basename(root) !== "generated_images") throw new Error("Native artifact staging requires the trusted generated_images root");
  const pending: Array<{ path: string; bytes: Buffer; hash: string }> = [];
  for (const artifact of request.artifacts) {
    const normalized = path.posix.normalize(artifact.path);
    if (normalized !== artifact.path || !normalized.startsWith(`${root}/`) || !artifact.path.endsWith(".png")) throw new Error("Native artifact path is outside its generated image root");
    const hash = sha256Hex(artifact.bytes);
    if (hashes?.get(artifact.path) !== hash) pending.push({ ...artifact, hash });
  }
  if (pending.length === 0) return;
  const moves: Array<{ source: string; destination: string }> = [];
  try {
    // Root's private control directory prevents sandbox code from replacing an
    // uploaded file before publication. Open every destination directory without
    // following symlinks, then atomically replace the destination through its fd.
    for (const artifact of pending) {
      const source = path.posix.join(E2B_CONTROL_TMP, `native-artifact-${randomUUID()}`);
      moves.push({ source, destination: artifact.path });
      await sandbox.writeFile(source, artifact.bytes, "root", request.signal);
    }
    const script = `import json,os,sys
# native_artifact_atomic_publish
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
for item in json.loads(sys.argv[1]):
  fd=os.open('/',flags)
  try:
    pieces=item['destination'].split('/')[1:]
    for piece in pieces[:-1]:
      try: os.mkdir(piece,0o755,dir_fd=fd)
      except FileExistsError: pass
      child=os.open(piece,flags,dir_fd=fd)
      os.close(fd)
      fd=child
    os.chmod(item['source'],0o444,follow_symlinks=False)
    os.replace(item['source'],pieces[-1],dst_dir_fd=fd)
  finally: os.close(fd)`;
    const result = await runCommandResult(sandbox, shellJoin(["python3", "-c", script, JSON.stringify(moves)]), timeoutMs, request.signal);
    if (result.exitCode !== 0) throw new Error("Could not publish native generated images");
    for (const artifact of pending) hashes?.set(artifact.path, artifact.hash);
  } finally {
    await Promise.allSettled(moves.map(move => sandbox.removeFile(move.source, "root")));
  }
}
