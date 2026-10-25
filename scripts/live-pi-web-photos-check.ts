import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createParser } from "@openuidev/lang-core";
import { Api } from "grammy";
import { Sandbox } from "e2b";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { ThreadE2BSandboxRuntimeManager } from "../src/e2b/threadRuntimeManager.js";
import { sandboxWorkspaceFile } from "../src/e2b/paths.js";
import { detectImageMediaType } from "../src/files/mediaType.js";
import { sha256Hex } from "../src/files/hash.js";
import type { CreatedFileAttachment } from "../src/files/types.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { resolveCodexAuthFile } from "../src/pi/codexCliCredentials.js";
import { runPiPromptWithTimeout } from "../src/ai/agentTurnEngine.js";
import { currentTurnAssistantResult } from "../src/ai/currentTurnResult.js";
import { validateOpenUi } from "../src/openui/validate.js";
import { openUiLibrary, UiImage } from "../src/openui/library.js";
import { asRecord } from "../src/util/records.js";

const photoUrl = "https://dtf-cdn.com/images/production/9f2d7a4241f4091c210bda3931c6e0513794c91a-2500x2500.jpg?w=1920&q=75&fit=clip&auto=format";
const reportPath = "/tmp/ai-tg-photo-live-check.md";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-web-photos-"));
const base = loadConfig();
const config = {
  ...base,
  DB_URL: "sqlite::memory:",
  BOT_TOKEN: "999999999:disposable-photo-smoke",
  PI_CODING_AGENT_DIR: directory,
  CODEX_AUTH_FILE: path.join(directory, "codex-auth.json"),
  E2B_DEPLOYMENT_ID: `web-photos-smoke-${randomUUID()}`,
  BROWSER_USE_API_KEY: undefined,
};
const logger = createLogger(config);
const db = createDatabase(config, logger);
const startedAt = Date.now();
const evidence: Record<string, unknown> = {
  startedAt: new Date(startedAt).toISOString(),
  prompt: "Show some pictures",
  fixture: "Synthetic prior restaurant recommendation, with an official reference photo supplied to avoid repeating web search.",
  referencePhotoUrl: photoUrl,
  template: config.E2B_TEMPLATE,
  deployment: config.E2B_DEPLOYMENT_ID,
  database: config.DB_URL,
};
let pi: PiRuntimeManager | undefined;
let commands: ThreadE2BSandboxRuntimeManager | undefined;
let runtime: Awaited<ReturnType<PiRuntimeManager["runtime"]>> | undefined;
let threadId: number | undefined;
let sandboxId: string | undefined;
let telegramRequests = 0;
let failure: unknown;
let turnStart = 0;
const cleanupErrors: string[] = [];

