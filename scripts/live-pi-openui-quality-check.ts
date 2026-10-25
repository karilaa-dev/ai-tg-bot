import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Api } from "grammy";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { resolveCodexAuthFile } from "../src/pi/codexCliCredentials.js";
import { runPiPromptWithTimeout } from "../src/ai/agentTurnEngine.js";
import { currentTurnAssistantResult } from "../src/ai/currentTurnResult.js";
import { validateOpenUi } from "../src/openui/validate.js";
import { webFileSource } from "../src/web/file-source.js";
import { sha256Hex } from "../src/files/hash.js";
import type { CommandRuntime } from "../src/sandbox/types.js";
import type { OpenUiLanguage } from "../src/openui/language.js";

// Real model and application prompt; supplied evidence keeps this check independent of search results.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openui-quality-"));
const base = loadConfig();
const config = { ...base, DB_URL: "sqlite::memory:", BOT_TOKEN: "999999999:disposable-ui-check", PI_CODING_AGENT_DIR: directory,
  CODEX_AUTH_FILE: path.join(directory, "codex-auth.json"), BROWSER_USE_API_KEY: undefined, LOG_LEVEL: "error" as const };
const logger = createLogger(config);
const db = createDatabase(config, logger);
const unavailable = async (): Promise<never> => { throw new Error("This supplied-evidence check has no sandbox or external actions."); };
const commands: CommandRuntime = { materializeFiles: unavailable, execute: unavailable, readWorkspaceFile: unavailable,
  readSourceFile: unavailable, publishWebsite: unavailable, dispose: async () => {} };
const pi = new PiRuntimeManager({ config, db, logger, repos: createRepos(db.db, db.search), commandRuntime: commands });
const results: Array<Record<string, unknown>> = [];
let telegramCalls = 0;
let failed = false;
const api = new Api(config.BOT_TOKEN);
api.config.use(async () => { telegramCalls++; throw new Error("Telegram calls forbidden in this check."); });
const photoUrl = "https://dtf-cdn.com/images/production/9f2d7a4241f4091c210bda3931c6e0513794c91a-2500x2500.jpg?w=1920&q=75&fit=clip&auto=format";

