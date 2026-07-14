// Codex image request structure is adapted from pi-better-openai (MIT).
import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { CreatedFileAttachment } from "../ai/tools/types.js";
import { threadChainScope } from "../memory/retrieval.js";
import { resetAtFromHeaders, retryableCodexError } from "./circuit.js";
import type { PiProviderRouter } from "./provider.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
const MAX_REFERENCES = 5;

export interface TelegramImageBridge {
  config: AppConfig;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  logger?: Logger;
  modelRegistry: ModelRegistry;
  providerRouter: PiProviderRouter;
  attachments: CreatedFileAttachment[];
  resolveImage(file: FileRow, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }>;
}

type ImageParams = {
  prompt: string;
  mode?: "auto" | "generate" | "edit";
  reference_file_ids?: number[];
  output_format?: "png" | "jpeg" | "webp";
  caption?: string;
};

type GeneratedImage = {
  bytes: Buffer;
  mimeType: string;
  revisedPrompt?: string;
  provider: "codex" | "openrouter";
  model: string;
};

export function createGenerateImagePiTool(bridge: TelegramImageBridge): ToolDefinition {
  return {
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate or edit exactly one image. References are current-thread Telegram image file ids. After success, give one concise past-tense final sentence and do not call more tools.",
    promptSnippet: "Generate or edit one Telegram-delivered raster image.",
    promptGuidelines: [
      "Use generate_image for image generation or editing requests.",
      "Pass the user's image wording faithfully and use reference_file_ids for referenced Telegram images.",
      "After generate_image succeeds, do not call another tool and do not claim the image is still being generated.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 4000 }),
      mode: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("generate"),
        Type.Literal("edit"),
      ], { default: "auto" })),
      reference_file_ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), {
        maxItems: MAX_REFERENCES,
        default: [],
      })),
      output_format: Type.Optional(Type.Union([
        Type.Literal("png"),
        Type.Literal("jpeg"),
        Type.Literal("webp"),
      ], { default: "png" })),
      caption: Type.Optional(Type.String({ maxLength: 1024 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as ImageParams;
      if (bridge.attachments.some((attachment) => attachment.origin === "generated_image")) {
        throw new Error("Only one image may be generated per answer.");
      }
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error("Image prompt is empty.");
      const referenceIds = [...new Set(params.reference_file_ids ?? [])];
      if (referenceIds.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images are supported.`);
      const mode = params.mode ?? "auto";
      if (mode === "edit" && !referenceIds.length) throw new Error("Edit mode requires at least one reference_file_id.");
      const outputFormat = params.output_format ?? "png";
      const references = await loadReferences(bridge, referenceIds, signal);
      onUpdate?.({
        content: [{ type: "text", text: "Generating image..." }],
        details: { reference_file_ids: referenceIds },
      });
      const generated = await generateWithFallback(bridge, {
        prompt,
        mode,
        outputFormat,
        references,
        signal,
      });
      const extension = outputFormat === "jpeg" ? "jpg" : outputFormat;
      const name = `generated-${randomUUID().slice(0, 8)}.${extension}`;
      const file = await bridge.repos.files.insertFile({
        userId: bridge.user.tg_id,
        threadId: bridge.thread.id,
        type: "image",
        name,
        path: null,
        size: generated.bytes.length,
        contentSha256: createHash("sha256").update(generated.bytes).digest("hex"),
        summary: generated.revisedPrompt ?? prompt,
        isInline: false,
      });
      bridge.attachments.push({
        fileId: file.id,
        type: "image",
        name,
        data: generated.bytes,
        size: generated.bytes.length,
        caption: params.caption?.trim() || null,
        inline: false,
        card: `[Generated image #${file.id}: ${generated.revisedPrompt ?? prompt}]`,
        delivery: "photo",
        origin: "generated_image",
      });
      const result = {
        generated_image: true,
        file_id: file.id,
        name,
        provider: generated.provider,
        model: generated.model,
        mode,
        output_format: outputFormat,
        reference_file_ids: referenceIds,
        revised_prompt: generated.revisedPrompt ?? null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  } as ToolDefinition;
}

async function loadReferences(
  bridge: TelegramImageBridge,
  referenceIds: number[],
  signal?: AbortSignal,
): Promise<ImageContent[]> {
  if (!referenceIds.length) return [];
  const allowedFiles = new Set((await threadChainScope(bridge.repos, bridge.thread)).fileIds);
  const rows = await bridge.repos.files.listByIds(referenceIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const images: ImageContent[] = [];
  for (const id of referenceIds) {
    const file = byId.get(id);
    if (!file || file.type !== "image" || !allowedFiles.has(file.id)) {
      throw new Error(`Reference image #${id} is not available in this thread.`);
    }
    const resolved = await bridge.resolveImage(file, signal);
    images.push({ type: "image", data: resolved.bytes.toString("base64"), mimeType: resolved.mimeType });
  }
  return images;
}

async function generateWithFallback(
  bridge: TelegramImageBridge,
  request: {
    prompt: string;
    mode: "auto" | "generate" | "edit";
    outputFormat: "png" | "jpeg" | "webp";
    references: ImageContent[];
    signal?: AbortSignal;
  },
): Promise<GeneratedImage> {
  const codexModel = bridge.providerRouter.codexModel("main");
  if (!bridge.modelRegistry.hasConfiguredAuth(codexModel)) return requestOpenRouterImage(bridge, request);
  const attempt = bridge.providerRouter.circuit.acquire();
  if (!attempt.allowed) return requestOpenRouterImage(bridge, request);
  try {
    const auth = await bridge.modelRegistry.getApiKeyAndHeaders(codexModel);
    if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Missing openai-codex OAuth token" : auth.error);
    const result = await requestCodexImage(bridge, request, auth.apiKey, auth.headers);
    bridge.providerRouter.circuit.recordSuccess();
    return result;
  } catch (error) {
    const status = httpStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    if (!retryableCodexError({ status, message })) {
      bridge.providerRouter.circuit.recordSuccess();
      throw error;
    }
    bridge.providerRouter.circuit.recordFailure(errorResetAt(error));
    bridge.logger?.warn("Codex image generation failed; falling back to OpenRouter", { status, error: message });
    return requestOpenRouterImage(bridge, request);
  } finally {
    if (attempt.probe && bridge.providerRouter.circuit.state().probeActive) {
      bridge.providerRouter.circuit.releaseProbe();
    }
  }
}

async function requestCodexImage(
  bridge: TelegramImageBridge,
  request: {
    prompt: string;
    mode: "auto" | "generate" | "edit";
    outputFormat: "png" | "jpeg" | "webp";
    references: ImageContent[];
    signal?: AbortSignal;
  },
  accessToken: string,
  authHeaders?: Record<string, string>,
): Promise<GeneratedImage> {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: request.prompt }];
  for (const image of request.references) {
    content.push({ type: "input_image", detail: "auto", image_url: dataUrl(image) });
  }
  const imageTool: Record<string, unknown> = { type: "image_generation", output_format: request.outputFormat };
  if (request.mode !== "auto") imageTool.action = request.mode;
  const timeout = bridge.config.IMAGE_TIMEOUT_MS > 0 ? AbortSignal.timeout(bridge.config.IMAGE_TIMEOUT_MS) : undefined;
  const signal = combineSignals(request.signal, timeout);
  const accountId = codexAccountId(accessToken);
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      ...authHeaders,
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      accept: "text/event-stream",
      "content-type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": "pi (ai-tg-bot)",
    },
    body: JSON.stringify({
      model: bridge.providerRouter.codexModel("main").id,
      instructions: "",
      input: [{ role: "user", content }],
      tools: [imageTool],
      tool_choice: { type: "image_generation" },
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
      client_metadata: { "x-codex-installation-id": "ai-tg-bot" },
    }),
    signal,
  });
  if (!response.ok) throw responseError(response);
  const parsed = await parseCodexImageSse(response, mimeFor(request.outputFormat));
  return {
    bytes: Buffer.from(parsed.data, "base64"),
    mimeType: parsed.mimeType,
    revisedPrompt: parsed.revisedPrompt,
    provider: "codex",
    model: bridge.providerRouter.codexModel("main").id,
  };
}

