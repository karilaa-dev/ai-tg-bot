import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { resolveThreadFileDescriptors } from "../../e2b/threadFiles.js";
import { E2B_WORKSPACE } from "../../e2b/paths.js";
import { MAX_FILE_BYTES } from "../../files/limits.js";
import { getScopedFile } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const MAX_PAGES_PER_CALL = 4;
const PDF_RENDER_DPI = 144;
const PDF_RENDER_MAX_DIMENSION = 2_000;
const PDF_RENDER_JPEG_QUALITY = 85;

type RenderedPdfPages =
  | { error: string; error_code?: string }
  | {
      file_id: number;
      pages: Array<{
        page: number;
        media_type: "image/jpeg";
        size: number;
        image_base64: string;
      }>;
    };

export function createRenderPdfPagesTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      `Render selected pages of an attached PDF as model-only vision images. Use after PDF Inspector classifies a PDF as scanned, image-based, mixed, or reports unreadable text. Accepts at most ${MAX_PAGES_PER_CALL} pages per call. The images are returned to the model and are not sent to Telegram.`,
    inputSchema: z.object({
      file_id: z.number().int().positive(),
      pages: z.array(z.number().int().positive()).min(1).max(MAX_PAGES_PER_CALL).default([1]),
    }),
    execute: async ({ file_id, pages }, signal): Promise<RenderedPdfPages> => {
      const startedAt = Date.now();
      if (!input.commandRuntime) return { error: "E2B command runtime is unavailable.", error_code: "runtime_unavailable" };
      const file = await getScopedFile(input, file_id);
      if (!file) return { error: "PDF was not found in this thread.", error_code: "file_not_found" };
      if (file.type !== "pdf" && file.mime_type !== "application/pdf") {
        return { error: "render_pdf_pages accepts PDF attachments only.", error_code: "not_pdf" };
      }
      const requestedPages = [...new Set(pages)];
      if (requestedPages.length > MAX_PAGES_PER_CALL) {
        return { error: `At most ${MAX_PAGES_PER_CALL} unique pages may be rendered per call.`, error_code: "too_many_pages" };
      }
      const descriptors = await resolveThreadFileDescriptors(input, signal, [file_id]);
      const descriptor = descriptors[0];
      if (!descriptor) return { error: "The PDF has no restorable source.", error_code: "source_unavailable" };
      const materialized = await input.commandRuntime.materializeFiles({
        userId: input.user.tg_id,
        threadId: input.thread.id,
        files: [descriptor],
        signal,
      });
      const restored = materialized.files.find((entry) => entry.fileId === file_id);
      if (!restored?.path) {
        return {
          error: "The PDF could not be restored in the sandbox.",
          error_code: restored?.errorCode ?? "restore_failed",
        };
      }

      const outputDir = path.posix.join(E2B_WORKSPACE, `.pdf-pages-${randomUUID()}`);
      const script = pdfRenderScript();
      try {
        const rendered = await input.commandRuntime.execute({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          command: "bash",
          args: ["-c", script, "bash", restored.path, outputDir, ...requestedPages.map(String)],
          env: { TZ: "UTC" },
          stdin: "",
          workingDir: E2B_WORKSPACE,
          timeoutMs: input.config.BASH_TIMEOUT_MS,
          maxOutputChars: input.config.BASH_MAX_OUTPUT_CHARS,
          signal,
        });
        if (rendered.exitCode !== 0) {
          return {
            error: rendered.error || rendered.stderr.trim() || `PDF rendering exited with ${String(rendered.exitCode)}.`,
            error_code: "render_failed",
          };
        }
        const images = [];
        for (const page of requestedPages) {
          const virtualPath = path.posix.join(outputDir, `page-${page}.jpg`);
          const image = await input.commandRuntime.readWorkspaceFile({
            userId: input.user.tg_id,
            threadId: input.thread.id,
            virtualPath,
            maxBytes: MAX_FILE_BYTES,
            signal,
          });
          images.push({
            page,
            media_type: "image/jpeg" as const,
            size: image.size,
            image_base64: image.bytes.toString("base64"),
          });
        }
        input.logger?.info("tool render_pdf_pages complete", {
          threadId: input.thread.id,
          fileId: file_id,
          pages: requestedPages,
          renderedPageCount: images.length,
          bytes: images.reduce((total, image) => total + image.size, 0),
          latencyMs: Date.now() - startedAt,
        });
        return { file_id, pages: images };
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
            text: `Rendered PDF file #${output.file_id}, pages ${output.pages.map((page) => page.page).join(", ")} for visual inspection.`,
          },
          ...output.pages.map((page) => ({
            type: "image-data",
            data: page.image_base64,
            mediaType: page.media_type,
          })),
        ],
      };
    },
    toToolDetails: ({ output }) => {
      if ("error" in output) return output;
      return {
        file_id: output.file_id,
        pages: output.pages.map(({ page, media_type, size }) => ({ page, media_type, size })),
      };
    },
  });
}

function pdfRenderScript(): string {
  return [
    "set -euo pipefail",
    "src=$1",
    "out_dir=$2",
    "shift 2",
    "command -v pdfinfo >/dev/null",
    "command -v pdftoppm >/dev/null",
    "command -v magick >/dev/null",
    "page_count=$(pdfinfo \"$src\" | awk '/^Pages:[[:space:]]*/ { print $2; exit }')",
    "case $page_count in ''|*[!0-9]*) printf 'Could not determine PDF page count.\\n' >&2; exit 2 ;; esac",
    "mkdir -p -- \"$out_dir\"",
    "for page in \"$@\"; do",
    "  if [ \"$page\" -lt 1 ] || [ \"$page\" -gt \"$page_count\" ]; then printf 'Page %s is outside 1-%s.\\n' \"$page\" \"$page_count\" >&2; exit 3; fi",
    `  pdftoppm -f "$page" -l "$page" -singlefile -r ${PDF_RENDER_DPI} -jpeg -jpegopt quality=${PDF_RENDER_JPEG_QUALITY} "$src" "$out_dir/raw-$page"`,
    `  magick "$out_dir/raw-$page.jpg" -auto-orient -resize '${PDF_RENDER_MAX_DIMENSION}x${PDF_RENDER_MAX_DIMENSION}>' -strip -quality ${PDF_RENDER_JPEG_QUALITY} "$out_dir/page-$page.jpg"`,
    "  rm -f -- \"$out_dir/raw-$page.jpg\"",
    "done",
  ].join("\n");
}
