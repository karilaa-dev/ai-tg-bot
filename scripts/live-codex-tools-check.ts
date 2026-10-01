import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { createCodexCompactionExtension } from "../src/pi/codexCompaction.js";
import { searchCodexWeb } from "../src/pi/codexWebSearch.js";
import { asRecord } from "../src/util/records.js";

const config = loadConfig();
const logger = createLogger(config);
// This check never opens Telegram or an E2B sandbox and uses a temporary Pi session.
const manager = new PiRuntimeManager({ config, logger, db: undefined as never, repos: undefined as never });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-codex-check-"));
let session: AgentSession | undefined;
try {
  await manager.initialize();
  if (!manager.providerRouter.codexConfigured()) throw new Error("Codex OAuth is required for this check.");
  const runtime = { config, logger, modelRegistry: manager.modelRegistry, providerRouter: manager.providerRouter };
  const search = await searchCodexWeb(runtime, "Find the official OpenAI documentation for Responses API compaction.", 3);
  if (!search.results.some(result => /openai\.com/.test(new URL(result.url).hostname))) throw new Error("Search returned no official documentation source.");
  process.stdout.write("Codex hosted web search passed.\n");
  const sessionManager = SessionManager.create(process.cwd(), directory);
  sessionManager.appendMessage({ role: "user", content: "Remember this project fact for later: the release password is ORCHID-742 and the deployment region is Helsinki.", timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recorded." }],
    api: "openai-codex-responses", provider: "openai-codex", model: config.CODEX_MODEL, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  sessionManager.appendMessage({ role: "user", content: "Keep the recorded project facts. " + "Unrelated filler. ".repeat(250), timestamp: Date.now() });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 128 }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Answer concisely and preserve project facts.", extensionFactories: [createCodexCompactionExtension(runtime)] });
  await resourceLoader.reload();
  const create = async (saved: SessionManager) => (await createAgentSession({ cwd: process.cwd(), agentDir: directory,
    modelRuntime: manager.modelRuntime, model: manager.providerRouter.mainModel, thinkingLevel: "low", noTools: "all",
    resourceLoader, sessionManager: saved, settingsManager })).session;
  session = await create(sessionManager);
  await session.compact();
  const entry = sessionManager.getBranch().findLast(item => item.type === "compaction");
  if (!asRecord(entry?.details)?.codexCompaction) throw new Error("Compaction fell back to a text summary; no server checkpoint was saved.");
  const file = session.sessionFile!;
  session.dispose();
  session = await create(SessionManager.open(file, directory));
  await session.prompt("What are the release password and deployment region? Reply with just those two values.", { expandPromptTemplates: false });
  const answer = session.messages.findLast(message => message.role === "assistant");
  const text = answer?.role === "assistant" ? answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") : "";
  if (answer?.role !== "assistant" || answer.provider !== "openai-codex" || !text.includes("ORCHID-742") || !text.includes("Helsinki")) {
    throw new Error(`Checkpoint recall failed: ${text || (answer?.role === "assistant" && answer.errorMessage)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, searchSources: search.results.length, serverCompaction: true, resumedRecall: true })}\n`);
} finally {
  session?.dispose();
  await manager.dispose();
  await fs.rm(directory, { recursive: true, force: true });
}
