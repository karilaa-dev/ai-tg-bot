import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ModelMessage } from "ai";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { formatMessageLine, type ConversationSummarizer } from "../memory/compactor.js";
import type { ImageCaptioner } from "./provider.js";
import {
  buildCodexToolSpecs,
  executeBotTool,
  formatBotToolResultForCodex,
  type BotImageGenerator,
  type BotToolRegistry,
  type CodexToolContentItem,
} from "./tools/index.js";
import { asRecord, numberField as numberValue, rawStringField as stringValue, safeJson } from "../util/records.js";

export interface CodexTransport {
  incoming: AsyncIterable<JsonRpcMessage>;
  send(message: JsonRpcMessage): void;
  close(): void;
}

export type CodexTransportFactory = (logger?: Logger) => CodexTransport;

export interface CodexTurnInput {
  config: AppConfig;
  model?: string;
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  userInputs?: CodexUserInput[];
  tools?: BotToolRegistry;
  logger?: Logger;
  abortSignal?: AbortSignal;
  cwd?: string;
}

type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" };

export type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type CodexGeneratedImagePart = {
  type: "image-generated";
  id?: string;
  imageBase64: string;
  revisedPrompt?: string | null;
  status?: string | null;
};

const COMPACTION_TIMEOUT_MS = 120_000;
const CAPTION_TIMEOUT_MS = 60_000;
const ERROR_TEXT_PREVIEW_CHARS = 500;
const IMAGE_DEDUPE_KEY_CHARS = 64;
const SUMMARY_MESSAGE_MAX_CHARS = 1200;

let transportFactoryForTests: CodexTransportFactory | undefined;

export function setCodexTransportFactoryForTests(factory?: CodexTransportFactory): void {
  transportFactoryForTests = factory;
}

export function codexServiceTier(config: AppConfig): string | null {
  return config.CODEX_SPEED_MODE === "fast" ? "priority" : null;
}

// Applied both as process-level -c overrides (ProcessCodexTransport spawn) and per-thread config in thread/start; keep the two in sync via this helper.
function codexModelSettings(config: AppConfig): Record<string, string> {
  return {
    model_verbosity: config.CODEX_VERBOSITY,
    model_reasoning_effort: config.REASONING_EFFORT,
    model_reasoning_summary: config.REASONING_SUMMARY,
  };
}

export function codexAppServerConfigArgs(config: AppConfig): string[] {
  return [
    "-c",
    'approvals_reviewer="guardian_subagent"',
    ...Object.entries(codexModelSettings(config)).flatMap(([key, value]) => ["-c", `${key}=${tomlString(value)}`]),
  ];
}

export function streamCodexTurn(input: CodexTurnInput): { fullStream: AsyncIterable<unknown> } {
  return { fullStream: runCodexTurn(input) };
}

function createCodexTextCollector(): { onPart(part: unknown): void; text(): string } {
  let deltas = "";
  let finalText: string | undefined;
  return {
    onPart(part: unknown): void {
      const record = asRecord(part);
      if (record?.type === "text-delta") deltas += String(record.text ?? record.delta ?? "");
      if (record?.type === "text-final") finalText = String(record.text ?? "");
    },
    text: () => finalText ?? deltas,
  };
}

export async function generateCodexText(input: CodexTurnInput): Promise<string> {
  const collector = createCodexTextCollector();
  for await (const part of runCodexTurn({ ...input, tools: input.tools ?? {} })) {
    collector.onPart(part);
  }
  const trimmed = collector.text().trim();
  if (!trimmed) throw new Error("empty Codex response");
  return trimmed;
}

