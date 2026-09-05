// Codex image request structure is adapted from pi-better-openai (MIT).
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent, ProviderHeaders } from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { CommandRuntime } from "../sandbox/types.js";
import { E2B_WORKSPACE, sandboxWorkspaceFile } from "../e2b/paths.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { detectImageMediaType } from "../files/mediaType.js";
import { createInspectWorkspaceImagesTool } from "../ai/tools/inspectWorkspaceImages.js";
import { threadChainScope, type ThreadScope } from "../memory/retrieval.js";
import { resetAtFromHeaders, retryableCodexError } from "./circuit.js";
import type { PiProviderRouter } from "./provider.js";

import type { OutgoingFiles } from "../files/outgoingFiles.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
const MAX_REFERENCES = 5;

export interface ChatImageBridge {
  config: AppConfig;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  logger?: Logger;
  modelRegistry: ModelRegistry;
  providerRouter: PiProviderRouter;
  outgoingFiles: OutgoingFiles;
  commandRuntime?: CommandRuntime;
  holdCommandActivity?(): void;
  activeMessageId?: number;
  currentScope?(): Promise<ThreadScope>;
  resolveImage(
    file: FileRow,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mimeType: string }>;
}

type ImageParams = {
  prompt: string;
  mode?: "auto" | "generate" | "edit";
  reference_file_ids?: number[];
  output_format?: "png" | "jpeg" | "webp";
  reference_paths?: string[];
};

type GeneratedImage = {
  bytes: Buffer;
  mimeType: string;
  revisedPrompt?: string;
  provider: "codex" | "openrouter";
  model: string;
};

