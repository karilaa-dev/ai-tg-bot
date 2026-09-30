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
import { SandboxToolsOutdatedError } from "../sandbox/toolPolicy.js";

export const CODEX_EXECUTOR_VERSION = "0.159.2";
export const CODEX_EXECUTOR_PORT = 8765;
const EXECUTOR_ROOT = "/home/user/.ai-tg-codex-executor";
const EXECUTOR_WRAPPER = "/usr/local/bin/ai-tg-codex-executor";

export interface RemoteExecutorEndpoint {
  sandboxId: string;
  url: string;
  authBearerToken: string;
  /** Verified, protected native binary directory; bypasses the npm launcher. */
  nativeBinaryDirectory?: string;
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

/** Start only the executor already present in the sandbox image. */
export async function prepareNativeExecutor(
  sandbox: E2BSandbox,
  requestTimeoutMs: number,
  previous?: RemoteExecutorEndpoint,
  signal?: AbortSignal,
): Promise<RemoteExecutorEndpoint> {
  let nativeBinaryDirectory = previous?.sandboxId === sandbox.id ? previous.nativeBinaryDirectory : undefined;
  if (!nativeBinaryDirectory) {
    const expectedWrapper = await executorWrapper();
    const probe = await probeNativeExecutor(sandbox, sha256Hex(Buffer.from(expectedWrapper)), requestTimeoutMs, signal);
    if (probe.status !== "ready") throw new SandboxToolsOutdatedError();
    nativeBinaryDirectory = probe.nativeBinaryDirectory;
    if (!nativeBinaryDirectory) throw new Error("Could not locate the pinned native Codex executor");
  }
  const endpoint = previous?.sandboxId === sandbox.id ? { ...previous, nativeBinaryDirectory } : {
    sandboxId: sandbox.id,
    url: `wss://${sandbox.getHost(CODEX_EXECUTOR_PORT)}`,
    authBearerToken: randomBytes(32).toString("hex"),
    nativeBinaryDirectory,
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
export PATH=${shellJoin([nativeBinaryDirectory])}:$PATH
nohup ${EXECUTOR_WRAPPER} ${EXECUTOR_ROOT}/token >${EXECUTOR_ROOT}/log 2>&1 9>&- </dev/null &
printf '%s' "$!" >${EXECUTOR_ROOT}/pid`]), requestTimeoutMs, signal, "user");
  if (result.exitCode !== 0) throw new Error("Could not start the native Codex executor");
  return endpoint;
}

interface ExecutorProbe {
  status: "ready" | "pinned" | "missing";
  nativeBinaryDirectory?: string;
}

async function probeNativeExecutor(sandbox: E2BSandbox, wrapperHash: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecutorProbe> {
  // The release contract checks the native executable's reported version.
  // Runtime protects and verifies root-owned package metadata and executable
  // paths without launching another complete Codex process just for --version.
  const script = `import hashlib,json,os,pathlib,platform,shutil,stat,sys
# codex_executor_metadata
def protected(location,seal=False):
 original=pathlib.Path(os.path.abspath(location))
 location=pathlib.Path(os.path.realpath(original))
 if location!=original: return False
 if not str(location).startswith('/usr/'): return False
 while True:
  info=location.stat()
  if info.st_uid!=0: return False
  # E2B's initial snapshot can restore root files with writable mode bits.
  # Seal only the selected files and their parents, without recursive chmod.
  mode=stat.S_IMODE(info.st_mode)
  if seal and mode & 0o022:
   os.chmod(location,mode & ~0o022)
   if location.stat().st_mode & 0o022: return False
  if location.parent==location: return True
  location=location.parent
try:
 entry=pathlib.Path(os.path.realpath(shutil.which('codex') or '/missing'))
 root=entry.parent.parent
 metadata=root/'package.json'
 if not protected(entry) or not protected(metadata): raise ValueError('unprotected package')
 package=json.loads(metadata.read_text())
 triple={'x86_64':'x86_64-unknown-linux-musl','aarch64':'aarch64-unknown-linux-musl'}[platform.machine()]
 platform_package='codex-linux-'+('x64' if platform.machine()=='x86_64' else 'arm64')
 candidates=[root/'node_modules'/'@openai'/platform_package/'vendor'/triple/'bin'/'codex',root.parent/platform_package/'vendor'/triple/'bin'/'codex',root/'vendor'/triple/'bin'/'codex']
 binary=next((p for p in candidates if p.is_file() and os.access(p,os.X_OK) and protected(p)),None)
 pinned=entry.name=='codex.js' and entry.parent.name=='bin' and package.get('name')=='@openai/codex' and package.get('version')==sys.argv[1] and binary is not None
 wrapper=pathlib.Path(sys.argv[3])
 ready=pinned and not wrapper.is_symlink() and wrapper.is_file() and os.access(wrapper,os.X_OK) and protected(wrapper) and hashlib.sha256(wrapper.read_bytes()).hexdigest()==sys.argv[2]
 # Old or missing tools are left untouched. Seal assets only after verifying
 # that this sandbox already has the expected executor and wrapper.
 if ready: ready=all(protected(p,seal=True) for p in [entry,metadata,binary,wrapper])
 print(json.dumps({'status':'ready' if ready else 'pinned' if pinned else 'missing','nativeBinaryDirectory':str(binary.parent.resolve()) if pinned else None}),end='')
except (OSError,ValueError,KeyError): print(json.dumps({'status':'missing'}),end='')`;
  const result = await runCommandResult(sandbox, shellJoin(["python3", "-c", script, CODEX_EXECUTOR_VERSION, wrapperHash, EXECUTOR_WRAPPER]), timeoutMs, signal);
  if (result.exitCode !== 0) throw new Error("Could not inspect the pinned Codex executor installation");
  const probe = JSON.parse(result.stdout) as ExecutorProbe;
  if (!["ready", "pinned", "missing"].includes(probe.status)) throw new Error("Unexpected native Codex executor metadata");
  if (probe.status !== "missing" && (!probe.nativeBinaryDirectory?.startsWith("/usr/") || path.posix.normalize(probe.nativeBinaryDirectory) !== probe.nativeBinaryDirectory)) throw new Error("Invalid native Codex executor location");
  return probe;
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
