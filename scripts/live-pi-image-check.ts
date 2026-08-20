import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { createGenerateImagePiTool } from "../src/pi/imageExtension.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-image-"));
const baseConfig = loadConfig();
const config = { ...baseConfig, DB_URL: "sqlite::memory:", PI_CODING_AGENT_DIR: agentDir };
const logger = createLogger(config);
const db = createDatabase(config, logger);
let pi: PiRuntimeManager | undefined;

try {
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9_999_002, firstName: "Pi image smoke", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi image smoke" });
  pi = new PiRuntimeManager({ config, db, repos, logger });
  const runtime = await pi.runtime(thread, user);
  runtime.bridge.beginTurn({
    api: {} as never,
    chatId: user.tg_id,
    resolveFile: async () => {
      throw new Error("The image smoke check did not supply a reference image.");
    },
  });
  const tool = createGenerateImagePiTool(runtime.bridge);
  const result = await tool.execute(
    "live-image-smoke",
    {
      prompt: "A simple flat blue circle centered on a transparent background. No text.",
      mode: "generate",
      output_format: "png",
      caption: "Pi image smoke check",
    },
    undefined,
    () => undefined,
    {} as never,
  );
  const details = result.details as { provider?: string; model?: string; file_id?: number } | undefined;
  const attachment = runtime.bridge.attachments.at(-1);
  if (details?.provider !== "codex") {
    throw new Error(`Expected Codex image generation, received ${details?.provider ?? "unknown"}.`);
  }
  if (!attachment || attachment.origin !== "generated_image" || attachment.mimeType !== "image/png" || !attachment.data) {
    throw new Error("Codex did not produce a PNG image attachment.");
  }
  const imageBytes = attachment.data;
  const pngSignature = imageBytes.subarray(0, 8).toString("hex");
  if (pngSignature !== "89504e470d0a1a0a") throw new Error("Generated attachment is not a valid PNG stream.");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    codexConfigured: pi.providerRouter.codexConfigured(),
    provider: details.provider,
    model: details.model,
    fileId: details.file_id,
    mimeType: attachment.mimeType,
    bytes: imageBytes.length,
  }, null, 2)}\n`);
} finally {
  await pi?.dispose();
  await db.destroy();
  await fs.rm(agentDir, { recursive: true, force: true });
}