export function createGenerateImagePiTool(
  bridge: ChatImageBridge,
): ToolDefinition {
  return {
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate or edit one image as a reusable workspace asset and return an image preview for your own inspection. Use for requested images or supporting artwork in documents and presentations. Retrieve real sources for factual photos and logos. Nothing is sent automatically and the turn continues. Inspect the returned image, then embed its path or send it with finish_response/create_file. Multiple calls are allowed within the turn budget. References can be current-thread image file IDs or workspace image paths, five total.",
    parameters: Type.Object(
      {
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        mode: Type.Optional(
          Type.Union(
            [
              Type.Literal("auto"),
              Type.Literal("generate"),
              Type.Literal("edit"),
            ],
            { default: "auto" },
          ),
        ),
        reference_file_ids: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1 }), {
            maxItems: MAX_REFERENCES,
            default: [],
          }),
        ),
        output_format: Type.Optional(
          Type.Union(
            [Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")],
            { default: "png" },
          ),
        ),
        reference_paths: Type.Optional(
          Type.Array(Type.String({ pattern: "^/", maxLength: 4096 }), {
            maxItems: MAX_REFERENCES,
            default: [],
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as ImageParams;
      const runtime = bridge.commandRuntime;
      if (!runtime?.writeWorkspaceFile)
        throw new Error("E2B image workspace support is unavailable.");
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error("Image prompt is empty.");
      const referenceIds = [...new Set(params.reference_file_ids ?? [])];
      const referencePaths = [
        ...new Set((params.reference_paths ?? []).map(sandboxWorkspaceFile)),
      ];
      if (referenceIds.length + referencePaths.length > MAX_REFERENCES)
        throw new Error(
          `At most ${MAX_REFERENCES} reference images are supported.`,
        );
      const mode = params.mode ?? "auto";
      if (mode === "edit" && !referenceIds.length && !referencePaths.length)
        throw new Error(
          "Edit mode requires at least one reference_file_id or reference_path.",
        );
      signal?.throwIfAborted();
      bridge.holdCommandActivity?.();
      const command = (name: string, args: string[]) =>
        runtime.execute({
          userId: bridge.user.tg_id,
          threadId: bridge.thread.id,
          command: name,
          args,
          env: { TZ: "UTC" },
          stdin: "",
          workingDir: E2B_WORKSPACE,
          timeoutMs: bridge.config.BASH_TIMEOUT_MS,
          maxOutputChars: 2000,
          signal,
        });
      const ready = await command("magick", ["-version"]);
      if (ready.exitCode !== 0 || ready.timedOut || ready.error)
        throw new Error(
          "Image inspection is unavailable in this sandbox. Generation was not started.",
        );
      const writable = await command("test", ["-w", E2B_WORKSPACE]);
      if (writable.exitCode !== 0 || writable.timedOut || writable.error)
        throw new Error(
          "Image workspace is not writable. Generation was not started.",
        );
      const outputFormat = params.output_format ?? "png";
      const references = await loadReferences(bridge, referenceIds, signal);
      for (const virtualPath of referencePaths) {
        const file = await runtime.readWorkspaceFile({
          userId: bridge.user.tg_id,
          threadId: bridge.thread.id,
          virtualPath,
          maxBytes: MAX_FILE_BYTES,
          signal,
        });
        const mimeType = detectImageMediaType(file.bytes);
        if (!mimeType)
          throw new Error(`Unsupported reference image: ${virtualPath}`);
        references.push({
          type: "image",
          data: file.bytes.toString("base64"),
          mimeType,
        });
      }
      onUpdate?.({
        content: [{ type: "text", text: "Generating image..." }],
        details: {
          reference_file_ids: referenceIds,
          reference_paths: referencePaths,
        },
      });
      const generated = await generateWithFallback(bridge, {
        prompt,
        mode,
        outputFormat,
        references,
        signal,
      });
      signal?.throwIfAborted();
      if (!generated.bytes.length || generated.bytes.length > MAX_FILE_BYTES)
        throw new Error(
          "Generated image is empty or exceeds the file size limit.",
        );
      const actualMime = detectImageMediaType(generated.bytes);
      if (!actualMime)
        throw new Error("Provider returned an unsupported image file.");
      const extension =
        actualMime === "image/jpeg" ? "jpg" : actualMime.split("/")[1];
      const virtualPath = `/assets/generated-${randomUUID()}.${extension}`;
      await runtime.writeWorkspaceFile({
        userId: bridge.user.tg_id,
        threadId: bridge.thread.id,
        virtualPath,
        bytes: generated.bytes,
        signal,
      });
      const inspected = await createInspectWorkspaceImagesTool(bridge).execute(
        { paths: [virtualPath] },
        signal,
      );
      if ("error" in inspected)
        throw new Error(
          `Image saved at ${virtualPath}, but preview failed: ${inspected.error}. Inspect this file before regenerating.`,
        );
      const dimensions = await command("magick", [
        "identify",
        "-format",
        "%w %h",
        `${sandboxWorkspaceFile(virtualPath)}[0]`,
      ]);
      const [width, height] = dimensions.stdout.trim().split(/\s+/).map(Number);
      signal?.throwIfAborted();
      if (
        dimensions.exitCode !== 0 ||
        dimensions.timedOut ||
        dimensions.error ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width! <= 0 ||
        height! <= 0
      )
        throw new Error(
          `Image saved at ${virtualPath}, but dimensions could not be read.`,
        );
      const result = {
        generated_image: true,
        path: sandboxWorkspaceFile(virtualPath),
        name: virtualPath.split("/").at(-1),
        media_type: actualMime,
        size: generated.bytes.length,
        width,
        height,
        provider: generated.provider,
        model: generated.model,
        mode,
        output_format: actualMime.split("/")[1],
        reference_file_ids: referenceIds,
        reference_paths: referencePaths,
        revised_prompt: generated.revisedPrompt ?? null,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(result) },
          ...inspected.images.map((image) => ({
            type: "image" as const,
            data: image.image_base64,
            mimeType: image.media_type,
          })),
        ],
        details: result,
      };
    },
  } as ToolDefinition;
}

