import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { E2B_WORKSPACE, sandboxWorkspaceFile } from "../../e2b/paths.js";
import { MAX_FILE_BYTES } from "../../files/limits.js";
import { normalizeBashCwd } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const MAX_IMAGES_PER_CALL = 4;
const MAX_IMAGE_DIMENSION = 2_000;
const JPEG_QUALITY = 90;

export type InspectWorkspaceImagesResult =
  | { error: string; error_code?: string; missing?: string[]; template?: string }
  | {
      inspected: true;
      images: Array<{
        path: string;
        media_type: "image/jpeg";
        width: number;
        height: number;
        size: number;
        image_base64: string;
      }>;
    };

export const ImagePathsSchema = z.array(
  z.string().regex(/^\//, "path must be an absolute virtual path"),
).min(1).max(MAX_IMAGES_PER_CALL).superRefine((paths, context) => {
  const normalized = paths.map((value) => sandboxWorkspaceFile(normalizeBashCwd(value)));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", message: "paths must be unique" });
  }
});

export function createInspectWorkspaceImagesTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      `Inspect up to ${MAX_IMAGES_PER_CALL} images from this thread's E2B workspace as model-only vision input. Use this to inspect every final collage or edited raster image before create_file. Check sharpness, accidental blur, crop, distortion, seams, borders, layout, and whether the result matches the request. These previews are never sent to Telegram.`,
    inputSchema: z.object({ paths: ImagePathsSchema }),
    execute: async ({ paths }, signal): Promise<InspectWorkspaceImagesResult> => {
      if (!input.commandRuntime) {
        return { error: "E2B command runtime is unavailable.", error_code: "runtime_unavailable" };
      }
      const normalizedPaths = paths.map(normalizeBashCwd);
      const sourcePaths = normalizedPaths.map(sandboxWorkspaceFile);
      const outputName = `.image-inspection-${randomUUID()}`;
      const outputDir = path.posix.join(E2B_WORKSPACE, outputName);
      const startedAt = Date.now();
      try {
        input.logger?.info("tool inspect_workspace_images starting", {
          threadId: input.thread.id,
          images: normalizedPaths.length,
        });
        const rendered = await input.commandRuntime.execute({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          command: "bash",
          args: ["-c", inspectionScript(), "bash", outputDir, ...sourcePaths],
          env: { TZ: "UTC" },
          stdin: "",
          workingDir: E2B_WORKSPACE,
          timeoutMs: input.config.BASH_TIMEOUT_MS,
          maxOutputChars: input.config.BASH_MAX_OUTPUT_CHARS,
          signal,
        });
        if (rendered.exitCode === 127 && rendered.stderr.includes("MISSING:magick")) {
          return {
            error: "tool_unavailable",
            error_code: "tool_unavailable",
            missing: ["magick"],
            template: input.config.E2B_TEMPLATE,
          };
        }
        if (rendered.exitCode !== 0 || rendered.timedOut || rendered.error) {
          return {
            error: rendered.error || rendered.stderr.trim() || `Image inspection exited with ${String(rendered.exitCode)}.`,
            error_code: "inspection_failed",
          };
        }
        const dimensions = parseDimensions(rendered.stdout, normalizedPaths.length);
        if (!dimensions) {
          return { error: "Image inspection returned invalid dimensions.", error_code: "invalid_output" };
        }
        const images = [];
        for (let index = 0; index < normalizedPaths.length; index += 1) {
          const preview = await input.commandRuntime.readWorkspaceFile({
            userId: input.user.tg_id,
            threadId: input.thread.id,
            virtualPath: path.posix.join(outputDir, `image-${index + 1}.jpg`),
            maxBytes: MAX_FILE_BYTES,
            signal,
          });
          const dimension = dimensions[index]!;
          images.push({
            path: normalizedPaths[index]!,
            media_type: "image/jpeg" as const,
            width: dimension.width,
            height: dimension.height,
            size: preview.size,
            image_base64: preview.bytes.toString("base64"),
          });
        }
        input.logger?.info("tool inspect_workspace_images complete", {
          threadId: input.thread.id,
          images: images.length,
          bytes: images.reduce((total, image) => total + image.size, 0),
          latencyMs: Date.now() - startedAt,
        });
        return { inspected: true, images };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        input.logger?.warn("tool inspect_workspace_images failed", {
          threadId: input.thread.id,
          images: normalizedPaths.length,
          error: String(error),
        });
        return { error: String(error), error_code: "inspection_failed" };
      } finally {
        await input.commandRuntime.execute({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          command: "rm",
          args: ["-rf", "--", outputDir],
          env: { TZ: "UTC" },
          stdin: "",
          workingDir: E2B_WORKSPACE,
          timeoutMs: Math.min(input.config.BASH_TIMEOUT_MS, 10_000),
          maxOutputChars: 1_000,
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
    },
    toModelOutput: ({ output }) => {
      if ("error" in output) return { type: "error-json", value: output };
      return {
        type: "content",
        value: [
          {
            type: "text",
            text: `Inspected ${output.images.length} workspace image${output.images.length === 1 ? "" : "s"}: ${output.images.map((image) => `${image.path} (${image.width}x${image.height})`).join(", ")}.`,
          },
          ...output.images.map((image) => ({
            type: "image-data",
            data: image.image_base64,
            mediaType: image.media_type,
          })),
        ],
      };
    },
    toToolDetails: ({ output }) => {
      if ("error" in output) return output;
      return {
        inspected: output.inspected,
        images: output.images.map(({ path, media_type, width, height, size }) => ({
          path,
          media_type,
          width,
          height,
          size,
        })),
      };
    },
  });
}

function inspectionScript(): string {
  return [
    "set -euo pipefail",
    "out_dir=$1",
    "shift",
    "if ! command -v magick >/dev/null 2>&1; then printf 'MISSING:magick\\n' >&2; exit 127; fi",
    "mkdir -p -- \"$out_dir\"",
    "index=0",
    "for source in \"$@\"; do",
    "  index=$((index + 1))",
    "  if [ ! -f \"$source\" ]; then printf 'Image does not exist: %s\\n' \"$source\" >&2; exit 2; fi",
    `  magick \"$source[0]\" -auto-orient -background white -alpha remove -alpha off -resize '${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}>' -strip -quality ${JPEG_QUALITY} \"$out_dir/image-$index.jpg\"`,
    "  magick identify -format \"$index %w %h\\n\" \"$out_dir/image-$index.jpg\"",
    "done",
  ].join("\n");
}

function parseDimensions(stdout: string, expected: number): Array<{ width: number; height: number }> | undefined {
  const rows = stdout.trim().split("\n").filter(Boolean);
  if (rows.length !== expected) return undefined;
  const parsed = rows.map((row, position) => {
    const [rawIndex, rawWidth, rawHeight] = row.trim().split(/\s+/u);
    const index = Number(rawIndex);
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (index !== position + 1 || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      return undefined;
    }
    return { width, height };
  });
  return parsed.every(Boolean) ? parsed as Array<{ width: number; height: number }> : undefined;
}