try {
  await copyCredentialIfPresent(path.join(base.PI_CODING_AGENT_DIR, "auth.json"), path.join(directory, "auth.json"));
  await copyCredentialIfPresent(resolveCodexAuthFile(base), config.CODEX_AUTH_FILE);
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9_999_156, firstName: "Web photos smoke", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, origin: "web", title: "Restaurant photos smoke" });
  threadId = thread.id;
  const priorQuestion = "Recommend somewhere for dumplings. If I ask for pictures, use the supplied official restaurant photo; one verified photo is enough for now.";
  const priorAnswer = `I recommend Din Tai Fung for xiao long bao and a dumpling-focused meal. Official restaurant photo available from the prior search: ${photoUrl}. This is a source reference, not an attached file yet.`;
  const sessionDirectory = path.join(directory, "sessions", "smoke");
  await fs.mkdir(sessionDirectory, { recursive: true });
  const seed = SessionManager.create(process.cwd(), sessionDirectory);
  seed.appendMessage({ role: "user", content: priorQuestion, timestamp: startedAt - 2_000 });
  seed.appendMessage({
    role: "assistant", content: [{ type: "text", text: priorAnswer }],
    api: "openai-codex-responses", provider: "openai-codex", model: config.CODEX_MODEL,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: startedAt - 1_000,
  });
  const seedFile = seed.getSessionFile();
  assert(seedFile, "Seed transcript must live in the disposable directory.");
  await repos.threads.setPiSession(thread.id, seedFile, seed.getSessionId());
  await repos.messages.insert({ threadId: thread.id, role: "user", content: priorQuestion, textPlain: priorQuestion });
  await repos.messages.insert({ threadId: thread.id, role: "assistant", content: priorAnswer, textPlain: priorAnswer });
  const current = await repos.messages.insert({ threadId: thread.id, role: "user", content: "Show some pictures", textPlain: "Show some pictures" });
  commands = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
  pi = new PiRuntimeManager({ config, db, repos, logger, commandRuntime: commands });
  runtime = await pi.runtime(thread, user);
  assert(pi.providerRouter.codexConfigured(), "Real Codex credentials must be available.");
  assert(runtime.session.messages.some(message => message.role === "assistant" && message.content.some(part => part.type === "text" && part.text === priorAnswer)), "The prior restaurant answer must reach the real model.");
  const api = new Api(config.BOT_TOKEN);
  api.config.use(async () => {
    telegramRequests++;
    throw new Error("Telegram calls are forbidden in this disposable smoke.");
  });
  await runtime.bridge.beginTurn({ api, chatId: user.tg_id, userMessageId: current.id, resolveFile: async () => { throw new Error("This smoke supplied no existing chat attachments."); } });
  turnStart = runtime.session.messages.length;
  const unsubscribe = runtime.session.subscribe(event => {
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      process.stdout.write(JSON.stringify({ event: event.type, tool: event.toolName, ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}) }) + "\n");
    }
  });
  try {
    await runPiPromptWithTimeout(runtime.session, "Show some pictures", 600_000);
  } finally { unsubscribe(); }
  const messages = runtime.session.messages.slice(turnStart);
  const results = messages.filter(message => message.role === "toolResult");
  const assistants = messages.filter(message => message.role === "assistant");
  assert(assistants.length > 0 && assistants.every(message => message.provider === "openai-codex" && message.model === config.CODEX_MODEL), "The configured real Codex model must handle the complete turn.");
  const finished = results.findLast(message => message.toolName === "finish_response" && !message.isError && asRecord(message.details)?.completed === true);
  assert(finished, "The model must successfully call finish_response.");
  const final = currentTurnAssistantResult(messages);
  assert(final.completed && final.openui && final.text.trim(), "Completion requires valid OpenUI and a complete plain-text fallback.");
  const source = validateOpenUi(final.openui);
  const parsed = createParser(openUiLibrary.toJSONSchema(), "Stack").parse(source);
  assert(parsed.root, "The validated UI must have a renderable root.");
  const Node = z.object({ typeName: z.string(), props: z.record(z.string(), z.unknown()) });
  const pending: unknown[] = [parsed.root];
  const pictures: Array<z.infer<typeof UiImage.props>> = [];
  while (pending.length) {
    const node = Node.parse(pending.pop());
    if (node.typeName === "Image") pictures.push(UiImage.props.parse(node.props));
    if (Array.isArray(node.props.children)) pending.push(...node.props.children);
  }
  assert(pictures.length > 0, "The rendered UI must contain an actual Image component.");
  const calls = assistants.flatMap(message => message.content.flatMap(part => part.type === "toolCall" ? [{ call: part, message }] : []));
  const downloads = results.filter(message => message.toolName === "bash" && !message.isError && asRecord(message.details)?.exit_code === 0 && calls.some(({ call }) => call.id === message.toolCallId && JSON.stringify(call.arguments).includes("dtf-cdn.com")));
  assert(downloads.length > 0, "Bash must successfully retrieve the supplied official restaurant photo.");
  const inspected = results.filter(message => !message.isError && message.content.some(part => part.type === "image" && part.data.length > 0) && (asRecord(message.details)?.inspected === true || asRecord(asRecord(message.details)?.inspection)?.inspected === true));
  assert(inspected.length > 0, "An inspection must provide actual image content to model vision.");
  assert(!calls.some(({ call }) => call.name === "generate_image"), "Existing restaurant photos must not be synthesized.");
  const finalIds = z.array(z.number().int().positive()).parse(asRecord(finished.details)?.file_ids);
  const attachmentEvidence = [];
  for (const picture of pictures) {
    const fileId = Number(picture.source.slice("file:".length));
    const created = results.find(message => message.toolName === "create_file" && !message.isError && asRecord(message.details)?.file_id === fileId);
    assert(created && messages.indexOf(created) < messages.indexOf(finished), `Image ${picture.source} must reference an earlier successful create_file.`);
    const attachment: CreatedFileAttachment | undefined = runtime.bridge.attachments.find(file => file.fileId === fileId);
    assert(attachment?.type === "image" && attachment.sourceVirtualPath && attachment.size > 0 && finalIds.includes(fileId), `Image ${picture.source} must remain attached at completion.`);
    const createCall = calls.find(({ call }) => call.id === created.toolCallId);
    assert(createCall, "Attachment creation must be an actual model tool call.");
    const attachmentPath = attachment.sourceVirtualPath;
    const inspection: Extract<AgentMessage, { role: "toolResult" }> | undefined = inspected.find(message => {
      const details = asRecord(message.details);
      const images = asRecord(details?.inspection)?.images ?? details?.images;
      return Array.isArray(images) && images.some((image): boolean => {
        const inspectedPath = asRecord(image)?.path;
        return typeof inspectedPath === "string" && sandboxWorkspaceFile(inspectedPath) === sandboxWorkspaceFile(attachmentPath);
      });
    });
    assert(inspection && messages.indexOf(inspection) < messages.indexOf(createCall.message), "The model must see this exact image before issuing create_file.");
    assert(downloads.some(download => messages.indexOf(download) <= messages.indexOf(inspection)), "Photo download must precede inspection.");
    const saved: Awaited<ReturnType<ThreadE2BSandboxRuntimeManager["readWorkspaceFile"]>> = await commands.readWorkspaceFile({ userId: user.tg_id, threadId: thread.id, virtualPath: attachment.sourceVirtualPath, maxBytes: 20 * 1024 * 1024 });
    assert(detectImageMediaType(saved.bytes), "The attached workspace file must contain real image bytes.");
    assert.equal(saved.size, attachment.size, "Verified image bytes must match the registered attachment size.");
    attachmentEvidence.push({ fileId, name: attachment.name, path: attachment.sourceVirtualPath, bytes: saved.size, mediaType: detectImageMediaType(saved.bytes), sha256: sha256Hex(saved.bytes), alt: picture.alt, caption: picture.caption });
  }
  assert.equal(telegramRequests, 0);
  Object.assign(evidence, { ok: true, images: attachmentEvidence, final, fallbackReview: "Review the recorded fallback against the image descriptions; the runtime validates nonblank fallback but cannot prove semantic completeness.", budget: runtime.bridge.currentTurnBudget()?.snapshot() });
} catch (error) {
  failure = error;
  Object.assign(evidence, { ok: false, error: String(error) });
} finally {
  if (runtime) Object.assign(evidence, transcriptEvidence(runtime.session.messages.slice(turnStart)));
  if (threadId !== undefined) {
    try { sandboxId = (await createRepos(db.db, db.search).threadSandboxes.get(config.E2B_DEPLOYMENT_ID, threadId))?.sandbox_id; }
    catch (error) { cleanupErrors.push(`Locate disposable sandbox: ${String(error)}`); }
  }
  await pi?.dispose().catch(error => { cleanupErrors.push(`Pi disposal: ${String(error)}`); });
  await commands?.dispose().catch(error => { cleanupErrors.push(`Runtime disposal: ${String(error)}`); });
  if (sandboxId) {
    try { await Sandbox.kill(sandboxId, { apiKey: config.E2B_API_KEY }); }
    catch (error) { cleanupErrors.push(`Kill disposable sandbox: ${String(error)}`); }
  }
  await db.destroy().catch(error => { cleanupErrors.push(`Database disposal: ${String(error)}`); });
  await fs.rm(directory, { recursive: true, force: true }).catch(error => { cleanupErrors.push(`Session disposal: ${String(error)}`); });
  Object.assign(evidence, { elapsedMs: Date.now() - startedAt, telegramRequests, cleanup: { sandboxId, sessionDirectoryRemoved: !await fs.access(directory).then(() => true, () => false), errors: cleanupErrors }, deliveryScope: "Real model/tool/attachment preparation and OpenUI output. Final web persistence and Telegram delivery are outside this smoke; no Telegram API requests are allowed." });
  if (cleanupErrors.length) evidence.ok = false;
  const json = JSON.stringify(evidence, null, 2);
  await fs.writeFile(reportPath, `# Disposable web restaurant photo live smoke\n\n\`\`\`json\n${json}\n\`\`\`\n`, { mode: 0o600 });
  process.stdout.write(json + "\n");
}
if (failure || cleanupErrors.length) process.exitCode = 1;