export function createCodexImageGenerator(config: AppConfig, logger?: Logger): BotImageGenerator {
  return async ({ prompt, model, quality, size, mode, references }) => {
    const operation = mode === "auto" ? (references.length ? "edit" : "generate") : mode;
    // App-server emits imageGeneration items from normal chat turns; ChatGPT auth rejects gpt-image-2 as the turn model.
    const turnModel = config.CODEX_MODEL;
    logger?.info("Codex image generation starting", {
      model,
      turnModel,
      quality,
      size,
      mode: operation,
      references: references.length,
      promptChars: prompt.length,
    });
    const collector = createCodexTextCollector();
    let image: CodexGeneratedImagePart | undefined;
    const instructions = [
      "Generate exactly one image for this Telegram user.",
      `Use image model ${model}.`,
      `Use quality ${quality}.`,
      `Use size ${size}.`,
      operation === "edit"
        ? "Use the supplied reference image(s) as visual input and edit or transform them according to the prompt."
        : "Create a new image from the prompt.",
      "Do not answer with prose instead of the image.",
      "",
      `Prompt:\n${prompt}`,
    ].join("\n");
    const userInputs: CodexUserInput[] = [
      { type: "text", text: instructions, text_elements: [] },
      ...references.map((reference) => ({
        type: "localImage" as const,
        path: reference.path,
        detail: "high" as const,
      })),
    ];
    for await (const part of runCodexTurn({
      config,
      model: turnModel,
      userInputs,
      tools: {},
      logger,
      abortSignal: config.CODEX_IMAGE_TIMEOUT_MS > 0 ? AbortSignal.timeout(config.CODEX_IMAGE_TIMEOUT_MS) : undefined,
    })) {
      const record = asRecord(part);
      if (record?.type === "image-generated") image = record as CodexGeneratedImagePart;
      collector.onPart(part);
    }
    if (!image?.imageBase64) {
      const text = collector.text().trim();
      const detail = text ? `; Codex returned text instead: ${text.slice(0, ERROR_TEXT_PREVIEW_CHARS)}` : "";
      throw new Error(`Codex image generation returned no image${detail}`);
    }
    logger?.info("Codex image generation complete", {
      model,
      turnModel,
      quality,
      size,
      mode: operation,
      imageChars: image.imageBase64.length,
      status: image.status ?? null,
    });
    return {
      imageBase64: image.imageBase64,
      revisedPrompt: image.revisedPrompt ?? null,
      status: image.status ?? null,
      mediaType: "image/png",
    };
  };
}

export function createCodexConversationSummarizer(config: AppConfig, logger?: Logger): ConversationSummarizer {
  return {
    summarizeSegment: async ({ messages }) => {
      logger?.debug("Codex segment summarization starting", {
        messages: messages.length,
        model: config.CODEX_COMPACTION_MODEL,
      });
      const text = await generateCodexText({
        config,
        model: config.CODEX_COMPACTION_MODEL,
        system:
          "Summarize this Telegram conversation segment. Keep decisions, facts, names, numbers, file references (#file-id), open questions, and image descriptions. Cite source message ids like [#123]. Stay under 300 words.",
        prompt: messages.map((message) => formatMessageLine(message, SUMMARY_MESSAGE_MAX_CHARS)).join("\n"),
        logger,
        abortSignal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
      });
      logger?.debug("Codex segment summarization complete", { messages: messages.length, chars: text.length });
      return text;
    },
    mergeMeta: async ({ previous, summaries }) => {
      logger?.debug("Codex meta summary merge starting", {
        summaries: summaries.length,
        previousChars: previous?.length ?? 0,
        model: config.CODEX_COMPACTION_MODEL,
      });
      const text = await generateCodexText({
        config,
        model: config.CODEX_COMPACTION_MODEL,
        system:
          "Merge conversation memory into one rolling summary, most-recent-relevant first. Keep durable facts, decisions, file references, image descriptions, and open questions. Stay under 400 words.",
        prompt: [
          previous ? `Previous memory:\n${previous}` : "Previous memory: none",
          `New segment summaries:\n${summaries.join("\n\n")}`,
        ].join("\n\n"),
        logger,
        abortSignal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
      });
      logger?.info("Codex conversation memory summarized", { summaries: summaries.length, chars: text.length });
      return text;
    },
  };
}

