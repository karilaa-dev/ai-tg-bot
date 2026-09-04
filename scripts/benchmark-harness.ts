import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FileRow } from "../src/db/types.js";
import type { Logger } from "../src/logger.js";
import type { CreatedFileAttachment } from "../src/ai/tools/types.js";
import type { InputFile } from "grammy";

const { values } = parseArgs({ options: {
  repo: { type: "string", default: process.cwd() },
  provider: { type: "string", default: "codex" },
  runs: { type: "string", default: "3" },
  out: { type: "string", default: path.resolve("data/harness-benchmark.jsonl") },
} });
const root = path.resolve(values.repo!);
const output = path.resolve(values.out!);
const requestedProvider = values.provider === "codex" ? "openai-codex" : values.provider === "openrouter" ? "openrouter" : undefined;
const runs = Number(values.runs);
if (!requestedProvider || !Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("Use --provider codex|openrouter and --runs 1..10.");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string };
process.chdir(root);
const moduleAt = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);
const { loadConfig }: typeof import("../src/config.js") = await moduleAt("src/config.ts");
const { createDatabase }: typeof import("../src/db/index.js") = await moduleAt("src/db/index.ts");
const { createRepos }: typeof import("../src/db/repos/index.js") = await moduleAt("src/db/repos/index.ts");
const { ThreadE2BSandboxRuntimeManager }: typeof import("../src/e2b/threadRuntimeManager.js") = await moduleAt("src/e2b/threadRuntimeManager.ts");
const { createE2BClient }: typeof import("../src/e2b/client.js") = await moduleAt("src/e2b/client.ts");
const { E2BFileSourceAdapter }: typeof import("../src/e2b/fileSource.js") = await moduleAt("src/e2b/fileSource.ts");
const { PiRuntimeManager }: typeof import("../src/pi/runtime.js") = await moduleAt("src/pi/runtime.ts");
const { currentTurnAssistantResult }: typeof import("../src/ai/currentTurnResult.js") = await moduleAt("src/ai/currentTurnResult.ts");
const { sendFinal }: typeof import("../src/ai/agentTurnEngine.js") = await moduleAt("src/ai/agentTurnEngine.ts");
const base = loadConfig();
const prompt = "Create a 100 mm long hollow tube adapter for 3D printing. One end should have a 57.1 mm inner diameter, the other a 44.6 mm inner diameter. Use 3 mm wall thickness everywhere. Keep both ends straight, with the size transition centered in the middle of the tube and make that transition smooth.";
const namespace = `harness-${version}-${values.provider}-${randomUUID().slice(0, 8)}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-benchmark-"));
await fs.mkdir(path.dirname(output), { recursive: true });
const logger: Logger = { level: "error", isLevelEnabled: () => false, debug() {}, info() {}, warn() {}, error(message, metadata) { process.stderr.write(`${message} ${JSON.stringify(metadata)}\n`); } };
let failed = false;
try {
  for (let pair = 1; pair <= runs; pair++) {
    const config = { ...base, DB_URL: "sqlite::memory:", E2B_DEPLOYMENT_ID: `${namespace}-${pair}`, E2B_TEMPLATE: `ai-tg-bot-tools:v${version}`,
      PI_CODING_AGENT_DIR: path.join(directory, String(pair)), PI_THINKING_LEVEL: "low" as const,
      CODEX_MODEL: "gpt-6-astra", OPENROUTER_MAIN_MODEL: "openai/gpt-6-astra",
    };
    const db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9_998_101, firstName: "Benchmark", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Isolated CAD benchmark" });
    const commandRuntime = new ThreadE2BSandboxRuntimeManager({ config, repos, logger });
    const adapter = new E2BFileSourceAdapter(config, commandRuntime);
    try {
      for (const temperature of ["cold", "warm"] as const) {
        if (temperature === "warm") {
          // Keep sandbox/toolbox warmth. Clear artifacts, start a fresh Pi session, and exclude all DB messages with boundary 0.
          for (const file of await repos.files.listForThreads([thread.id])) await repos.files.deleteFile(file.id);
          await commandRuntime.execute({ userId: user.tg_id, threadId: thread.id, command: "bash", args: ["-c", "find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +"], env: {}, stdin: "", workingDir: "/home/user/workspace", timeoutMs: 30_000, maxOutputChars: 1000 });
        }
        const pi = new PiRuntimeManager({ config: { ...config, PI_CODING_AGENT_DIR: path.join(config.PI_CODING_AGENT_DIR, temperature) }, db, repos, logger, commandRuntime });
        const started = Date.now();
        const tools: Array<{ name: string; ms: number; error: boolean; inspections?: string[] }> = [];
        const models: Array<{ provider: string; model: string; ms: number; context: number; input: number; cached: number; output: number }> = [];
        const toolStarts = new Map<string, number>();
        let modelStarted = started;
        const deliveries: Array<{ kind: string; name?: string; ms: number }> = [];
        let fileReloads = 0;
        const resolveFile = async (file: FileRow, signal?: AbortSignal) => {
          fileReloads++;
          const source = (await repos.files.listSources(file.id)).find((source) => source.transport === "e2b");
          if (!source) throw new Error(`No E2B source for ${file.name}`);
          const sourceDescriptor = { transport: "e2b", connectionKey: config.E2B_DEPLOYMENT_ID, remoteKey: source.remote_key, locator: JSON.parse(source.locator_json) };
          const bytes = Buffer.from(await adapter.fetch(sourceDescriptor, signal));
          return { bytes, size: bytes.length, mimeType: file.mime_type, contentSha256: file.content_sha256!, source: sourceDescriptor };
        };
        let messageId = 100;
        const photo = (id: number) => ({ message_id: id, photo: [{ file_id: `mock-${id}`, file_unique_id: `mock-${id}`, width: 100, height: 100, file_size: 100 }] });
        const api = {
          raw: { sendRichMessage: async () => { deliveries.push({ kind: "text", ms: Date.now() - started }); return { message_id: ++messageId }; } },
          sendPhoto: async (_chat: number, file: InputFile) => { deliveries.push({ kind: "photo", name: file.filename, ms: Date.now() - started }); return photo(++messageId); },
          sendDocument: async (_chat: number, file: InputFile) => { deliveries.push({ kind: "document", name: file.filename, ms: Date.now() - started }); return { message_id: ++messageId, document: { file_id: `mock-${messageId}`, file_unique_id: `mock-${messageId}` } }; },
          sendMediaGroup: async (_chat: number, media: Array<{ type: string; media: InputFile }>) => media.map((item) => { deliveries.push({ kind: item.type, name: item.media.filename, ms: Date.now() - started }); return photo(++messageId); }),
        };
        let attachments: CreatedFileAttachment[] = [];
        let error: string | undefined;
        let budget: unknown;
        let peakBufferedBytes: number | undefined;
        try {
          await pi.initialize();
          if (requestedProvider === "openrouter") pi.providerRouter.circuit.recordFailure(Date.now() + 30 * 60_000);
          else if (!pi.providerRouter.codexConfigured()) throw new Error("Codex credentials are unavailable.");
          const runtime = await pi.runtime({ ...thread, pi_session_file: null, pi_session_id: null }, user);
          const unsubscribe = runtime.session.subscribe((event: AgentSessionEvent) => {
            if (event.type === "turn_start") modelStarted = Date.now();
            if (event.type === "message_end" && event.message.role === "assistant") {
              const message = event.message;
              models.push({ provider: message.provider, model: message.model, ms: Date.now() - modelStarted, context: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, input: message.usage.input, cached: message.usage.cacheRead, output: message.usage.output });
            }
            if (event.type === "tool_execution_start") toolStarts.set(event.toolCallId, Date.now());
            if (event.type === "tool_execution_end") {
              const details = event.result?.details;
              tools.push({ name: event.toolName, ms: Date.now() - (toolStarts.get(event.toolCallId) ?? Date.now()), error: event.isError,
                inspections: (details?.inspection?.images ?? details?.images)?.map((image: { path: string }) => image.path),
              });
            }
          });
          await runtime.bridge.beginTurn({ api: api as never, chatId: user.tg_id, resolveFile, userMessageId: 0 });
          try { await runtime.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }); }
          finally { unsubscribe(); }
          attachments = runtime.bridge.attachments;
          const result = currentTurnAssistantResult(runtime.session.messages);
          if (result.error) throw new Error(result.error);
          budget = runtime.bridge.currentTurnBudget()?.snapshot();
          const inspections = tools.flatMap((tool) => tool.inspections ?? []);
          if (!["model.preview.png", "model.final.png"].every((name) => inspections.some((file) => file.endsWith(`/${name}`)))) throw new Error("Both CAD visual inspections must complete.");
          if (models.some((model) => model.provider !== requestedProvider)) throw new Error("The requested provider fell back; this sample does not represent that provider.");
          await sendFinal({ api: api as never, chatId: user.tg_id, config, db, repos, logger, user, thread, text: prompt, resolveFile, outgoingBuffers: runtime.bridge.outgoingBuffers, t: (key) => key }, "", result.text, Date.now() - started, attachments);
          peakBufferedBytes = runtime.bridge.outgoingBuffers?.snapshot().peakBufferedBytes;
          if (attachments.filter((file) => file.name.endsWith(".stl")).length !== 1 || attachments.filter((file) => file.delivery === "photo").length !== 1 || attachments.length !== 2) throw new Error("Expected one STL and one final photo.");
          if (!attachments.some((file) => file.delivery === "photo" && file.sourceVirtualPath?.endsWith("/model.final.png"))) throw new Error("The photo must be the exact final render.");
          if (attachments.some((file) => !file.telegramDelivery)) throw new Error("Mock delivery did not complete.");
        } catch (caught) { error = String(caught); failed = true; }
        finally {
          const record = { version, requestedProvider, pair, temperature, wallMs: Date.now() - started, modelCycles: models.length, modelMs: models.reduce((sum, model) => sum + model.ms, 0), toolMs: tools.reduce((sum, tool) => sum + tool.ms, 0), peakContextTokens: Math.max(0, ...models.map((model) => model.context)), inputTokens: models.reduce((sum, model) => sum + model.input, 0), cachedTokens: models.reduce((sum, model) => sum + model.cached, 0), outputTokens: models.reduce((sum, model) => sum + model.output, 0), tools, models, deliveries, firstTextMs: deliveries.find((item) => item.kind === "text")?.ms ?? null, firstFileMs: deliveries.find((item) => item.kind !== "text")?.ms ?? null, lastFileMs: deliveries.filter((item) => item.kind !== "text").at(-1)?.ms ?? null, fileReloads, budget, peakBufferedBytes, files: attachments.map(({ name, size, delivery }) => ({ name, size, delivery })), error };
          await fs.appendFile(output, `${JSON.stringify(record)}\n`);
          process.stdout.write(`${JSON.stringify({ version, provider: requestedProvider, pair, temperature, wallMs: record.wallMs, cycles: record.modelCycles, error })}\n`);
          await pi.dispose();
        }
      }
    } finally {
      const mapping = await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, thread.id);
      await commandRuntime.dispose();
      if (mapping) await createE2BClient(config).kill(mapping.sandbox_id);
      await db.destroy();
    }
  }
} finally { await fs.rm(directory, { recursive: true, force: true }); }

// SDK transports can retain idle sockets after session and sandbox cleanup.
// Flush the CLI streams before exiting; every result is already persisted above.
await Promise.all([
  new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
  new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
]);
process.exit(failed ? 1 : 0);
