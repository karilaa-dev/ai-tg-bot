import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { sanitizeOfficeHtml } from "../../browserUse/html.js";
import { E2B_WORKSPACE, sandboxWorkspaceFile } from "../../e2b/paths.js";
import { resolveThreadFileDescriptors } from "../../e2b/threadFiles.js";
import { MAX_FILE_BYTES } from "../../files/limits.js";
import { normalizeBashCwd } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

type RenderOfficePreviewResult =
  | { error: string; missing?: string[]; template?: string; message?: string }
  | {
      rendered: true;
      path: string;
      page: number;
      media_type: string;
      size: number;
      image_base64: string;
      session_remaining_seconds: number;
    };

export function createRenderOfficePreviewTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Render one page or slide of an OfficeCLI-compatible DOCX, PPTX, or XLSX file from this thread's E2B workspace as a model-only PNG. For created/edited files, call this once for every slide in a PPTX and for every rendered page in a DOCX; inspect overlap, clipping, wrapping, contrast, spacing, and alignment before delivery. Previews are never sent to Telegram.",
    inputSchema: z.object({
      path: z.string().regex(/^\//, "path must be an absolute virtual path"),
      page: z.number().int().positive().default(1),
    }),
    execute: async ({ path: virtualPath, page = 1 }, signal): Promise<RenderOfficePreviewResult> => {
      const normalizedPath = normalizeBashCwd(virtualPath);
      const extension = path.posix.extname(normalizedPath).toLowerCase();
      if (![".docx", ".pptx", ".xlsx"].includes(extension)) {
        return { error: "Office preview path must end in .docx, .pptx, or .xlsx." };
      }
      if (!input.commandRuntime) return { error: "E2B command runtime is unavailable." };
      if (!input.browserRuntime) return { error: "Browser Use Cloud runtime is unavailable." };
      const sourcePath = sandboxWorkspaceFile(normalizedPath);
      const outputName = `.office-preview-${randomUUID()}.html`;
      const outputPath = path.posix.join(E2B_WORKSPACE, outputName);
      const threadFiles = await resolveThreadFileDescriptors(input, signal);
      const script = [
        "if ! command -v officecli >/dev/null 2>&1; then printf 'MISSING:officecli\\n' >&2; exit 127; fi",
        "officecli view \"$1\" html --page \"$3\" --out \"$2\"",
      ].join("\n");
      try {
        input.logger?.info("tool render_office_preview starting", {
          threadId: input.thread.id,
          path: normalizedPath,
          page,
        });
        const rendered = await input.commandRuntime.execute({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          command: "bash",
          args: ["-c", script, "bash", sourcePath, outputPath, String(page)],
          env: { TZ: "UTC" },
          stdin: "",
          workingDir: E2B_WORKSPACE,
          timeoutMs: input.config.BASH_TIMEOUT_MS,
          maxOutputChars: input.config.BASH_MAX_OUTPUT_CHARS,
          threadFiles,
          signal,
        });
        if (rendered.exitCode === 127 && rendered.stderr.includes("MISSING:officecli")) {
          return {
            error: "tool_unavailable",
            missing: ["officecli"],
            template: input.config.E2B_TEMPLATE,
            message: "The current E2B template does not contain OfficeCLI.",
          };
        }
        if (rendered.exitCode !== 0) {
          return {
            error: rendered.error || rendered.stderr.trim() || `OfficeCLI exited with ${String(rendered.exitCode)}.`,
          };
        }
        const previewHtml = await input.commandRuntime.readWorkspaceFile({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          virtualPath: `/${outputName}`,
          maxBytes: MAX_FILE_BYTES,
          threadFiles,
          signal,
        });
        let html: string;
        try {
          html = new TextDecoder("utf-8", { fatal: true }).decode(previewHtml.bytes);
        } catch {
          return { error: "OfficeCLI preview HTML must be valid UTF-8." };
        }
        if (!/(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(html)) {
          return { error: "OfficeCLI did not produce an HTML document." };
        }
        const selector = extension === ".pptx"
          ? `.slide-container[data-slide="${page}"] .slide`
          : undefined;
        const screenshot = await input.browserRuntime.renderOfficeHtml(
          sanitizeOfficeHtml(html),
          { selector },
          signal,
        );
        input.logger?.info("tool render_office_preview complete", {
          threadId: input.thread.id,
          path: normalizedPath,
          page,
          bytes: screenshot.bytes.length,
        });
        return {
          rendered: true,
          path: normalizedPath,
          page,
          media_type: screenshot.mediaType,
          size: screenshot.bytes.length,
          image_base64: screenshot.bytes.toString("base64"),
          session_remaining_seconds: screenshot.session_remaining_seconds,
        };
      } catch (error) {
        input.logger?.warn("tool render_office_preview failed", {
          threadId: input.thread.id,
          path: normalizedPath,
          page,
          error: String(error),
        });
        return { error: String(error) };
      } finally {
        await input.commandRuntime.execute({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          command: "rm",
          args: ["-f", "--", outputPath],
          env: { TZ: "UTC" },
          stdin: "",
          workingDir: E2B_WORKSPACE,
          timeoutMs: Math.min(input.config.BASH_TIMEOUT_MS, 10_000),
          maxOutputChars: 1_000,
          threadFiles,
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
            text: `Rendered Office preview ${output.path}, page ${output.page} (${output.media_type}, ${output.size} bytes).`,
          },
          {
            type: "image-data",
            data: output.image_base64,
            mediaType: output.media_type,
          },
        ],
      };
    },
    toToolDetails: ({ output }) => {
      if ("error" in output) return output;
      return {
        rendered: output.rendered,
        path: output.path,
        page: output.page,
        media_type: output.media_type,
        size: output.size,
        session_remaining_seconds: output.session_remaining_seconds,
      };
    },
  });
}
