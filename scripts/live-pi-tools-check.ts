import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../test/fixtures/pi-v2/runtime.js";
import { currentTurnAssistantResult } from "../src/ai/currentTurnResult.js";
import { runPiPromptWithTimeout } from "../src/ai/agentTurnEngine.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-pi-tools-"));
const config = { ...loadConfig(), DB_URL: "sqlite::memory:", PI_CODING_AGENT_DIR: directory };
const db = createDatabase(config);
let pi: PiRuntimeManager | undefined;

try {
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9_999_021, firstName: "Pi tools smoke", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi tools smoke" });
  pi = new PiRuntimeManager({ config, db, repos, logger: createLogger(config) });
  await pi.initialize();
  if (process.env.PI_SMOKE_FORCE_OPENROUTER === "1") pi.providerRouter.circuit.recordFailure();
  const runtime = await pi.runtime(thread, user);
  await runtime.bridge.beginTurn({ api: {} as never, chatId: user.tg_id, resolveFile: async () => { throw new Error("No attachments in this check."); } });
  const initialTools = runtime.session.getActiveToolNames();
  const eagerTools = runtime.session.getAllTools().filter((tool) => !["codemode", "tool_search"].includes(tool.name));
  const declaration = ({ name, description, parameters }: { name: string; description: string; parameters: unknown }) => ({ name, description, parameters });
  const eagerToolSchemaChars = JSON.stringify(eagerTools.map(declaration)).length;
  let initialToolSchemaChars = 0;
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant" && !initialToolSchemaChars) {
      const context = runtime.session.sessionManager.buildSessionContext();
      initialToolSchemaChars = JSON.stringify(getCurrentTools(context.messages as TranscriptContext["messages"]).map(declaration)).length;
    }
  });
  try {
    await runPiPromptWithTimeout(runtime.session,
      "First call codemode to run tools.search_thread for 'tools-smoke-alpha' and 'tools-smoke-beta' in parallel with Promise.allSettled. Print their result counts. Then use tool_search with query 'read_file_section' and limit 1 to load that specialist tool, without reading a file. Finally use finish_response alone with text exactly PI_TOOLS_OK. Do not use any other tools.",
      120_000);
  } finally { unsubscribe(); }
  const messages = runtime.session.messages;
  const result = currentTurnAssistantResult(messages);
  if (!result.completed || result.text !== "PI_TOOLS_OK") throw new Error(`Unexpected completion: ${JSON.stringify(result)}`);
  const script = messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
  if (!script || script.role !== "toolResult" || script.isError || script.nestedCalls?.calls.filter((call) => call.name === "search_thread" && call.status === "ok").length !== 2) {
    throw new Error("Codemode did not complete both nested research calls.");
  }
  if (!runtime.session.getActiveToolNames().includes("read_file_section")) throw new Error("Specialist discovery failed.");
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  const requiredProvider = process.env.PI_SMOKE_REQUIRE_PROVIDER?.trim();
  if (requiredProvider && assistant?.provider !== requiredProvider) throw new Error(`Expected ${requiredProvider}, received ${assistant?.provider}`);
  console.log(JSON.stringify({
    ok: true, provider: assistant?.provider, model: assistant?.model, initialTools,
    initialToolSchemaChars, eagerToolSchemaChars,
    declarationReductionPercent: Math.round((1 - initialToolSchemaChars / eagerToolSchemaChars) * 100),
    nestedResearchCalls: 2, discoveredTool: "read_file_section", budget: runtime.bridge.currentTurnBudget()?.snapshot(),
  }, null, 2));
} finally {
  await pi?.dispose();
  await db.destroy();
  await fs.rm(directory, { recursive: true, force: true });
}
