import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { isBrowserUseConfigured, loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { createRenderOfficePreviewTool } from "../src/ai/tools/renderOfficePreview.js";
import { BrowserUseClient } from "../src/browserUse/client.js";
import { BrowserUseRuntimeManager } from "../src/browserUse/runtime.js";
import { createLogger } from "../src/logger.js";
import type { SandboxThreadFile } from "../src/sandbox/types.js";

const baseConfig = loadConfig();
const deploymentSuffix = randomUUID().slice(0, 8);
const config = {
  ...baseConfig,
  DB_URL: "sqlite::memory:",
  E2B_DEPLOYMENT_ID: `${baseConfig.E2B_DEPLOYMENT_ID}-smoke-${deploymentSuffix}`,
  BROWSER_USE_DEPLOYMENT_ID: `${baseConfig.BROWSER_USE_DEPLOYMENT_ID}-e2b-smoke-${deploymentSuffix}`,
};
const logger = createLogger(config);
const db = createDatabase(config, logger);
let runtime: ThreadE2BSandboxRuntimeManager | undefined;
let browserRuntime: BrowserUseRuntimeManager | undefined;
let repos: Repos | undefined;
let browserUserId: number | undefined;
let disposableBrowserProfileId: string | null = null;
let sandboxId: string | undefined;

try {
  await db.initialize();
  repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9_999_101, firstName: "E2B smoke", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "E2B smoke" });
  runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
  const marker = `e2b-smoke-${randomUUID()}`;
  const liveTelegramFileIds = (
    process.env.LIVE_TELEGRAM_FILE_IDS
    ?? process.env.LIVE_TELEGRAM_FILE_ID
    ?? ""
  ).split(",").map((value) => value.trim()).filter(Boolean);
  const threadFiles: SandboxThreadFile[] = [];
  for (let index = 0; index < liveTelegramFileIds.length; index += 1) {
    const telegramFileId = liveTelegramFileIds[index]!;
    const name = `telegram-fixture-${index + 1}.bin`;
    const stored = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "other",
      name,
      size: 0,
      isInline: false,
    });
    const [ref] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      telegramMessageId: 314 + index,
      refs: [{ fileId: telegramFileId, primary: true }],
    });
    threadFiles.push({
      fileId: stored.id,
      messageId: 314 + index,
      name,
      mimeType: null,
      expectedSize: null,
      expectedSha256: null,
      telegramRefs: [{
        id: ref!.id,
        telegramFileId,
        telegramSize: null,
        isPrimary: true,
        lastSeenAt: ref!.last_seen_at,
      }],
    });
  }
  const telegramSandboxPaths = threadFiles.map((file) =>
    `$TELEGRAM_FILES_DIR/${file.fileId}--${file.name}`
  );

  const contract = await runtime.execute(commandRequest(
    user.tg_id,
    thread.id,
    "/usr/local/bin/tool-contract.sh",
    [],
    threadFiles,
    5 * 60_000,
  ));
  if (contract.exitCode !== 0) {
    throw new Error(contract.error || contract.stderr || contract.stdout || "custom E2B toolbox contract failed");
  }

  const officeFixture = await runtime.execute(commandRequest(user.tg_id, thread.id, [
    "pptx_skill=/usr/local/share/officecli/skills/officecli-pptx/SKILL.md",
    "test -r \"$pptx_skill\"",
    "grep -Fq 'name: officecli-pptx' \"$pptx_skill\"",
    "grep -Fq '## QA (Required)' \"$pptx_skill\"",
    "officecli create office-preview-smoke.pptx",
    "officecli add office-preview-smoke.pptx / --type slide --prop layout=blank --prop background=FFFFFF",
    "officecli add office-preview-smoke.pptx '/slide[1]' --type shape --prop name=Title --prop text='Office preview smoke check' --prop x=2cm --prop y=2cm --prop width=29cm --prop height=3cm --prop font=Calibri --prop size=36 --prop bold=true --prop color=111111",
    "officecli save office-preview-smoke.pptx",
    "officecli validate office-preview-smoke.pptx",
  ].join("\n"), [], threadFiles, 60_000));
  if (officeFixture.exitCode !== 0) {
    throw new Error(officeFixture.error || officeFixture.stderr || "OfficeCLI PPTX skill/fixture check failed");
  }
  let officePreview: { size: number; media_type: string } | undefined;
  if (isBrowserUseConfigured(config)) {
    browserUserId = user.tg_id;
    browserRuntime = new BrowserUseRuntimeManager({ config, repos, logger });
    await browserRuntime.beginTurn(user.tg_id, thread.id);
    const browser = browserRuntime.forThread(user.tg_id, thread.id);
    const officePreviewTool = createRenderOfficePreviewTool({
      config,
      db,
      repos,
      user,
      thread,
      logger,
      commandRuntime: runtime,
      browserRuntime: browser,
    });
    const renderedPreview = await officePreviewTool.execute({ path: "/office-preview-smoke.pptx", page: 1 });
    if ("error" in renderedPreview) {
      throw new Error(`Office preview integration failed: ${renderedPreview.error}`);
    }
    officePreview = renderedPreview;
    await browser.closeSession();
    await browserRuntime.endTurn(user.tg_id, thread.id);
    disposableBrowserProfileId = (await repos.browserUseProfiles.get(
      config.BROWSER_USE_DEPLOYMENT_ID,
      user.tg_id,
    ))?.profile_id ?? null;
  }

  const first = await runtime.execute(commandRequest(user.tg_id, thread.id, [
    ...(threadFiles.length ? [
      ...telegramSandboxPaths.flatMap((filePath) => [
        `test -s "${filePath}"`,
        `test ! -w "${filePath}"`,
        `if printf forbidden 2>/dev/null > "${filePath}"; then exit 91; fi`,
      ]),
      `python3 -m zipfile -c restored.zip ${telegramSandboxPaths.map((value) => `"${value}"`).join(" ")}`,
      "test -s restored.zip",
    ] : []),
    `printf '%s' '${marker}' > marker.txt`,
    "zip -q sandbox-smoke.zip marker.txt",
    "test -s sandbox-smoke.zip",
    "printf '%s' \"$AGENT_WORKSPACE\"",
  ].join("\n"), [marker], threadFiles));
  if (first.exitCode !== 0 || first.stdout !== "/home/user/workspace") {
    throw new Error(first.error || first.stderr || "initial E2B command failed");
  }
  if (first.threadFiles.available !== threadFiles.length) {
    throw new Error("Telegram attachment did not sync into the sandbox");
  }
  const mapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, thread.id);
  if (!mapping) throw new Error("sandbox mapping was not persisted");
  sandboxId = mapping.sandbox_id;
  const sandboxInfo = await Sandbox.getInfo(sandboxId, {
    apiKey: config.E2B_API_KEY,
    requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
  });
  if (sandboxInfo.network?.denyOut?.length) {
    throw new Error(`sandbox unexpectedly has outbound deny rules: ${sandboxInfo.network.denyOut.join(", ")}`);
  }
  if (sandboxInfo.allowInternetAccess === false) {
    throw new Error("sandbox internet access is disabled");
  }
  if (sandboxInfo.cpuCount !== 2 || sandboxInfo.memoryMB !== 2048) {
    throw new Error(`unexpected custom template resources: ${sandboxInfo.cpuCount} vCPU / ${sandboxInfo.memoryMB} MiB`);
  }
  if (sandboxInfo.metadata.template_ref !== config.E2B_TEMPLATE) {
    throw new Error("sandbox metadata does not identify the configured custom template");
  }

  await Sandbox.pause(sandboxId, {
    apiKey: config.E2B_API_KEY,
    requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
    keepMemory: true,
  });
  await runtime.dispose();
  runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });

  const resumed = await runtime.execute(commandRequest(
    user.tg_id,
    thread.id,
    [
      "test \"$(cat marker.txt)\" = \"$1\"",
      ...telegramSandboxPaths.flatMap((filePath) => [
        `test -s "${filePath}"`,
        `test ! -w "${filePath}"`,
      ]),
      "printf RESUMED",
    ].join("\n"),
    [marker],
    threadFiles,
  ));
  if (resumed.exitCode !== 0 || resumed.stdout !== "RESUMED") {
    throw new Error(resumed.error || resumed.stderr || "pause/resume persistence check failed");
  }
  const after = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, thread.id);
  if (after?.sandbox_id !== sandboxId) throw new Error("thread resumed into a different sandbox");

  let recreatedAfterLoss = false;
  if (threadFiles.length) {
    const lostSandboxId = sandboxId;
    await Sandbox.kill(lostSandboxId, {
      apiKey: config.E2B_API_KEY,
      requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
    });
    await runtime.dispose();
    runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
    const recreated = await runtime.execute(commandRequest(
      user.tg_id,
      thread.id,
      [
        ...telegramSandboxPaths.flatMap((filePath) => [
          `test -s "${filePath}"`,
          `test ! -w "${filePath}"`,
        ]),
        `python3 -m zipfile -c recreated-restored.zip ${telegramSandboxPaths.map((value) => `"${value}"`).join(" ")}`,
        "test -s recreated-restored.zip",
        "printf RECREATED",
      ].join("\n"),
      [],
      threadFiles,
    ));
    if (recreated.exitCode !== 0 || recreated.stdout !== "RECREATED") {
      throw new Error(recreated.error || recreated.stderr || "sandbox recreation restore check failed");
    }
    const recreatedMapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, thread.id);
    if (!recreatedMapping || recreatedMapping.sandbox_id === lostSandboxId) {
      throw new Error("lost sandbox was not replaced");
    }
    sandboxId = recreatedMapping.sandbox_id;
    recreatedAfterLoss = true;
  }

  const websiteMarker = `website-smoke-${randomUUID()}`;
  const lease = runtime.acquireActivityLease(user.tg_id, thread.id);
  let publishedUrl: string;
  try {
    const server = await runtime.execute(commandRequest(
      user.tg_id,
      thread.id,
      [
        "command -v python3 >/dev/null",
        "printf '%s' \"$1\" > index.html",
        "nohup python3 -m http.server 3000 --bind 0.0.0.0 > website.log 2>&1 &",
        "for attempt in 1 2 3 4 5 6 7 8 9 10; do",
        "  python3 -c 'import socket; socket.create_connection((\"127.0.0.1\", 3000), 1).close()' && break",
        "  sleep 0.2",
        "done",
        "python3 -c 'import socket; socket.create_connection((\"127.0.0.1\", 3000), 1).close()'",
      ].join("\n"),
      [websiteMarker],
      threadFiles,
    ));
    if (server.exitCode !== 0) {
      throw new Error(server.error || server.stderr || "website server failed to start");
    }
    const published = await runtime.publishWebsite({
      userId: user.tg_id,
      threadId: thread.id,
      port: 3000,
      path: "/",
      threadFiles,
    });
    if (published.sandboxId !== sandboxId || published.pausesAfterMinutes !== 15) {
      throw new Error("published website did not retain the thread sandbox or 15-minute idle policy");
    }
    const response = await fetch(published.url, {
      signal: AbortSignal.timeout(config.E2B_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || await response.text() !== websiteMarker) {
      throw new Error(`published website returned HTTP ${response.status}`);
    }
    publishedUrl = published.url;
  } finally {
    lease.release();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    sandboxId,
    template: config.E2B_TEMPLATE,
    sameSandboxAfterResume: true,
    workspacePersisted: true,
    telegramFilesReadOnly: true,
    botMediatedTelegramRestoreTested: Boolean(threadFiles.length),
    restoredTelegramFiles: threadFiles.length,
    recreatedAfterLoss,
    zipToolTested: true,
    toolContractPassed: true,
    officeCliPptxSkillReadable: true,
    officePreviewRendered: Boolean(officePreview),
    officePreviewBytes: officePreview?.size,
    officePreviewMediaType: officePreview?.media_type,
    chromiumIntentionallyAbsent: true,
    cpuCount: sandboxInfo.cpuCount,
    memoryMB: sandboxInfo.memoryMB,
    unrestrictedEgress: true,
    websitePublished: true,
    websiteUrl: publishedUrl!,
    websiteIdlePauseMinutes: 15,
  }, null, 2)}\n`);
} finally {
  await browserRuntime?.dispose().catch(() => undefined);
  if (!disposableBrowserProfileId && repos && browserUserId !== undefined) {
    disposableBrowserProfileId = (await repos.browserUseProfiles.get(
      config.BROWSER_USE_DEPLOYMENT_ID,
      browserUserId,
    ).catch(() => undefined))?.profile_id ?? null;
  }
  if (disposableBrowserProfileId && isBrowserUseConfigured(config)) {
    await new BrowserUseClient(config).deleteProfile(disposableBrowserProfileId).catch(() => undefined);
  }
  await runtime?.dispose();
  if (sandboxId) {
    await Sandbox.kill(sandboxId, {
      apiKey: config.E2B_API_KEY,
      requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
    }).catch(() => undefined);
  }
  await db.destroy();
}

function commandRequest(
  userId: number,
  threadId: number,
  script: string,
  args: string[] = [],
  threadFiles: SandboxThreadFile[] = [],
  timeoutMs = 30_000,
) {
  return {
    userId,
    threadId,
    command: "bash",
    args: ["-c", script, "bash", ...args],
    env: {},
    stdin: "",
    workingDir: "/home/user/workspace",
    timeoutMs,
    maxOutputChars: 12_000,
    threadFiles,
  };
}
