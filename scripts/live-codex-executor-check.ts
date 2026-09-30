import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { CodexAppServer, type RpcNotification } from "../src/codex/appServer.js";
import { LazyCodexExecutor } from "../src/codex/lazyExecutor.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { E2B_TELEGRAM_FILES, E2B_WORKSPACE } from "../src/e2b/paths.js";
import type { SandboxThreadFile } from "../src/sandbox/types.js";
import { sha256Hex } from "../src/files/hash.js";

// This smoke uses a controlled Responses provider, not paid model inference.
// Sandbox execution and the attachment restoration pipeline are real E2B.
const base = loadConfig();
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-codex-smoke-"));
const config = { ...base, DB_URL: "sqlite::memory:", CODEX_HOME: path.join(scratch, "codex"), E2B_DEPLOYMENT_ID: `${base.E2B_DEPLOYMENT_ID}-codex-smoke-${randomUUID()}`, BROWSER_USE_API_KEY: undefined };
const logger = createLogger(config);
const db = createDatabase(config, logger);
const repos = createRepos(db.db, db.search);
const artifactRoot = path.join(config.CODEX_HOME, "generated_images");
const generatedPath = path.join(artifactRoot, "fixture", "image.png");
const credentialProbe = 'for credential_name in BOT_TOKEN OPENROUTER_API_KEY E2B_API_KEY TAVILY_API_KEY OPENAI_API_KEY; do test -z "${!credential_name:-}" || { printf "Host credential reached sandbox" >&2; exit 72; }; done';
const attachmentBytes = Buffer.from(`Restored conversation attachment ${randomUUID()}\n`);
const sandboxIds = new Set<string>();
let runtime: ThreadE2BSandboxRuntimeManager | undefined;
let adapter: LazyCodexExecutor | undefined;
let app: CodexAppServer | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let phase = "plain";
let toolStep = 0;
let modelRequests = 0;
let downloads = 0;
let currentThreadId = "";
let attachmentPath = "";
let runtimeThreadId: number | undefined;
const nativeEvents: RpcNotification[] = [];

