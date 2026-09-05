import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";

// Exercise the application's prompts and tool schemas, stopping before any action
// except reading an approved skill. No images, sandboxes, or Telegram messages.
const scenarios = [
  { prompt: "Create collage of 20 arts with kasane teto", generate: false },
  { prompt: "Create a mood board for a coastal bedroom", generate: false },
  { prompt: "Make a presentation about ocean wildlife", generate: false },
  { prompt: "Draw a watercolor fox reading under a mushroom", generate: true },
  { prompt: "Generate an original illustration of an underwater city for my presentation", generate: true },
];
const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-image-intent-"));
const config = {
  ...loadConfig(),
  DB_URL: "sqlite::memory:",
  PI_CODING_AGENT_DIR: agentDir,
  BROWSER_USE_API_KEY: undefined,
};
const logger = createLogger(config);
const db = createDatabase(config, logger);
let commands: ThreadE2BSandboxRuntimeManager | undefined;
let pi: PiRuntimeManager | undefined;
try {
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  commands = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
  pi = new PiRuntimeManager({ config, db, repos, logger, commandRuntime: commands });
  const user = await repos.users.ensure({ tgId: 9_999_005, firstName: "Image intent check", lang: "en" });
  let failed = 0;
  for (const scenario of scenarios) {
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Image intent check" });
    const runtime = await pi.runtime(thread, user);
    await runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => { throw new Error("No attachments"); },
    });
    const agent = runtime.session.agent;
    const beforeToolCall = agent.beforeToolCall;
    let action: string | undefined;
    agent.beforeToolCall = async (context, signal) => {
      if (context.toolCall.name === "read") return beforeToolCall?.(context, signal);
      action ??= context.toolCall.name;
      agent.abort();
      return { block: true, reason: "Intent check ends before tool execution." };
    };
    const timer = setTimeout(() => agent.abort(), 120_000);
    try {
      await runtime.session.prompt(scenario.prompt, {
        expandPromptTemplates: false,
        source: "extension",
      });
    } finally {
      clearTimeout(timer);
      await runtime.bridge.endTurn();
    }
    const passed = scenario.generate
      ? action === "generate_image"
      : action === "web_search" || action === "web_extract" || action === "bash";
    if (!passed) failed++;
    process.stdout.write(JSON.stringify({ ...scenario, action: action ?? null, passed }) + "\n");
  }
  assert.equal(failed, 0, `${failed} image intent scenarios failed`);
} finally {
  await pi?.dispose();
  await commands?.dispose();
  await db.destroy();
  await fs.rm(agentDir, { recursive: true, force: true });
  closeOpenAICodexWebSocketSessions();
}