async function loadReferences(
  bridge: ChatImageBridge,
  referenceIds: number[],
  signal?: AbortSignal,
): Promise<ImageContent[]> {
  if (!referenceIds.length) return [];
  const allowedFiles = new Set([
    ...(
      await (bridge.currentScope?.() ??
        threadChainScope(bridge.repos, bridge.thread, bridge.activeMessageId))
    ).fileIds,
    ...bridge.outgoingFiles.items.map((attachment) => attachment.fileId),
  ]);
  const rows = await bridge.repos.files.listByIds(referenceIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const images: ImageContent[] = [];
  for (const id of referenceIds) {
    const file = byId.get(id);
    if (!file || file.type !== "image" || !allowedFiles.has(file.id)) {
      throw new Error(
        `Reference image #${id} is not available in this thread.`,
      );
    }
    const resolved = await bridge.resolveImage(file, signal);
    images.push({
      type: "image",
      data: resolved.bytes.toString("base64"),
      mimeType: resolved.mimeType,
    });
  }
  return images;
}

async function generateWithFallback(
  bridge: ChatImageBridge,
  request: {
    prompt: string;
    mode: "auto" | "generate" | "edit";
    outputFormat: "png" | "jpeg" | "webp";
    references: ImageContent[];
    signal?: AbortSignal;
  },
): Promise<GeneratedImage> {
  const codexModel = bridge.providerRouter.codexModel("main");
  if (!bridge.modelRegistry.hasConfiguredAuth(codexModel))
    return requestOpenRouterImage(bridge, request);
  const attempt = bridge.providerRouter.circuit.acquire();
  if (!attempt.allowed) return requestOpenRouterImage(bridge, request);
  try {
    const auth = await bridge.modelRegistry.getApiKeyAndHeaders(codexModel);
    if (!auth.ok || !auth.apiKey)
      throw new Error(
        auth.ok ? "Missing openai-codex OAuth token" : auth.error,
      );
    const result = await requestCodexImage(
      bridge,
      request,
      auth.apiKey,
      auth.headers,
    );
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
    bridge.logger?.warn(
      "Codex image generation failed; falling back to OpenRouter",
      { status, error: message },
    );
    return requestOpenRouterImage(bridge, request);
  } finally {
    if (attempt.probe && bridge.providerRouter.circuit.state().probeActive) {
      bridge.providerRouter.circuit.releaseProbe();
    }
  }
}

async function requestCodexImage(
  bridge: ChatImageBridge,
  request: {
    prompt: string;
    mode: "auto" | "generate" | "edit";
    outputFormat: "png" | "jpeg" | "webp";
    references: ImageContent[];
    signal?: AbortSignal;
  },
  accessToken: string,
  authHeaders?: ProviderHeaders,
): Promise<GeneratedImage> {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: request.prompt },
  ];
  for (const image of request.references) {
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: dataUrl(image),
    });
  }
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    output_format: request.outputFormat,
  };
  if (request.mode !== "auto") imageTool.action = request.mode;
  const timeout =
    bridge.config.IMAGE_TIMEOUT_MS > 0
      ? AbortSignal.timeout(bridge.config.IMAGE_TIMEOUT_MS)
      : undefined;
  const signal = combineSignals(request.signal, timeout);
  const accountId = codexAccountId(accessToken);
  const requestHeaders = Object.fromEntries(
    Object.entries(authHeaders ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      ...requestHeaders,
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
  if (!response.ok) throw await responseError(response);
  const parsed = await parseCodexImageSse(
    response,
    mimeFor(request.outputFormat),
  );
  return {
    bytes: Buffer.from(parsed.data, "base64"),
    mimeType: parsed.mimeType,
    revisedPrompt: parsed.revisedPrompt,
    provider: "codex",
    model: bridge.providerRouter.codexModel("main").id,
  };
}

async function requestOpenRouterImage(
  bridge: ChatImageBridge,
  request: {
    prompt: string;
    outputFormat: "png" | "jpeg" | "webp";
    references: ImageContent[];
    signal?: AbortSignal;
  },
): Promise<GeneratedImage> {
  const timeout =
    bridge.config.IMAGE_TIMEOUT_MS > 0
      ? AbortSignal.timeout(bridge.config.IMAGE_TIMEOUT_MS)
      : undefined;
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
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as {
    data?: Array<{
      b64_json?: string;
      media_type?: string;
      revised_prompt?: string;
    }>;
  };
  const image = body.data?.[0];
  if (!image?.b64_json)
    throw new Error("OpenRouter returned no generated image.");
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
  let latestPartial:
    | { data: string; mimeType: string; revisedPrompt?: string }
    | undefined;
  let imageCompleted = false;
  let partialImages = 0;
  const observedEvents = new Set<string>();
  const observedImageStatuses = new Set<string>();
  const consume = (
    chunk: string,
  ): { data: string; mimeType: string; revisedPrompt?: string } | undefined => {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (typeof event.type === "string") observedEvents.add(event.type);
    const item =
      imageItem(event.item) ??
      imageItem(event) ??
      responseImageItem(event.response);
    if (typeof item?.status === "string")
      observedImageStatuses.add(item.status);
    if (
      item?.status === "completed" ||
      event.type === "response.image_generation_call.completed" ||
      event.type === "response.completed"
    ) {
      imageCompleted = true;
    }
    const raw =
      typeof item?.result === "string"
        ? item.result
        : typeof item?.b64_json === "string"
          ? item.b64_json
          : undefined;
    if (raw && (item?.status === undefined || item.status === "completed")) {
      return {
        ...dataUrlParts(raw, fallbackMimeType),
        revisedPrompt:
          typeof item?.revised_prompt === "string"
            ? item.revised_prompt
            : undefined,
      };
    }
    if (
      (event.type === "image_generation.completed" ||
        event.type === "image_edit.completed") &&
      typeof event.b64_json === "string"
    ) {
      return dataUrlParts(
        event.b64_json,
        mimeFromEvent(event, fallbackMimeType),
      );
    }
    if (
      event.type === "response.image_generation_call.partial_image" &&
      typeof event.partial_image_b64 === "string"
    ) {
      partialImages += 1;
      latestPartial = dataUrlParts(
        event.partial_image_b64,
        mimeFromEvent(event, fallbackMimeType),
      );
    }
    if (event.type === "response.failed" || event.type === "error") {
      const nested =
        event.error && typeof event.error === "object"
          ? (event.error as Record<string, unknown>)
          : undefined;
      throw new Error(
        typeof event.message === "string"
          ? event.message
          : typeof nested?.message === "string"
            ? nested.message
            : "Codex image request failed.",
      );
    }
    return undefined;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const parsed = consume(chunk);
      if (parsed) {
        await reader.cancel().catch(() => undefined);
        return parsed;
      }
    }
  }
  const final = consume(buffer);
  if (final) return final;
  // The hosted Codex endpoint can omit the base64 result from output_item.done
  // after streaming a usable final partial image. Keep only the newest partial
  // in memory and return it once the stream has completed.
  if (imageCompleted && latestPartial) return latestPartial;
  const diagnostics = [
    observedEvents.size ? `events=${[...observedEvents].join(",")}` : undefined,
    observedImageStatuses.size
      ? `image_statuses=${[...observedImageStatuses].join(",")}`
      : undefined,
    `partial_images=${partialImages}`,
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(
    `Codex image network stream ended before a completed image_generation result (${diagnostics}).`,
  );
}

function imageItem(value: unknown): Record<string, unknown> | undefined {
  return value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).type === "image_generation_call"
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseImageItem(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = (value as Record<string, unknown>).output;
  return Array.isArray(output)
    ? output.map(imageItem).find(Boolean)
    : undefined;
}

function mimeFromEvent(
  event: Record<string, unknown>,
  fallbackMimeType: string,
): string {
  const format = event.output_format;
  return format === "jpeg" || format === "png" || format === "webp"
    ? mimeFor(format)
    : fallbackMimeType;
}

function dataUrl(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function stripDataUrl(value: string): string {
  const match = value.match(/^data:[^;,]+;base64,(.*)$/s);
  return (match?.[1] ?? value).trim();
}

function dataUrlParts(
  value: string,
  fallbackMimeType: string,
): { data: string; mimeType: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  return {
    mimeType: match?.[1] ?? fallbackMimeType,
    data: (match?.[2] ?? value).trim(),
  };
}

function mimeFor(format: "png" | "jpeg" | "webp"): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function combineSignals(
  first?: AbortSignal,
  second?: AbortSignal,
): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second]);
  return first ?? second;
}

