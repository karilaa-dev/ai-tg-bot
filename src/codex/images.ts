import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createInspectWorkspaceImagesTool } from "../ai/tools/inspectWorkspaceImages.js";
import { defineBotTool } from "../ai/tools/types.js";
import { E2B_WORKSPACE, sandboxWorkspaceFile } from "../e2b/paths.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { detectImageMediaType } from "../files/mediaType.js";
import { raceWithAbort } from "../files/cancel.js";
import { asRecord } from "../util/records.js";
import type { ThreadBridge } from "./threadBridge.js";

const MAX_REFERENCES = 5;
const IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";
type ImageBridge = Pick<ThreadBridge, "config" | "repos" | "user" | "thread" | "logger" | "commandRuntime" | "outgoingFiles" | "currentScope" | "resolveImage">;

const ImageSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  mode: z.enum(["auto", "generate", "edit"]).optional(),
  reference_file_ids: z.array(z.number().int().positive()).max(MAX_REFERENCES).optional(),
  reference_paths: z.array(z.string().regex(/^\//).max(4096)).max(MAX_REFERENCES).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
}).strict();

/** Image generation for the rare OpenRouter turn; native Codex uses its own image tool. */
export function createGenerateImageTool(bridge: ImageBridge) {
  return defineBotTool({
    holdsCommandActivity: true,
    description: "Generate one image or generatively edit supplied images when the user requests it. Returns a reusable workspace path and a model-only preview. Inspect the result, then send it with finish_response/create_file. No attachment is sent automatically. References can be current-thread image file IDs or workspace image paths, five total. Use installed tools for cropping, resizing, labels, and layout.",
    inputSchema: ImageSchema,
    async execute(rawParams, signal) {
      const params = ImageSchema.parse(rawParams);
      const runtime = bridge.commandRuntime;
      if (!runtime?.writeWorkspaceFile) throw new Error("E2B image workspace support is unavailable.");
      const ids = [...new Set(params.reference_file_ids ?? [])];
      const paths = [...new Set((params.reference_paths ?? []).map(sandboxWorkspaceFile))];
      if (ids.length + paths.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images are supported.`);
      const mode = params.mode ?? "auto";
      if (mode === "edit" && !ids.length && !paths.length) throw new Error("Edit mode requires at least one reference_file_id or reference_path.");
      signal?.throwIfAborted();
      const command = (name: string, args: string[]) => runtime.execute({
        userId: bridge.user.tg_id, threadId: bridge.thread.id, command: name, args,
        env: { TZ: "UTC" }, stdin: "", workingDir: E2B_WORKSPACE,
        timeoutMs: bridge.config.BASH_TIMEOUT_MS, maxOutputChars: 2000, signal,
      });
      const ready = await command("magick", ["-version"]);
      if (ready.exitCode !== 0 || ready.timedOut || ready.error) throw new Error("Image inspection is unavailable in this sandbox. Generation was not started.");
      const writable = await command("test", ["-w", E2B_WORKSPACE]);
      if (writable.exitCode !== 0 || writable.timedOut || writable.error) throw new Error("Image workspace is not writable. Generation was not started.");
      const references: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      if (ids.length) {
        const allowed = new Set([...(await bridge.currentScope()).fileIds, ...bridge.outgoingFiles.items.map(file => file.fileId)]);
        const rows = new Map((await bridge.repos.files.listByIds(ids)).map(file => [file.id, file]));
        for (const id of ids) {
          const file = rows.get(id);
          if (!file || file.type !== "image" || !allowed.has(id)) throw new Error(`Reference image #${id} is not available in this thread.`);
          const resolved = await bridge.resolveImage(file, signal);
          if (!resolved.bytes.length || resolved.bytes.length > MAX_FILE_BYTES) throw new Error(`Reference image #${id} exceeds the file size limit.`);
          references.push(imageReference(resolved.bytes, resolved.mimeType));
        }
      }
      for (const virtualPath of paths) {
        const file = await runtime.readWorkspaceFile({ userId: bridge.user.tg_id, threadId: bridge.thread.id, virtualPath, maxBytes: MAX_FILE_BYTES, signal });
        const mime = detectImageMediaType(file.bytes);
        if (!mime) throw new Error(`Unsupported reference image: ${virtualPath}`);
        references.push(imageReference(file.bytes, mime));
      }
      const timeout = bridge.config.IMAGE_TIMEOUT_MS > 0 ? AbortSignal.timeout(bridge.config.IMAGE_TIMEOUT_MS) : undefined;
      const requestSignal = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
      const response = await raceWithAbort(fetch(IMAGE_ENDPOINT, {
        method: "POST", headers: { authorization: `Bearer ${bridge.config.OPENROUTER_API_KEY}`, "content-type": "application/json", "HTTP-Referer": "https://github.com/karilaa/ai-tg-bot", "X-Title": "ai-tg-bot" },
        body: JSON.stringify({ model: bridge.config.OPENROUTER_IMAGE_MODEL, prompt: params.prompt, n: 1, output_format: params.output_format ?? "png", input_references: references }),
        signal: requestSignal,
      }), requestSignal);
      if (!response.ok) {
        const body = await raceWithAbort(response.json().catch(() => undefined), requestSignal);
        const message = asRecord(asRecord(body)?.error)?.message;
        throw new Error(`OpenRouter image request failed (${response.status})${typeof message === "string" ? `: ${message}` : "."}`);
      }
      const body = asRecord(await raceWithAbort(response.json(), requestSignal));
      const image = asRecord(Array.isArray(body?.data) ? body.data[0] : undefined);
      if (typeof image?.b64_json !== "string" || !image.b64_json) throw new Error("OpenRouter returned no generated image.");
      const encoded = image.b64_json.replace(/^data:[^,]*;base64,/i, "");
      if (encoded.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw new Error("Generated image exceeds the file size limit.");
      const bytes = Buffer.from(encoded, "base64");
      const mime = detectImageMediaType(bytes);
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Generated image is empty or exceeds the file size limit.");
      if (!mime) throw new Error("Provider returned an unsupported image file.");
      signal?.throwIfAborted();
      const extension = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
      const virtualPath = `/assets/generated-${randomUUID()}.${extension}`;
      await runtime.writeWorkspaceFile({ userId: bridge.user.tg_id, threadId: bridge.thread.id, virtualPath, bytes, signal });
      const inspected = await createInspectWorkspaceImagesTool(bridge).execute({ paths: [virtualPath] }, signal);
      if ("error" in inspected) throw new Error(`Image saved at ${virtualPath}, but preview failed: ${inspected.error}. Inspect this file before regenerating.`);
      const dimensions = await command("magick", ["identify", "-format", "%w %h", `${sandboxWorkspaceFile(virtualPath)}[0]`]);
      const [width, height] = dimensions.stdout.trim().split(/\s+/).map(Number);
      if (dimensions.exitCode !== 0 || dimensions.timedOut || dimensions.error || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) throw new Error(`Image saved at ${virtualPath}, but dimensions could not be read.`);
      signal?.throwIfAborted();
      return {
        generated_image: true as const, path: sandboxWorkspaceFile(virtualPath), name: virtualPath.split("/").at(-1), media_type: mime, size: bytes.length,
        width: width!, height: height!, provider: "openrouter" as const, model: bridge.config.OPENROUTER_IMAGE_MODEL,
        mode, output_format: mime.split("/")[1], reference_file_ids: ids, reference_paths: paths,
        revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : null, previews: inspected.images,
      };
    },
    toModelOutput: ({ output }) => {
      const { previews, ...metadata } = output;
      return { type: "content", value: [
        { type: "text", text: JSON.stringify(metadata) },
        ...previews.map(image => ({ type: "image-data", data: image.image_base64, mediaType: image.media_type })),
      ] };
    },
    toToolDetails: ({ output }) => { const { previews, ...metadata } = output; return metadata; },
  });
}

function imageReference(bytes: Buffer, mime: string): { type: "image_url"; image_url: { url: string } } {
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } };
}