async function requestOpenRouterImage(
  bridge: TelegramImageBridge,
  request: {
    prompt: string;
    outputFormat: "png" | "jpeg" | "webp";
    references: ImageContent[];
    signal?: AbortSignal;
  },
): Promise<GeneratedImage> {
  const timeout = bridge.config.IMAGE_TIMEOUT_MS > 0 ? AbortSignal.timeout(bridge.config.IMAGE_TIMEOUT_MS) : undefined;
  const signal = combineSignals(request.signal, timeout);
  const response = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.config.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://github.com/karilaa/ai-tg-bot",
      "X-Title": "ai-tg-bot",
    },
    body: JSON.stringify({
      model: bridge.config.OPENROUTER_IMAGE_MODEL,
      prompt: request.prompt,
      n: 1,
      output_format: request.outputFormat,
      input_references: request.references.map((image) => ({
        type: "image_url",
        image_url: { url: dataUrl(image) },
      })),
    }),
    signal,
  });
  if (!response.ok) throw responseError(response);
  const body = await response.json() as {
    data?: Array<{ b64_json?: string; media_type?: string; revised_prompt?: string }>;
  };
  const image = body.data?.[0];
  if (!image?.b64_json) throw new Error("OpenRouter returned no generated image.");
  return {
    bytes: Buffer.from(stripDataUrl(image.b64_json), "base64"),
    mimeType: image.media_type ?? mimeFor(request.outputFormat),
    revisedPrompt: image.revised_prompt,
    provider: "openrouter",
    model: bridge.config.OPENROUTER_IMAGE_MODEL,
  };
}

