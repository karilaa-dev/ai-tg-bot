import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { sandboxWorkspaceFile } from "../src/e2b/paths.js";
import { asRecord } from "../src/util/records.js";

const agentDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "ai-tg-bot-office-image-"),
);
const base = loadConfig();
const config = {
  ...base,
  DB_URL: "sqlite::memory:",
  PI_CODING_AGENT_DIR: agentDir,
  E2B_DEPLOYMENT_ID: `office-image-smoke-${randomUUID()}`,
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
    tgId: 9_999_002,
    firstName: "Office image smoke",
    lang: "en",
  });
  const thread = await repos.threads.create({
    userId: user.tg_id,
    topicId: null,
    title: "Office image smoke",
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
  const cases = [
    {
      name: "image-only",
      prompt:
        "Generate a simple blue circle on a white background. Inspect the result yourself, then use finish_response to send just that image with a short caption describing what you actually see. Do not create any other deliverable.",
      extensions: [".png", ".jpg", ".webp"],
    },
    {
      name: "deck-only",
      prompt:
        "Create a two-slide editable PowerPoint about a quiet forest. Generate one new original illustration for this deck with generate_image. Inspect the actual image returned, embed its saved original in the deck, and include a short caption describing what you see in it. Use the pptxgenjs skill, validate the saved Office file, render and visually review both slides, record passing reviews, then finish_response with only the PPTX and a brief description of its content. Do not send the artwork separately.",
      extensions: [".pptx"],
    },
  ];
  const results = [];
  for (const scenario of cases) {
    await runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => {
        throw new Error("No chat references supplied");
      },
    });
    const start = runtime.session.messages.length;
    await runtime.session.prompt(scenario.prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });
    const messages = runtime.session.messages.slice(start);
    const toolResults = messages.filter(
      (message) => message.role === "toolResult",
    );
    const imageIndex = toolResults.findIndex(
      (message) => message.toolName === "generate_image" && !message.isError,
    );
    const image = imageIndex >= 0 ? toolResults[imageIndex] : undefined;
    if (!image?.content.some((part) => part.type === "image"))
      throw new Error(
        `${scenario.name}: generated image was not supplied to model vision`,
      );
    if (
      !messages.some(
        (message, index) =>
          message.role === "toolResult" &&
          message === image &&
          messages.slice(index + 1).some((later) => later.role === "assistant"),
      )
    )
      throw new Error(
        `${scenario.name}: no model continuation after image generation`,
      );
    if (
      !toolResults
        .slice(imageIndex + 1)
        .some(
          (message) =>
            message.toolName === "finish_response" &&
            asRecord(message.details)?.completed === true,
        )
    )
      throw new Error(`${scenario.name}: did not finish after generation`);
    const attachments = runtime.bridge.attachments;
    if (
      attachments.length !== 1 ||
      !scenario.extensions.includes(path.extname(attachments[0]!.name))
    )
      throw new Error(
        `${scenario.name}: unexpected deliverables: ${attachments.map((file) => file.name).join(", ")}`,
      );
    if (scenario.name === "deck-only") {
      if (
        !toolResults.some(
          (message) =>
            message.toolName === "validate_office_file" &&
            asRecord(message.details)?.approved === true,
        )
      )
        throw new Error("Deck lacked passed validation and visual reviews");
      const assetPath = asRecord(image.details)?.path;
      if (typeof assetPath !== "string")
        throw new Error("Image has no workspace path");
      const embedded = await commands.execute({
        userId: user.tg_id,
        threadId: thread.id,
        command: "office-python",
        args: [
          "-c",
          'import sys,zipfile,pathlib; data=pathlib.Path(sys.argv[1]).read_bytes(); z=zipfile.ZipFile(sys.argv[2]); assert any(z.read(n)==data for n in z.namelist() if n.startswith("ppt/media/"))',
          sandboxWorkspaceFile(assetPath),
          sandboxWorkspaceFile(attachments[0]!.sourceVirtualPath!),
        ],
        env: {},
        stdin: "",
        workingDir: "/home/user/workspace",
        timeoutMs: 30_000,
        maxOutputChars: 1000,
      });
      if (embedded.exitCode !== 0)
        throw new Error(
          "Saved original image was not embedded in the deck: " +
            embedded.stderr,
        );
    }
    sandboxId = (
      await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, thread.id)
    )?.sandbox_id;
    results.push({
      scenario: scenario.name,
      toolCalls: toolResults.length,
      delivered: attachments.map((file) => file.name),
      imageProvidedToModel: true,
      continuedAfterGeneration: true,
    });
    await runtime.bridge.endTurn();
  }
  process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + "\n");
} finally {
  await pi?.dispose();
  await commands?.dispose();
  // Locate a sandbox even if the workflow failed before producing an attachment.
  if (!sandboxId) {
    const repos = createRepos(db.db, db.search);
    const rows = await repos.threadSandboxes
      .get(config.E2B_DEPLOYMENT_ID, 1)
      .catch(() => undefined);
    sandboxId = rows?.sandbox_id;
  }
  if (sandboxId)
    await Sandbox.kill(sandboxId, { apiKey: config.E2B_API_KEY }).catch(
      () => undefined,
    );
  await db.destroy();
  await fs.rm(agentDir, { recursive: true, force: true });
}