export function createCodexImageCaptioner(config: AppConfig, logger?: Logger): ImageCaptioner {
  return {
    caption: async ({ bytes, name, mime }) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-codex-image-"));
      const filePath = path.join(dir, safeFileName(name));
      try {
        logger?.debug("Codex image description starting", { name, bytes: bytes.length, mime });
        await fs.writeFile(filePath, bytes);
        const text = await generateCodexText({
          config,
          model: config.CODEX_COMPACTION_MODEL,
          system: "Describe the supplied image in 1-2 concise sentences for later recall.",
          userInputs: [
            { type: "text", text: "Describe this image in 1-2 concise sentences for later recall.", text_elements: [] },
            { type: "localImage", path: filePath },
          ],
          logger,
          abortSignal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
        });
        logger?.debug("Codex image description complete", { name, chars: text.length });
        return text || `[image: ${name}]`;
      } catch (err) {
        logger?.warn("Codex image description failed", { err: String(err), name });
        return `[image, no vision model: ${name}]`;
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

async function* runCodexTurn(input: CodexTurnInput): AsyncIterable<unknown> {
  const transport = transportFactoryForTests?.(input.logger) ?? new ProcessCodexTransport(input.config, input.logger);
  const session = new CodexRpcSession(transport, input.config, input.tools ?? {}, input.logger, input.abortSignal);
  try {
    await session.initialize();
    const thread = await session.startThread(input);
    session.startTurn(thread, input);
    for await (const part of session.stream) yield part;
  } finally {
    session.close();
  }
}

class CodexRpcSession {
  private nextId = 1;
  private syntheticCallId = 1;
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
  }>();
  readonly stream = new AsyncQueue<unknown>();
  private readonly seenToolCalls = new Set<string>();
  private readonly seenToolResults = new Set<string>();
  private readonly seenCompletedItems = new Set<string>();
  private readonly seenGeneratedImages = new Set<string>();
  private readonly agentMessageDeltas = new Map<string, string>();
  private readonly reasoningSummaryDeltas = new Map<string, Map<number, string>>();
  private readonly abortSignal?: AbortSignal;
  private readonly abortHandler?: () => void;
  private closed = false;
  private failed = false;

  constructor(
    private readonly transport: CodexTransport,
    private readonly config: AppConfig,
    private readonly tools: BotToolRegistry,
    private readonly logger?: Logger,
    abortSignal?: AbortSignal,
  ) {
    this.abortSignal = abortSignal;
    void this.pump();
    if (abortSignal) {
      if (abortSignal.aborted) this.abort(abortSignal.reason);
      else {
        this.abortHandler = () => this.abort(abortSignal.reason);
        abortSignal.addEventListener("abort", this.abortHandler, { once: true });
      }
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "ai-tg-bot",
        title: "AI Telegram Bot",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  async startThread(input: CodexTurnInput): Promise<string> {
    const toolSpecs = buildCodexToolSpecs(this.tools);
    const model = input.model ?? input.config.CODEX_MODEL;
    const serviceTier = codexServiceTier(input.config);
    const result = await this.request("thread/start", {
      model,
      serviceTier,
      cwd: input.cwd ?? process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      config: codexModelSettings(input.config),
      dynamicTools: toolSpecs,
      baseInstructions: input.system ?? null,
      developerInstructions: null,
      ephemeral: true,
    });
    const threadId = readThreadId(result);
    if (!threadId) throw new Error(`Codex thread/start returned no thread id: ${safeJson(result)}`);
    const effectiveModel = stringValue(asRecord(result), "model");
    const effectiveServiceTier = stringValue(asRecord(result), "serviceTier");
    const effectiveReasoningEffort = stringValue(asRecord(result), "reasoningEffort");
    assertEffectiveSetting("model", effectiveModel, model);
    assertEffectiveSetting("service tier", effectiveServiceTier, serviceTier);
    assertEffectiveSetting("reasoning effort", effectiveReasoningEffort, input.config.REASONING_EFFORT);
    this.logger?.info("Codex thread started", {
      threadId,
      model: effectiveModel ?? model,
      serviceTier: effectiveServiceTier ?? serviceTier,
      reasoningEffort: effectiveReasoningEffort ?? input.config.REASONING_EFFORT,
      reasoningSummary: input.config.REASONING_SUMMARY,
    });
    return threadId;
  }

  startTurn(threadId: string, input: CodexTurnInput): void {
    const userInputs = input.userInputs ?? [{ type: "text" as const, text: promptText(input), text_elements: [] as [] }];
    const params: Record<string, unknown> = {
      threadId,
      input: userInputs,
      cwd: input.cwd ?? process.cwd(),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: input.model ?? input.config.CODEX_MODEL,
      serviceTier: codexServiceTier(input.config),
      effort: input.config.REASONING_EFFORT,
    };
    if (input.config.REASONING_SUMMARY !== "none") params.summary = input.config.REASONING_SUMMARY;
    void this.request("turn/start", params).catch((err) => this.stream.fail(err));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanupAbortListener();
    if (!this.failed) {
      for (const [, pending] of this.pending) pending.reject(new Error("Codex app-server session closed"));
      this.pending.clear();
    }
    this.transport.close();
    this.stream.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.transport.send(params === undefined ? { method } : { method, params });
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.transport.incoming) {
        await this.handleMessage(message);
      }
    } catch (err) {
      this.fail(err);
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      await this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params);
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.method !== "item/tool/call") {
      this.transport.send({
        id: message.id,
        error: { code: -32601, message: `unsupported server request: ${message.method}` },
      });
      return;
    }
    const params = asRecord(message.params);
    const callId = String(params?.callId ?? message.id ?? `synthetic-${this.syntheticCallId++}`);
    const toolName = String(params?.tool ?? "");
    const toolInput = params?.arguments ?? {};
    this.emitToolCall(callId, toolName, toolInput);
    try {
      const output = await executeBotTool(this.tools, toolName, toolInput);
      this.emitToolResult(callId, toolName, output);
      this.transport.send({
        id: message.id,
        result: {
          contentItems: await formatBotToolResultForCodex(this.tools, toolName, toolInput, output, callId),
          success: true,
        },
      });
    } catch (err) {
      const output = { error: String(err) };
      this.emitToolResult(callId, toolName || "tool", output);
      this.transport.send({
        id: message.id,
        result: {
          contentItems: [{ type: "inputText", text: safeJson(output) }],
          success: false,
        },
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const record = asRecord(params);
    switch (method) {
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(record);
        break;
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningSummaryDelta(record);
        break;
      case "item/started":
        this.handleItemStarted(record);
        break;
      case "item/completed":
        this.handleItemCompleted(record);
        break;
      case "rawResponseItem/completed":
        this.handleRawResponseItemCompleted(record);
        break;
      case "turn/completed":
        this.handleTurnCompleted(record);
        break;
      case "error":
        if (isRetryNotice(params)) {
          this.logger?.warn("Codex app-server retrying stream", { message: errorMessage(params) });
          return;
        }
        this.fail(new Error(errorMessage(params)));
        break;
    }
  }

  private handleItemStarted(params: Record<string, unknown> | undefined): void {
    const item = asRecord(params?.item);
    if (item?.type !== "dynamicToolCall") return;
    this.emitToolCall(String(item.id), String(item.tool ?? "tool"), item.arguments);
  }

  private handleItemCompleted(params: Record<string, unknown> | undefined): void {
    const item = asRecord(params?.item);
    this.handleCompletedItem(item);
  }

  private handleTurnCompleted(params: Record<string, unknown> | undefined): void {
    const turn = asRecord(params?.turn);
    if (turn?.status === "failed" || turn?.status === "interrupted") {
      const err = asRecord(turn.error);
      this.fail(new Error(String(err?.message ?? `Codex turn ${turn.status}`)));
      return;
    }
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) this.handleCompletedItem(asRecord(item));
    this.stream.close();
  }

  private handleAgentMessageDelta(params: Record<string, unknown> | undefined): void {
    const text = String(params?.delta ?? "");
    const itemId = stringValue(params, "itemId");
    if (itemId) this.agentMessageDeltas.set(itemId, `${this.agentMessageDeltas.get(itemId) ?? ""}${text}`);
    this.pushTextDeltas("text-delta", text);
  }

  private handleReasoningSummaryDelta(params: Record<string, unknown> | undefined): void {
    if (this.config.REASONING_SUMMARY === "none") return;
    const text = String(params?.delta ?? "");
    const itemId = stringValue(params, "itemId");
    const summaryIndex = numberValue(params, "summaryIndex") ?? 0;
    let streamText = text;
    if (itemId) {
      const existing = this.reasoningSummaryDeltas.get(itemId) ?? new Map<number, string>();
      const startsNewSection = !existing.has(summaryIndex) && existing.size > 0;
      existing.set(summaryIndex, `${existing.get(summaryIndex) ?? ""}${text}`);
      this.reasoningSummaryDeltas.set(itemId, existing);
      if (startsNewSection) streamText = prefixReasoningSection(text);
    }
    this.pushTextDeltas("reasoning-delta", streamText);
  }

  private handleCompletedItem(item: Record<string, unknown> | undefined): void {
    if (!item) return;
    const itemType = stringValue(item, "type");
    if (!itemType) return;
    const itemId = stringValue(item, "id");
    if (itemId) {
      if (this.seenCompletedItems.has(itemId)) return;
      this.seenCompletedItems.add(itemId);
    }
    if (itemType === "agentMessage") {
      const text = agentMessageText(item, itemId ? this.agentMessageDeltas.get(itemId) : undefined);
      if (text !== undefined) this.stream.push({ type: "text-final", text });
      return;
    }
    if (itemType === "reasoning") {
      this.emitCompletedReasoning(item, itemId);
      return;
    }
    if (itemType === "imageGeneration") {
      this.emitGeneratedImage(item, itemId);
      return;
    }
    if (itemType === "dynamicToolCall") {
      const contentItems = Array.isArray(item.contentItems) ? item.contentItems as CodexToolContentItem[] : [];
      this.emitToolResult(itemId ?? `synthetic-${this.syntheticCallId++}`, String(item.tool ?? "tool"), outputFromCodexContentItems(contentItems));
    }
  }

  private handleRawResponseItemCompleted(params: Record<string, unknown> | undefined): void {
    const item = asRecord(params?.item);
    if (!item || stringValue(item, "type") !== "image_generation_call") return;
    this.emitGeneratedImage(item, stringValue(item, "id"));
  }

  private emitCompletedReasoning(item: Record<string, unknown>, itemId: string | undefined): void {
    if (this.config.REASONING_SUMMARY === "none") return;
    const text = reasoningSummaryText(item);
    if (!text.trim()) return;
    const streamed = itemId ? streamedReasoningSummaryText(this.reasoningSummaryDeltas.get(itemId)) : undefined;
    if (streamed !== undefined && comparableReasoningSummary(streamed) === comparableReasoningSummary(text)) return;
    this.pushTextDeltas("reasoning-delta", text);
  }

  private emitToolCall(callId: string, toolName: string, input: unknown): void {
    if (this.seenToolCalls.has(callId)) return;
    this.seenToolCalls.add(callId);
    this.stream.push({ type: "tool-call", toolName, input });
  }

  private emitToolResult(callId: string, toolName: string, output: unknown): void {
    if (this.seenToolResults.has(callId)) return;
    this.seenToolResults.add(callId);
    this.stream.push({ type: "tool-result", toolName, output });
  }

  private emitGeneratedImage(item: Record<string, unknown>, itemId: string | undefined): void {
    const imageBase64 = stringValue(item, "result")?.trim();
    if (!imageBase64) return;
    const key = itemId ?? imageBase64.slice(0, IMAGE_DEDUPE_KEY_CHARS);
    if (this.seenGeneratedImages.has(key)) return;
    this.seenGeneratedImages.add(key);
    this.stream.push({
      type: "image-generated",
      id: itemId,
      imageBase64,
      revisedPrompt: stringValue(item, "revisedPrompt") ?? stringValue(item, "revised_prompt") ?? null,
      status: stringValue(item, "status") ?? null,
    } satisfies CodexGeneratedImagePart);
  }

  private pushTextDeltas(type: "text-delta" | "reasoning-delta", text: string): void {
    for (const chunk of splitTextDelta(text, this.deltaChunkChars())) {
      this.stream.push({ type, text: chunk });
    }
  }

  private deltaChunkChars(): number {
    return Math.max(1, this.config.STREAM_DELTA_CHARS);
  }

  private abort(reason?: unknown): void {
    if (this.closed || this.failed) return;
    this.fail(codexAbortError(reason));
    this.transport.close();
  }

  private fail(err: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.cleanupAbortListener();
    this.logger?.warn("Codex app-server stream failed", { err: String(err) });
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    this.stream.fail(err);
  }

  private cleanupAbortListener(): void {
    if (this.abortSignal && this.abortHandler) this.abortSignal.removeEventListener("abort", this.abortHandler);
  }
}

function codexAbortError(reason: unknown): Error {
  if (!reason) return new Error("Codex turn aborted");
  const reasonText = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return new Error(`Codex turn aborted: ${reasonText}`);
}

class ProcessCodexTransport implements CodexTransport {
  readonly incoming = new AsyncQueue<JsonRpcMessage>();
  private readonly process: ChildProcessWithoutNullStreams;

  constructor(config: AppConfig, private readonly logger?: Logger) {
    this.process = spawn("codex", ["app-server", ...codexAppServerConfigArgs(config)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.onStdoutLine(line));
    readline.createInterface({ input: this.process.stderr }).on("line", (line) => {
      this.logger?.debug("Codex app-server stderr", { line });
    });
    this.process.once("error", (err) => this.incoming.fail(err));
    this.process.once("exit", (code, signal) => {
      if (code && code !== 0) this.incoming.fail(new Error(`codex app-server exited with code ${code}`));
      else if (signal) this.incoming.fail(new Error(`codex app-server exited with signal ${signal}`));
      else this.incoming.close();
    });
  }

  send(message: JsonRpcMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    if (!this.process.killed) this.process.kill();
    this.incoming.close();
  }

  private onStdoutLine(line: string): void {
    if (!line.trim()) return;
    try {
      this.incoming.push(JSON.parse(line) as JsonRpcMessage);
    } catch (err) {
      this.incoming.fail(new Error(`invalid Codex app-server JSON: ${String(err)}: ${line}`));
    }
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    if (this.ended || this.failure) return;
    this.failure = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const result = await this.next();
      if (result.done) return;
      yield result.value;
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function promptText(input: CodexTurnInput): string {
  if (input.prompt !== undefined) return input.prompt;
  return [
    "Conversation transcript:",
    ...(input.messages ?? []).map(formatModelMessage),
    "",
    "Answer the latest user message.",
  ].join("\n");
}

function formatModelMessage(message: ModelMessage): string {
  return `[${message.role}] ${contentText(message.content)}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeJson(content);
  return content
    .map((part) => {
      const record = asRecord(part);
      if (record?.type === "text") return String(record.text ?? "");
      if (record?.type === "image") return "[image attached]";
      if (record?.type === "file") return `[file attached: ${String(record.filename ?? "file")}]`;
      return safeJson(part);
    })
    .filter(Boolean)
    .join("\n");
}

function splitTextDelta(text: string, maxChars: number): string[] {
  if (!text) return [];
  const chars = Array.from(text);
  const size = Math.max(1, maxChars);
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(""));
  }
  return chunks;
}

function readThreadId(result: unknown): string | undefined {
  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  const id = thread?.id ?? record?.threadId ?? record?.id;
  return typeof id === "string" && id ? id : undefined;
}

function assertEffectiveSetting(label: string, effective: string | undefined, expected: string | null): void {
  if (effective === expected || (expected === null && effective === undefined)) return;
  throw new Error(`Codex thread/start selected unexpected ${label}: expected ${expected ?? "default"}, got ${effective ?? "missing"}`);
}

function outputFromCodexContentItems(items: CodexToolContentItem[]): unknown {
  if (items.length === 1 && items[0]?.type === "inputText") {
    try {
      return JSON.parse(items[0].text);
    } catch {
      return items[0].text;
    }
  }
  return { contentItems: items };
}

function agentMessageText(item: Record<string, unknown>, deltaFallback?: string): string | undefined {
  const direct = stringValue(item, "text") ?? stringValue(item, "content");
  if (direct !== undefined) return direct;
  const content = item.content;
  if (Array.isArray(content)) {
    const text = content.map(textPart).filter((part) => part !== undefined).join("");
    if (text || content.length) return text;
  }
  return deltaFallback;
}

function reasoningSummaryText(item: Record<string, unknown>): string {
  const summary = item.summary;
  if (Array.isArray(summary)) return joinReasoningSummaryParts(summary.map(textPart));
  if (typeof summary === "string") return summary;
  const content = item.content;
  if (Array.isArray(content)) return joinReasoningSummaryParts(content.map(textPart));
  if (typeof content === "string") return content;
  return "";
}

function streamedReasoningSummaryText(parts: Map<number, string> | undefined): string | undefined {
  if (!parts) return undefined;
  return joinReasoningSummaryParts([...parts.entries()].sort(([left], [right]) => left - right).map(([, text]) => text));
}

function joinReasoningSummaryParts(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function prefixReasoningSection(text: string): string {
  if (!text) return text;
  if (/^\s*\n/.test(text)) return text;
  return `\n\n${text.trimStart()}`;
}

function comparableReasoningSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textPart(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return undefined;
  return stringValue(record, "text") ?? stringValue(record, "content");
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_") || "image";
}

function errorMessage(value: unknown): string {
  const record = asRecord(value);
  if (typeof record?.message === "string") return record.message;
  if (record?.error !== undefined) return errorMessage(record.error);
  return safeJson(value);
}

function isRetryNotice(value: unknown): boolean {
  return errorMessage(value).startsWith("Reconnecting...");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