try {
  await db.initialize();
  const user = await repos.users.ensure({ tgId: 9_999_111, firstName: "Codex executor smoke", lang: "en" });
  const conversation = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Native remote executor smoke" });
  runtimeThreadId = conversation.id;
  const stored = await repos.files.insertFile({ userId: user.tg_id, threadId: conversation.id, type: "txt", name: "restored.txt", mimeType: "text/plain", size: attachmentBytes.length, contentSha256: sha256Hex(attachmentBytes), isInline: true });
  const [ref] = await repos.files.rememberTelegramFileRefs(stored.id, { direction: "inbound", mediaKind: "document", refs: [{ fileId: "controlled-telegram-fixture", size: attachmentBytes.length, primary: true }] });
  const files: SandboxThreadFile[] = [{ fileId: stored.id, messageId: null, name: stored.name, mimeType: stored.mime_type, expectedSize: stored.size, expectedSha256: stored.content_sha256, telegramRefs: [{ id: ref!.id, telegramFileId: ref!.telegram_file_id, telegramSize: ref!.telegram_size, direction: "inbound", mediaKind: "document", isPrimary: true, lastSeenAt: ref!.last_seen_at }] }];
  attachmentPath = `${E2B_TELEGRAM_FILES}/${stored.id}--restored.txt`;
  await fs.mkdir(path.dirname(generatedPath), { recursive: true });
  const image = pngFixture();
  await fs.writeFile(generatedPath, image);
  runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger, downloadTelegramBytes: async fileId => {
    assert.equal(fileId, "controlled-telegram-fixture"); downloads += 1; return attachmentBytes;
  } });
  adapter = await LazyCodexExecutor.create({ logger, cachePath: path.join(scratch, "executor-bootstrap.json"), resolveLocalArtifact: async (fileUrl, operation) => {
    if (fileUrl !== pathToFileURL(generatedPath).href) return undefined;
    if (operation === "fs/readFile") return { dataBase64: (await fs.readFile(generatedPath)).toString("base64") };
    const stat = await fs.stat(generatedPath);
    return { isDirectory: false, isFile: true, isSymlink: false, size: stat.size, createdAtMs: Math.trunc(stat.birthtimeMs), modifiedAtMs: Math.trunc(stat.mtimeMs) };
  }, prepareExecutor: async (onExecutorReady, signal, options) => {
    await runtime!.prepareRemoteExecutor({ userId: user.tg_id, threadId: conversation.id, files, artifacts: [{ path: generatedPath, bytes: image }], artifactRoot, allowRotation: options.allowRotation, signal, onExecutorReady: async endpoint => { sandboxIds.add(endpoint.sandboxId); await onExecutorReady(endpoint); } });
  } });
  provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({});
    await request.json();
    modelRequests += 1;
    const step = toolStep++;
    const responseId = `controlled-response-${modelRequests}`;
    let item: Record<string, unknown> = { type: "message", role: "assistant", id: `message-${modelRequests}`, content: [{ type: "output_text", text: `Completed ${phase}.` }] };
    if ((phase === "local-image" || phase === "local-image-after-pause") && step === 0) item = { type: "function_call", call_id: `local-image-${modelRequests}`, name: "view_image", arguments: JSON.stringify({ path: generatedPath }) };
    else if (phase === "native" && step === 0) item = { type: "function_call", call_id: `exec-${modelRequests}`, name: "exec_command", arguments: JSON.stringify({ cmd: `${credentialProbe}; cat '${attachmentPath}' > attachment-copy.txt; printf 'workspace survived pause\\n' > unfinished-project.txt`, workdir: E2B_WORKSPACE, login: false, yield_time_ms: 1_000 }) };
    else if (phase === "native" && step === 1) item = { type: "custom_tool_call", call_id: `patch-${modelRequests}`, name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${E2B_WORKSPACE}/native-patch.txt\n+Native patch worked.\n*** End Patch` };
    else if (phase === "native" && step === 2) item = { type: "function_call", call_id: `image-${modelRequests}`, name: "view_image", arguments: JSON.stringify({ path: generatedPath }) };
    else if ((phase === "resume" || phase === "recreated") && step === 0) item = { type: "function_call", call_id: `restore-${modelRequests}`, name: "exec_command", arguments: JSON.stringify({ cmd: `cat '${attachmentPath}' > ${phase}.txt${phase === "resume" ? "; test -f unfinished-project.txt" : ""}`, workdir: E2B_WORKSPACE, login: false, yield_time_ms: 1_000 }) };
    const events = [{ type: "response.created", response: { id: responseId } }, { type: "response.output_item.done", item }, { type: "response.completed", response: { id: responseId, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  await fs.mkdir(config.CODEX_HOME, { recursive: true });
  await fs.writeFile(path.join(config.CODEX_HOME, "config.toml"), `model = "${config.CODEX_MODEL}"\nmodel_provider = "controlled"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.controlled]\nname = "Local smoke provider"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nwire_api = "responses"\n[features]\ndeferred_executor = true\nunified_exec = true\nshell_snapshot = false\n[analytics]\nenabled = false\n`);
  // No Codex subscription/API credentials are copied into this scratch home.
  app = new CodexAppServer({ home: config.CODEX_HOME, executable: config.CODEX_EXECUTABLE, requestTimeoutMs: 180_000, logger, env: { HOME: scratch, RUST_LOG: "error" } });
  await app.initialize();
  app.onNotification(event => { if (event.method === "item/completed" || event.method === "error") nativeEvents.push(event); });
  await app.request("environment/add", { environmentId: "e2b-smoke", execServerUrl: adapter.url, authBearerToken: adapter.authBearerToken });
  const started = await app.request<{ thread: { id: string } }>("thread/start", { model: config.CODEX_MODEL, modelProvider: "controlled", cwd: scratch, approvalPolicy: "never", sandbox: "danger-full-access", environments: [{ environmentId: "e2b-smoke", cwd: E2B_WORKSPACE }] });
  currentThreadId = started.thread.id;
  await runTurn("plain");
  assert.equal(await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, conversation.id), undefined, "A simple question must not create an E2B sandbox");
  console.log("PASS: plain question created no sandbox");
  await runTurn("local-image");
  assert.equal(await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, conversation.id), undefined, "Native local image viewing must not create an E2B sandbox");
  assert.equal(downloads, 0);
  assert.ok(nativeEvents.some(event => (event.params.item as { type?: string })?.type === "imageView"));
  console.log("PASS: native image view read the host artifact without creating a sandbox");
  const activity = runtime.acquireActivityLease(user.tg_id, conversation.id, { native: true });
  try { await runTurn("native"); await adapter.refreshBootstrap(); }
  finally { activity.release(); }
  let mapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, conversation.id);
  assert.ok(mapping);
  let sandbox = await Sandbox.connect(mapping.sandbox_id, { apiKey: config.E2B_API_KEY, timeoutMs: 600_000 });
  assert.equal(await sandbox.files.read(`${E2B_WORKSPACE}/attachment-copy.txt`), attachmentBytes.toString());
  assert.equal(await sandbox.files.read(`${E2B_WORKSPACE}/native-patch.txt`), "Native patch worked.\n");
  assert.ok(nativeEvents.some(event => (event.params.item as { type?: string })?.type === "imageView"));
  assert.equal(Buffer.from(await sandbox.files.read(generatedPath, { format: "bytes", user: "user" })).equals(image), true);
  console.log("PASS: native exec, patch, image view, automatic attachments, native artifact paths, and absence of host credentials");
  const originalId = mapping.sandbox_id;
  await sandbox.pause({ keepMemory: true });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  await runTurn("plain-after-pause");
  assert.equal((await Sandbox.getInfo(originalId, { apiKey: config.E2B_API_KEY })).state, "paused", "A simple question must leave the sandbox paused");
  console.log("PASS: a simple question leaves the existing sandbox paused");
  await runTurn("local-image-after-pause");
  assert.equal((await Sandbox.getInfo(originalId, { apiKey: config.E2B_API_KEY })).state, "paused", "Native local image viewing must leave the sandbox paused");
  assert.equal(downloads, 1);
  console.log("PASS: native image view leaves the existing sandbox paused");
  await runTurn("resume");
  mapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, conversation.id);
  assert.equal(mapping?.sandbox_id, originalId);
  sandbox = await Sandbox.connect(originalId, { apiKey: config.E2B_API_KEY, timeoutMs: 600_000 });
  assert.equal(await sandbox.files.read(`${E2B_WORKSPACE}/resume.txt`), attachmentBytes.toString());
  assert.equal(await sandbox.files.read(`${E2B_WORKSPACE}/unfinished-project.txt`), "workspace survived pause\n");
  assert.equal(downloads, 1, "A resumed sandbox must reuse its restored attachments");
  console.log("PASS: pause/resume preserved the workspace without re-downloading attachments");
  await adapter.refreshBootstrap();
  await sandbox.kill();
  await new Promise(resolve => setTimeout(resolve, 1_000));
  adapter.invalidateFiles();
  await runTurn("recreated");
  mapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, conversation.id);
  assert.ok(mapping && mapping.sandbox_id !== originalId);
  sandbox = await Sandbox.connect(mapping.sandbox_id, { apiKey: config.E2B_API_KEY, timeoutMs: 600_000 });
  assert.equal(await sandbox.files.read(`${E2B_WORKSPACE}/recreated.txt`), attachmentBytes.toString());
  assert.equal(downloads, 2, "A replacement sandbox must automatically restore the attachment again");
  console.log("PASS: deleted sandbox recreation automatically restored conversation attachments");
  console.log(JSON.stringify({ status: "passed", template: config.E2B_TEMPLATE, modelRequests, inference: "controlled provider, no paid inference", attachmentSource: "controlled Telegram source, real restoration pipeline", sandboxes: sandboxIds.size }));
} catch (error) {
  console.error("Codex executor smoke failed:", error);
  process.exitCode = 1;
} finally {
  await app?.dispose();
  await adapter?.dispose();
  await runtime?.dispose();
  if (runtimeThreadId !== undefined) {
    const mapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, runtimeThreadId).catch(() => undefined);
    if (mapping) sandboxIds.add(mapping.sandbox_id);
  }
  provider?.stop(true);
  await Promise.allSettled([...sandboxIds].map(sandboxId => Sandbox.kill(sandboxId, { apiKey: config.E2B_API_KEY })));
  await db.destroy();
  await fs.rm(scratch, { recursive: true, force: true });
}

async function runTurn(nextPhase: string): Promise<void> {
  adapter!.beginTurn();
  phase = nextPhase; toolStep = 0;
  let timeout: NodeJS.Timeout | undefined;
  let detach: (() => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => { detach?.(); reject(new Error(`Timed out during ${nextPhase}`)); }, 300_000);
    timeout.unref();
    detach = app!.onNotification(event => {
      if (event.method !== "turn/completed" || event.params.threadId !== currentThreadId) return;
      clearTimeout(timeout); detach?.();
      const turn = event.params.turn as { status?: string; error?: unknown };
      if (turn.status !== "completed") reject(new Error(`Native turn ${nextPhase} failed: ${JSON.stringify(turn.error)}`));
      else resolve();
    });
  });
  try {
    await app!.request("turn/start", { threadId: currentThreadId, input: [{ type: "text", text: `Run controlled native executor smoke phase ${nextPhase}.` }] });
    await completion;
  } finally { clearTimeout(timeout); detach?.(); }
}

function pngFixture(): Buffer {
  // A one-pixel test fixture verifies file/vision transport; it is not generated artwork.
  const crc32 = (data: Buffer) => { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, bytes: Buffer) => { const payload = Buffer.concat([Buffer.from(name), bytes]); const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([size, payload, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