async function copyCredentialIfPresent(source: string, destination: string): Promise<void> {
  try { await fs.copyFile(source, destination); await fs.chmod(destination, 0o600); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}

function transcriptEvidence(messages: readonly AgentMessage[]) {
  const results = messages.filter(message => message.role === "toolResult");
  const assistants = messages.filter(message => message.role === "assistant");
  const nested = results.flatMap(message => message.nestedCalls?.calls ?? []);
  const count = (names: string[]) => names.reduce<Record<string, number>>((counts, name) => { counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});
  return {
    modelCycles: assistants.length,
    providers: [...new Set(assistants.map(message => `${message.provider}/${message.model}`))],
    topLevelToolCalls: results.length,
    topLevelToolCounts: count(results.map(message => message.toolName)),
    nestedToolCalls: nested.length,
    nestedToolCounts: count(nested.map(call => call.name)),
    nestedCallsComplete: results.every(message => !message.nestedCalls || message.nestedCalls.complete),
    nested,
    tools: results.map(message => ({
      name: message.toolName, isError: message.isError, details: message.details,
      output: message.content.map(part => part.type === "image" ? { type: part.type, mimeType: part.mimeType, base64Chars: part.data.length } : { type: part.type, text: part.text.slice(0, 8_000) }),
    })),
    actualToolCalls: assistants.flatMap(message => message.content.filter(part => part.type === "toolCall")),
    assistantTexts: assistants.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])),
  };
}