function codexAccountId(accessToken: string): string {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) throw new Error("missing JWT payload");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = decoded["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId)
      throw new Error("missing chatgpt account id");
    return accountId;
  } catch {
    throw new Error(
      "Codex OAuth access token does not contain a ChatGPT account id.",
    );
  }
}

async function responseError(
  response: Response,
): Promise<Error & { status: number; headers: Record<string, string> }> {
  const detail = await response
    .text()
    .then(imageProviderErrorDetail)
    .catch(() => undefined);
  const status = [String(response.status), response.statusText.trim()]
    .filter(Boolean)
    .join(" ");
  const error = new Error(
    [`Image request failed (${status})`, detail].filter(Boolean).join(": "),
  ) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  error.status = response.status;
  error.headers = Object.fromEntries(
    [
      "retry-after",
      "x-ratelimit-reset",
      "x-ratelimit-reset-requests",
      "x-ratelimit-reset-tokens",
    ].flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value] as const];
    }),
  );
  return error;
}

function imageProviderErrorDetail(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  let detail: unknown;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const nested =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>)
        : undefined;
    detail =
      nested?.message ??
      parsed.message ??
      (typeof parsed.error === "string" ? parsed.error : undefined);
  } catch {
    detail = trimmed;
  }
  if (typeof detail !== "string" || !detail.trim()) return undefined;
  return (
    detail
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|e2b)_[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || undefined
  );
}

function httpStatus(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

function errorResetAt(error: unknown): number | undefined {
  const headers =
    error && typeof error === "object"
      ? (error as { headers?: Record<string, string> }).headers
      : undefined;
  return resetAtFromHeaders(headers);
}