try {
  for (const [from, to] of [[path.join(base.PI_CODING_AGENT_DIR, "auth.json"), path.join(directory, "auth.json")], [resolveCodexAuthFile(base), config.CODEX_AUTH_FILE]]) {
    try { await fs.copyFile(from!, to!); await fs.chmod(to!, 0o600); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const initial = await repos.users.ensure({ tgId: 9_999_157, firstName: "Quality check", lang: "en" });
  const user = await repos.users.setMemoryEnabled(initial.tg_id, false);
  const cases = [
    { name: "causality", accountLanguage: "ru", answerLanguage: "en", prompt: "Explain how this incident happened and why the fix worked. Investigation findings: an automatic certificate renewal job failed; the certificate then expired, clients rejected TLS connections before sending requests, and a new certificate restored connections. The application kept running throughout. The connection outage lasted 12 minutes; zero records were lost. These supplied facts are the complete investigation; no external research is needed." },
    { name: "recommendations", accountLanguage: "ru", answerLanguage: "en", prompt: "Help me choose between these two places for dinner, using only the supplied notes and photograph. Din Tai Fung: dumplings, a lively shared meal; official page https://dtf.com/en-us/locations/bellevue. Carmine’s Bellevue: Italian, a quieter longer dinner; official page https://www.carminesbellevue.com/. Prices, ratings and opening hours have not been checked. The attached photograph is a Din Tai Fung brand entrance photo, not verified as the Bellevue location. Do not assume current availability. Which fits each kind of evening?" },
    { name: "russian", accountLanguage: "en", answerLanguage: "ru", prompt: "Объясни, как произошёл этот сбой и почему исправление помогло. Данные расследования: автоматическое обновление сертификата не сработало; сертификат истёк; клиенты отклоняли TLS-соединения до отправки запросов; установка нового сертификата восстановила соединения. Само приложение продолжало работать. Сбой длился 12 минут, потеряно 0 записей. Это все проверенные факты, дополнительный поиск не нужен." },
    { name: "simple", accountLanguage: "ru", answerLanguage: "en", prompt: "Give me three examples of citrus fruit. Just their names." },
  ] satisfies { name: string; accountLanguage: OpenUiLanguage; answerLanguage: OpenUiLanguage; prompt: string }[];
  for (const scenario of cases) {
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, origin: "web", title: scenario.name });
    let photo: Buffer | undefined;
    let fileId: number | undefined;
    const current = await repos.messages.insert({ threadId: thread.id, role: "user", content: scenario.prompt, textPlain: scenario.prompt });
    if (scenario.name === "recommendations") {
      const response = await fetch(photoUrl, { signal: AbortSignal.timeout(30_000) });
      assert(response.ok, "Reference photograph must be retrieved successfully.");
      photo = Buffer.from(await response.arrayBuffer());
      const file = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: current.id, type: "image", name: "din-tai-fung.jpg",
        size: photo.length, contentSha256: sha256Hex(photo), mimeType: "image/jpeg", summary: "Din Tai Fung brand entrance and bar; Bellevue location unverified.", isInline: true });
      fileId = file.id;
      await repos.files.rememberSource(file.id, webFileSource(file.id, "image/jpeg"));
    }
    const runtime = await pi.runtime(thread, { ...user, lang: scenario.accountLanguage });
    await runtime.bridge.beginTurn({ api, chatId: user.tg_id, userMessageId: current.id, currentFileIds: fileId ? [fileId] : [],
      resolveFile: async file => {
        assert(photo && file.id === fileId);
        return { bytes: photo, size: photo.length, mimeType: "image/jpeg", contentSha256: sha256Hex(photo), source: webFileSource(file.id, "image/jpeg") };
      } });
    const start = runtime.session.messages.length;
    const started = Date.now();
    const prompt = scenario.prompt + (fileId ? `\nThe supplied photograph is existing chat file #${fileId}.` : "");
    try {
      await runPiPromptWithTimeout(runtime.session, prompt, 180_000);
      const messages = runtime.session.messages.slice(start);
      const result = currentTurnAssistantResult(messages);
      const checks: string[] = [];
      if (!result.completed || !result.text.trim()) checks.push("Missing completed accompanying answer");
      if (result.openui) validateOpenUi(result.openui);
      if (result.openui && result.openuiLanguage !== scenario.answerLanguage) checks.push("Visual language does not match the requested response language");
      if (scenario.name === "causality" && (!result.openui?.includes("Flow(") || !result.openui.includes('"issue"'))) checks.push("Missing useful causal flow/failure emphasis");
      if (scenario.name === "recommendations" && (!result.openui?.includes("ItemList(") || !result.openui.includes(`file:${fileId}`) || !result.openui.includes("Link("))) checks.push("Missing recommendations with supplied photograph and sources");
      if (scenario.name === "simple" && result.openui) checks.push("Unnecessary UI for a plain list");
      const models = [...new Set(messages.flatMap(message => message.role === "assistant" ? [`${message.provider}/${message.model}`] : []))];
      results.push({ scenario: scenario.name, accountLanguage: scenario.accountLanguage, answerLanguage: scenario.answerLanguage, milliseconds: Date.now() - started, models, checks, result,
        tools: messages.flatMap(message => message.role === "toolResult" ? [{ name: message.toolName, error: message.isError }] : []) });
      failed ||= checks.length > 0;
      process.stdout.write(`${scenario.name}: ${checks.length ? checks.join("; ") : "PASS"}\n`);
    } finally { await runtime.bridge.endTurn(); }
  }
} catch (error) { failed = true; results.push({ error: String(error) }); }
finally {
  await pi.dispose();
  await db.destroy();
  await fs.rm(directory, { recursive: true, force: true });
  failed ||= telegramCalls !== 0;
  await fs.writeFile("/tmp/ai-tg-openui-quality-live.md", `# Real-model OpenUI quality check\n\nSupplied-evidence fixture; no fresh search, final delivery or Telegram requests.\n\n\`\`\`json\n${JSON.stringify({ ok: !failed, telegramCalls, results, temporarySessionsRemoved: true }, null, 2)}\n\`\`\`\n`, { mode: 0o600 });
}
if (failed) process.exitCode = 1;
