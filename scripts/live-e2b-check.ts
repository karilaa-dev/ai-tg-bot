import { randomUUID } from "node:crypto";
import { sha256Hex } from "../src/files/hash.js";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { OfficeValidation } from "../src/office/validation.js";
import { officeBundle, OFFICE_BUNDLE_PATH } from "../src/e2b/officeBundle.js";
import { shellJoin } from "../src/util/shell.js";
import { createRenderOfficePreviewTool } from "../src/ai/tools/renderOfficePreview.js";
import { createLogger } from "../src/logger.js";
import type { SandboxThreadFile } from "../src/sandbox/types.js";

const baseConfig = loadConfig();
const deploymentSuffix = randomUUID().slice(0, 8);
const config = {
  ...baseConfig,
  DB_URL: "sqlite::memory:",
  E2B_DEPLOYMENT_ID: `${baseConfig.E2B_DEPLOYMENT_ID}-smoke-${deploymentSuffix}`,
  BROWSER_USE_API_KEY: undefined,
};
const logger = createLogger(config);
const db = createDatabase(config, logger);
let runtime: ThreadE2BSandboxRuntimeManager | undefined;
let repos: Repos | undefined;
let sandboxId: string | undefined;

try {
  await db.initialize();
  repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({
    tgId: 9_999_101,
    firstName: "E2B smoke",
    lang: "en",
  });
  const thread = await repos.threads.create({
    userId: user.tg_id,
    topicId: null,
    title: "E2B smoke",
  });
  const upgradeFrom = process.env.E2B_UPGRADE_FROM?.trim();
  const upgradeMarker = `preserved-before-office-upgrade-${randomUUID()}`;
  const upgradeSource = `/home/user/.ai-tg-bot/file-sources/${sha256Hex(Buffer.from(upgradeMarker))}`;
  if (upgradeFrom) {
    const previous = await Sandbox.create(upgradeFrom, {
      apiKey: config.E2B_API_KEY,
      timeoutMs: 10 * 60_000,
      secure: true,
      metadata: {
        app: "ai-tg-bot",
        deployment: config.E2B_DEPLOYMENT_ID,
        template_ref: upgradeFrom,
        telegram_user_id: String(user.tg_id),
        thread_id: String(thread.id),
      },
    });
    sandboxId = previous.sandboxId;
    await previous.files.write(
      "/home/user/workspace/before-office-upgrade.txt",
      upgradeMarker,
      { user: "user" },
    );
    await previous.commands.run("mkdir -p /home/user/.ai-tg-bot/file-sources", {
      user: "root",
    });
    await previous.files.write(upgradeSource, upgradeMarker, { user: "root" });
    await previous.commands.run(`mkdir -p ${OFFICE_BUNDLE_PATH}`, {
      user: "root",
    });
    await previous.files.write(
      `${OFFICE_BUNDLE_PATH}/removed-in-next-release.txt`,
      "obsolete asset",
      { user: "root" },
    );
    await repos.threadSandboxes.insertIfAbsent({
      deploymentId: config.E2B_DEPLOYMENT_ID,
      userId: user.tg_id,
      threadId: thread.id,
      sandboxId,
    });
  }
  runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
  const marker = `e2b-smoke-${randomUUID()}`;
  const liveTelegramFileIds = (
    process.env.LIVE_TELEGRAM_FILE_IDS ??
    process.env.LIVE_TELEGRAM_FILE_ID ??
    ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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
      telegramRefs: [
        {
          id: ref!.id,
          telegramFileId,
          telegramSize: null,
          direction: "inbound",
          mediaKind: "document",
          isPrimary: true,
          lastSeenAt: ref!.last_seen_at,
        },
      ],
    });
  }
  const telegramSandboxPaths = threadFiles.map(
    (file) => `$TELEGRAM_FILES_DIR/${file.fileId}--${file.name}`,
  );

  const contract = await runtime.execute(
    commandRequest(
      user.tg_id,
      thread.id,
      upgradeFrom
        ? "/usr/local/bin/office-contract"
        : "/usr/local/bin/tool-contract.sh",
      [],
      threadFiles,
      5 * 60_000,
    ),
  );
  if (contract.exitCode !== 0) {
    throw new Error(
      contract.error ||
        contract.stderr ||
        contract.stdout ||
        "custom E2B toolbox contract failed",
    );
  }
  const initialMapping = await repos.threadSandboxes.get(
    config.E2B_DEPLOYMENT_ID,
    thread.id,
  );
  if (!initialMapping)
    throw new Error(
      "sandbox mapping was not persisted after the toolbox contract",
    );
  if (upgradeFrom) {
    if (sandboxId !== initialMapping.sandbox_id)
      throw new Error("Office upgrade replaced the existing sandbox");
    const kept = await runtime.readWorkspaceFile({
      userId: user.tg_id,
      threadId: thread.id,
      virtualPath: "/before-office-upgrade.txt",
      maxBytes: 1000,
    });
    const source = await runtime.readSourceFile({
      userId: user.tg_id,
      threadId: thread.id,
      sandboxId: sandboxId!,
      canonicalPath: upgradeSource,
      maxBytes: 1000,
    });
    if (
      kept.bytes.toString() !== upgradeMarker ||
      source.toString() !== upgradeMarker
    )
      throw new Error("Office upgrade lost workspace or saved source bytes");
    const removed = await runtime.execute(
      commandRequest(user.tg_id, thread.id, "! command -v officecli"),
    );
    if (removed.exitCode !== 0)
      throw new Error("OfficeCLI remained installed after replacement checks");
    const bundle = await officeBundle();
    const upgraded = await Sandbox.connect(sandboxId!, {
      apiKey: config.E2B_API_KEY,
    });
    await upgraded.commands.run(
      shellJoin([
        "bash",
        "-c",
        [
          "set -euo pipefail",
          `test ! -e ${OFFICE_BUNDLE_PATH}/removed-in-next-release.txt`,
          `test "$(cat /opt/office/installed-revision)" = ${bundle.revision}`,
          "task_gate=$(mktemp -d)",
          `stage_one=${OFFICE_BUNDLE_PATH}.lock-test-one`,
          `stage_two=${OFFICE_BUNDLE_PATH}.lock-test-two`,
          "holder= installer_one= installer_two=",
          'trap \'touch "$task_gate/release"; wait ${holder:-} ${installer_one:-} ${installer_two:-} 2>/dev/null || true; rm -rf -- "$task_gate" "$stage_one" "$stage_two"\' EXIT',
          `cp -a ${OFFICE_BUNDLE_PATH} "$stage_one"`,
          `cp -a ${OFFICE_BUNDLE_PATH} "$stage_two"`,
          `touch ${OFFICE_BUNDLE_PATH}/locked-sentinel`,
          'flock -x /var/lock/ai-tg-bot-office-install.lock bash -c \'touch "$1/held"; while [[ ! -e $1/release ]]; do sleep 0.05; done\' -- "$task_gate" &',
          "holder=$!",
          "for attempt in {1..100}; do [[ -e $task_gate/held ]] && break; sleep 0.05; done",
          'test -e "$task_gate/held"',
          `bash "$stage_one/install.sh" ${bundle.revision} >"$task_gate/one.log" 2>&1 &`,
          "installer_one=$!",
          `bash "$stage_two/install.sh" ${bundle.revision} >"$task_gate/two.log" 2>&1 &`,
          "installer_two=$!",
          "sleep 0.5",
          'kill -0 "$installer_one" "$installer_two"',
          `test -e ${OFFICE_BUNDLE_PATH}/locked-sentinel`,
          'test -d "$stage_one" && test -d "$stage_two"',
          'touch "$task_gate/release"',
          'wait "$holder"',
          'wait "$installer_one" || { cat "$task_gate/one.log"; exit 1; }',
          'wait "$installer_two" || { cat "$task_gate/two.log"; exit 1; }',
          `test ! -e ${OFFICE_BUNDLE_PATH}/locked-sentinel`,
          'test ! -e "$stage_one" && test ! -e "$stage_two"',
          `test "$(cat /opt/office/installed-revision)" = ${bundle.revision}`,
          "printf 'Concurrent Office promotions respected the remote lock\\n'",
        ].join("\n"),
      ]),
      { user: "root", timeoutMs: 30_000 },
    );
  }
  sandboxId = initialMapping.sandbox_id;

  const officeFixture = await runtime.execute(
    commandRequest(
      user.tg_id,
      thread.id,
      "pptxgenjs-run /opt/office/node/example-deck.cjs /home/user/workspace/office-preview-smoke.pptx",
      [],
      threadFiles,
      60_000,
    ),
  );
  if (officeFixture.exitCode !== 0)
    throw new Error(
      officeFixture.error || officeFixture.stderr || "PPTX fixture failed",
    );
  const officeValidation = new OfficeValidation({
    runtime,
    config,
    userId: user.tg_id,
    threadId: thread.id,
  });
  const officePreviewTool = createRenderOfficePreviewTool({
    config,
    db,
    repos,
    user,
    thread,
    logger,
    commandRuntime: runtime,
    officeValidation,
  });
  const officePreview = await officePreviewTool.execute({
    path: "/office-preview-smoke.pptx",
    pages: [1, 2],
  });
  if ("error" in officePreview) throw new Error(officePreview.error);
  await officePreviewTool.toModelOutput!({
    toolCallId: "smoke",
    input: { path: "/office-preview-smoke.pptx", pages: [1, 2] },
    output: officePreview,
  });
  // The deterministic smoke confirms rendering and review gating. Visual approval
  // itself is exercised by the separate live Pi Office workflow.
  const report = await officeValidation.validate("/office-preview-smoke.pptx");
  if (report.approved || report.visual_review.rendered_pages.length !== 2)
    throw new Error("Rendering incorrectly granted visual approval");

  const first = await runtime.execute(
    commandRequest(
      user.tg_id,
      thread.id,
      [
        ...(threadFiles.length
          ? [
              ...telegramSandboxPaths.flatMap((filePath) => [
                `test -s "${filePath}"`,
                `test ! -w "${filePath}"`,
                `if printf forbidden 2>/dev/null > "${filePath}"; then exit 91; fi`,
              ]),
              `python3 -m zipfile -c restored.zip ${telegramSandboxPaths.map((value) => `"${value}"`).join(" ")}`,
              "test -s restored.zip",
            ]
          : []),
        `printf '%s' '${marker}' > marker.txt`,
        "zip -q sandbox-smoke.zip marker.txt",
        "test -s sandbox-smoke.zip",
        "printf '%s' \"$AGENT_WORKSPACE\"",
      ].join("\n"),
      [marker],
      threadFiles,
    ),
  );
  if (first.exitCode !== 0 || first.stdout !== "/home/user/workspace") {
    throw new Error(
      first.error || first.stderr || "initial E2B command failed",
    );
  }
  if (first.threadFiles.available !== threadFiles.length) {
    throw new Error("Telegram attachment did not sync into the sandbox");
  }
  const mapping = await repos.threadSandboxes.get(
    config.E2B_DEPLOYMENT_ID,
    thread.id,
  );
  if (!mapping) throw new Error("sandbox mapping was not persisted");
  sandboxId = mapping.sandbox_id;
  const firstExport = await runtime.readWorkspaceFile({
    userId: user.tg_id,
    threadId: thread.id,
    virtualPath: "/marker.txt",
    maxBytes: 1024,
    preserveSource: true,
    threadFiles,
  });
  if (
    !firstExport.sourceCanonicalPath ||
    firstExport.bytes.toString() !== marker
  ) {
    throw new Error("first immutable E2B export was not preserved");
  }
  const replacementMarker = `replacement-${randomUUID()}`;
  const overwrite = await runtime.execute(
    commandRequest(
      user.tg_id,
      thread.id,
      "printf '%s' \"$1\" > marker.txt",
      [replacementMarker],
      threadFiles,
    ),
  );
  if (overwrite.exitCode !== 0)
    throw new Error(
      overwrite.error || overwrite.stderr || "marker overwrite failed",
    );
  const secondExport = await runtime.readWorkspaceFile({
    userId: user.tg_id,
    threadId: thread.id,
    virtualPath: "/marker.txt",
    maxBytes: 1024,
    preserveSource: true,
    threadFiles,
  });
  if (
    !secondExport.sourceCanonicalPath ||
    secondExport.sourceCanonicalPath === firstExport.sourceCanonicalPath
  ) {
    throw new Error(
      "overwritten workspace file reused the previous immutable source",
    );
  }
  const historicalBytes = await runtime.readSourceFile({
    sandboxId,
    userId: user.tg_id,
    threadId: thread.id,
    canonicalPath: firstExport.sourceCanonicalPath,
    maxBytes: 1024,
  });
  if (historicalBytes.toString() !== marker)
    throw new Error("historical E2B source changed after overwrite");

  const outbound = await repos.files.insertFile({
    userId: user.tg_id,
    threadId: thread.id,
    type: "txt",
    contentSha256: firstExport.contentSha256,
    mimeType: "text/plain",
    name: "outbound-local.txt",
    size: firstExport.size,
    isInline: true,
  });
  const [outboundRef] = await repos.files.rememberTelegramFileRefs(
    outbound.id,
    {
      direction: "outbound",
      mediaKind: "document",
      refs: [
        { fileId: "must-not-download", size: firstExport.size, primary: true },
      ],
    },
  );
  const outboundDescriptor: SandboxThreadFile = {
    fileId: outbound.id,
    messageId: null,
    name: outbound.name,
    mimeType: outbound.mime_type,
    expectedSize: outbound.size,
    expectedSha256: outbound.content_sha256,
    telegramRefs: [
      {
        id: outboundRef!.id,
        telegramFileId: outboundRef!.telegram_file_id,
        telegramSize: outboundRef!.telegram_size,
        direction: "outbound",
        mediaKind: "document",
        isPrimary: true,
        lastSeenAt: outboundRef!.last_seen_at,
      },
    ],
  };
  const localOutbound = await runtime.execute(
    commandRequest(
      user.tg_id,
      thread.id,
      `test \"$(cat \"$TELEGRAM_FILES_DIR/${outbound.id}--outbound-local.txt\")\" = \"$1\"`,
      [marker],
      [...threadFiles, outboundDescriptor],
    ),
  );
  if (localOutbound.exitCode !== 0) {
    throw new Error(
      localOutbound.error ||
        localOutbound.stderr ||
        "outbound local artifact reuse failed",
    );
  }
  const sandboxInfo = await Sandbox.getInfo(sandboxId, {
    apiKey: config.E2B_API_KEY,
    requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
  });
  if (sandboxInfo.network?.denyOut?.length) {
    throw new Error(
      `sandbox unexpectedly has outbound deny rules: ${sandboxInfo.network.denyOut.join(", ")}`,
    );
  }
  if (sandboxInfo.allowInternetAccess === false) {
    throw new Error("sandbox internet access is disabled");
  }
  if (sandboxInfo.cpuCount !== 2 || sandboxInfo.memoryMB !== 2048) {
    throw new Error(
      `unexpected custom template resources: ${sandboxInfo.cpuCount} vCPU / ${sandboxInfo.memoryMB} MiB`,
    );
  }
  if (
    sandboxInfo.metadata.template_ref !== (upgradeFrom ?? config.E2B_TEMPLATE)
  ) {
    throw new Error(
      "sandbox metadata does not identify the configured custom template",
    );
  }

  await Sandbox.pause(sandboxId, {
    apiKey: config.E2B_API_KEY,
    requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
    keepMemory: true,
  });
  await runtime.dispose();
  runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });

  const resumed = await runtime.execute(
    commandRequest(
      user.tg_id,
      thread.id,
      [
        'test "$(cat marker.txt)" = "$1"',
        ...telegramSandboxPaths.flatMap((filePath) => [
          `test -s "${filePath}"`,
          `test ! -w "${filePath}"`,
        ]),
        "printf RESUMED",
      ].join("\n"),
      [marker],
      threadFiles,
    ),
  );
  if (resumed.exitCode !== 0 || resumed.stdout !== "RESUMED") {
    throw new Error(
      resumed.error ||
        resumed.stderr ||
        "pause/resume persistence check failed",
    );
  }
  const after = await repos.threadSandboxes.get(
    config.E2B_DEPLOYMENT_ID,
    thread.id,
  );
  if (after?.sandbox_id !== sandboxId)
    throw new Error("thread resumed into a different sandbox");

  let recreatedAfterLoss = false;
  if (threadFiles.length) {
    const lostSandboxId = sandboxId;
    await Sandbox.kill(lostSandboxId, {
      apiKey: config.E2B_API_KEY,
      requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
    });
    await runtime.dispose();
    runtime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
    const recreated = await runtime.execute(
      commandRequest(
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
      ),
    );
    if (recreated.exitCode !== 0 || recreated.stdout !== "RECREATED") {
      throw new Error(
        recreated.error ||
          recreated.stderr ||
          "sandbox recreation restore check failed",
      );
    }
    const recreatedMapping = await repos.threadSandboxes.get(
      config.E2B_DEPLOYMENT_ID,
      thread.id,
    );
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
    const server = await runtime.execute(
      commandRequest(
        user.tg_id,
        thread.id,
        [
          "command -v python3 >/dev/null",
          "mkdir -p website-smoke",
          "cd website-smoke",
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
      ),
    );
    if (server.exitCode !== 0) {
      throw new Error(
        server.error || server.stderr || "website server failed to start",
      );
    }
    const published = await runtime.publishWebsite({
      userId: user.tg_id,
      threadId: thread.id,
      port: 3000,
      siteDirectory: "/website-smoke",
      path: "/",
      threadFiles,
    });
    if (
      published.sandboxId !== sandboxId ||
      published.pausesAfterMinutes !== 15
    ) {
      throw new Error(
        "published website did not retain the thread sandbox or 15-minute idle policy",
      );
    }
    const response = await fetch(published.url, {
      signal: AbortSignal.timeout(config.E2B_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || (await response.text()) !== websiteMarker) {
      throw new Error(`published website returned HTTP ${response.status}`);
    }
    publishedUrl = published.url;
  } finally {
    lease.release();
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        sandboxId,
        template: config.E2B_TEMPLATE,
        sameSandboxAfterResume: true,
        workspacePersisted: true,
        immutableSourceVersions: true,
        outboundLocalReuse: true,
        telegramFilesReadOnly: true,
        botMediatedTelegramRestoreTested: Boolean(threadFiles.length),
        restoredTelegramFiles: threadFiles.length,
        recreatedAfterLoss,
        zipToolTested: true,
        toolContractPassed: true,
        officeContractOutput: contract.stdout,
        officeBackendsChecked: true,
        upgradedFrom: upgradeFrom ?? null,
        officePreviewRendered: Boolean(officePreview),
        officePreviewBytes: officePreview.images.reduce(
          (sum, image) => sum + image.size,
          0,
        ),
        officePreviewMediaType: officePreview.images[0]?.media_type,
        chromiumIntentionallyAbsent: true,
        cpuCount: sandboxInfo.cpuCount,
        memoryMB: sandboxInfo.memoryMB,
        unrestrictedEgress: true,
        websitePublished: true,
        websiteUrl: publishedUrl!,
        websiteIdlePauseMinutes: 15,
      },
      null,
      2,
    )}\n`,
  );
} finally {
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
