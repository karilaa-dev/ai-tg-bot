import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";

const baseConfig = loadConfig();
const config = { ...baseConfig, DB_URL: "sqlite::memory:" };
const logger = createLogger(config);
const db = createDatabase(config, logger);
let pi: PiRuntimeManager | undefined;

try {
  await db.migrate();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9_999_001, firstName: "Pi smoke", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi smoke" });
  pi = new PiRuntimeManager({ config, db, repos, logger });
  if (process.env.PI_SMOKE_FORCE_OPENROUTER === "1") pi.providerRouter.circuit.recordFailure();
  const runtime = await pi.runtime(thread, user);
  runtime.bridge.beginTurn({
    api: {} as never,
    chatId: user.tg_id,
    redownloadFile: async () => {
      throw new Error("The smoke check did not supply an image.");
    },
  });
  const prompt = process.env.PI_SMOKE_PROMPT?.trim()
    || "Reply with exactly PI_SMOKE_OK and no other text.";
  await runtime.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
  const assistant = lastAssistant(runtime.session.messages);
  const text = assistant?.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("")
    .trim();
  if (!assistant || assistant.stopReason === "error" || !text) {
    throw new Error(assistant?.errorMessage || "Pi returned no assistant text.");
  }
  if (!process.env.PI_SMOKE_PROMPT?.trim() && text !== "PI_SMOKE_OK") {
    throw new Error(`Unexpected smoke-check response: ${text}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    forcedOpenRouter: process.env.PI_SMOKE_FORCE_OPENROUTER === "1",
    provider: assistant.provider,
    model: assistant.model,
    sessionFile: runtime.session.sessionFile,
    text,
  }, null, 2)}\n`);
} finally {
  await pi?.dispose();
  await db.destroy();
}

function lastAssistant(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}