async function parseCodexImageSse(
  response: Response,
  fallbackMimeType: string,
): Promise<{ data: string; mimeType: string; revisedPrompt?: string }> {
  if (!response.body) throw new Error("Codex image response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const item = imageItem(event.item) ?? imageItem(event);
      const raw = typeof item?.result === "string" ? item.result : typeof item?.b64_json === "string" ? item.b64_json : undefined;
      if (raw && (item?.status === undefined || item.status === "completed")) {
        const parts = dataUrlParts(raw, fallbackMimeType);
        await reader.cancel().catch(() => undefined);
        return {
          ...parts,
          revisedPrompt: typeof item?.revised_prompt === "string" ? item.revised_prompt : undefined,
        };
      }
      if (event.type === "response.failed" || event.type === "error") {
        throw new Error(typeof event.message === "string" ? event.message : "Codex image request failed.");
      }
    }
  }
  throw new Error("Codex returned no completed image_generation result.");
}

function imageItem(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && (value as Record<string, unknown>).type === "image_generation_call"
    ? value as Record<string, unknown>
    : undefined;
}

function dataUrl(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function stripDataUrl(value: string): string {
  const match = value.match(/^data:[^;,]+;base64,(.*)$/s);
  return (match?.[1] ?? value).trim();
}

function dataUrlParts(value: string, fallbackMimeType: string): { data: string; mimeType: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  return { mimeType: match?.[1] ?? fallbackMimeType, data: (match?.[2] ?? value).trim() };
}

function mimeFor(format: "png" | "jpeg" | "webp"): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second]);
  return first ?? second;
}

function codexAccountId(accessToken: string): string {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) throw new Error("missing JWT payload");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = decoded["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing chatgpt account id");
    return accountId;
  } catch {
    throw new Error("Codex OAuth access token does not contain a ChatGPT account id.");
  }
}

function responseError(response: Response): Error & { status: number; headers: Record<string, string> } {
  const error = new Error(`Image request failed (${response.status} ${response.statusText})`) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  error.status = response.status;
  error.headers = Object.fromEntries(response.headers.entries());
  return error;
}

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

function errorResetAt(error: unknown): number | undefined {
  const headers = error && typeof error === "object" ? (error as { headers?: Record<string, string> }).headers : undefined;
  return resetAtFromHeaders(headers);
}
