import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { sandboxWorkspaceFile } from "../src/e2b/paths.js";
import { asRecord } from "../src/util/records.js";

// Deliberately use an ordinary request, without hints about images, tools, or QA.
const prompt =
  process.env.PRESENTATION_PROMPT ??
  'сделай презентацию на тему "Город будущего" Токио';
const outputDirectory =
  process.env.PRESENTATION_OUTPUT_DIR ??
  (await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-presentation-")));
await fs.mkdir(outputDirectory, { recursive: true });
const agentDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "ai-tg-presentation-session-"),
);
const config = {
  ...loadConfig(),
  DB_URL: "sqlite::memory:",
  PI_CODING_AGENT_DIR: agentDir,
  E2B_DEPLOYMENT_ID: `presentation-smoke-${randomUUID()}`,
  BROWSER_USE_API_KEY: undefined,
};
const logger = createLogger(config);
const db = createDatabase(config, logger);
let pi: PiRuntimeManager | undefined;
let commands: ThreadE2BSandboxRuntimeManager | undefined;
let sandboxId: string | undefined;
try {
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({
    tgId: 9_999_004,
    firstName: "Presentation smoke",
    lang: "ru",
  });
  const thread = await repos.threads.create({
    userId: user.tg_id,
    topicId: null,
    title: "Presentation smoke",
  });
  commands = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
  pi = new PiRuntimeManager({
    config,
    db,
    repos,
    logger,
    commandRuntime: commands,
  });
  const runtime = await pi.runtime(thread, user);
  await runtime.bridge.beginTurn({
    api: {} as never,
    chatId: user.tg_id,
    resolveFile: async () => {
      throw new Error("No input attachments");
    },
  });
  await runtime.session.prompt(prompt, {
    expandPromptTemplates: false,
    source: "extension",
  });
  const messages = runtime.session.messages;
  const toolResults = messages.filter(
    (message) => message.role === "toolResult",
  );
  await fs.writeFile(
    path.join(outputDirectory, "trace.json"),
    JSON.stringify(
      messages.map((message) => {
        if (message.role === "toolResult")
          return {
            role: message.role,
            tool: message.toolName,
            error: message.isError,
            details: message.details,
          };
        if (message.role === "assistant" || message.role === "user")
          return {
            role: message.role,
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.filter((part) => part.type !== "image"),
          };
        return { role: message.role };
      }),
      null,
      2,
    ),
  );
  const attachments = runtime.bridge.attachments;
  if (
    attachments.length !== 1 ||
    path.extname(attachments[0]!.name).toLowerCase() !== ".pptx"
  )
    throw new Error(
      `Expected only one presentation, got ${attachments.map((file) => file.name).join(", ")}. Inspect ${outputDirectory}/trace.json`,
    );
  const file = attachments[0]!;
  if (
    /LibreOffice|source_sha256|structural checks|visually reviewed/i.test(
      file.caption ?? "",
    )
  )
    throw new Error("Technical validation caption leaked into delivery");
  const exported = await commands.readWorkspaceFile({
    userId: user.tg_id,
    threadId: thread.id,
    virtualPath: file.sourceVirtualPath!,
    maxBytes: 20 * 1024 * 1024,
  });
  sandboxId = exported.sandboxId;
  const filename = path.join(outputDirectory, file.name);
  await fs.writeFile(filename, exported.bytes);
  const approved = await runtime.bridge.officeValidation.validate(
    file.sourceVirtualPath!,
  );
  if (!approved.approved)
    throw new Error("Presentation lacks complete explicit visual approval");
  for (let page = 1; page <= approved.page_count; page += 4) {
    const pages = Array.from(
      { length: Math.min(4, approved.page_count - page + 1) },
      (_, i) => page + i,
    );
    const preview = await runtime.bridge.officeValidation.preview(
      file.sourceVirtualPath!,
      pages,
    );
    for (const image of preview.images)
      await fs.writeFile(
        path.join(outputDirectory, `slide-${image.page}.jpg`),
        Buffer.from(image.image_base64, "base64"),
      );
  }
  // Export a PDF for independent visual comparison, without sending it in chat.
  const rendered = await commands.execute({
    userId: user.tg_id,
    threadId: thread.id,
    command: "office-files",
    args: [
      "validate",
      sandboxWorkspaceFile(file.sourceVirtualPath!),
      "/home/user/workspace/.presentation-smoke",
    ],
    env: {},
    stdin: "",
    workingDir: "/home/user/workspace",
    timeoutMs: 120_000,
    maxOutputChars: 12_000,
  });
  if (rendered.exitCode !== 0)
    throw new Error(rendered.stderr || "PDF export failed");
  const pdfPath = asRecord(JSON.parse(rendered.stdout))?.pdf_path;
  if (typeof pdfPath !== "string")
    throw new Error("PDF export returned no file");
  const pdf = await commands.readWorkspaceFile({
    userId: user.tg_id,
    threadId: thread.id,
    virtualPath: pdfPath,
    maxBytes: 20 * 1024 * 1024,
  });
  await fs.writeFile(path.join(outputDirectory, "presentation.pdf"), pdf.bytes);
  const inspector = fileURLToPath(
    new URL("./inspect-presentation.py", import.meta.url),
  );
  const metrics = JSON.parse(
    execFileSync("python3", [inspector, filename], { encoding: "utf8" }),
  );
  const result = {
    prompt,
    outputDirectory,
    file: file.name,
    caption: file.caption,
    approved: approved.approved,
    metrics,
    tools: toolResults.map((message) => message.toolName),
    visualReviewRequired: true,
    telegramMessagesSent: false,
  };
  await fs.writeFile(
    path.join(outputDirectory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  if (metrics.slidesWithLargeImages < 2)
    throw new Error(
      `City presentation has insufficient substantial imagery. Review ${outputDirectory}`,
    );
  process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
} finally {
  await pi?.dispose();
  await commands?.dispose();
  if (!sandboxId)
    sandboxId = (
      await createRepos(db.db, db.search)
        .threadSandboxes.get(config.E2B_DEPLOYMENT_ID, 1)
        .catch(() => undefined)
    )?.sandbox_id;
  if (sandboxId)
    await Sandbox.kill(sandboxId, { apiKey: config.E2B_API_KEY }).catch(
      () => undefined,
    );
  await db.destroy();
  await fs.rm(agentDir, { recursive: true, force: true });
}
