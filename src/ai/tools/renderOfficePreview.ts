import path from "node:path";
import { z } from "zod";
import { renderOfficeHtml } from "../../browserless/client.js";
import { exportSandboxFileBytes, normalizeBashCwd, toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

type RenderOfficePreviewResult =
  | { error: string }
  | {
      rendered: true;
      path: string;
      media_type: "image/png" | "image/jpeg" | "image/webp";
      size: number;
      image_base64: string;
    };

export function createRenderOfficePreviewTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Render an OfficeCLI-generated HTML page through the bot's Browserless service and return the image for visual QA. Browserless is not accessible from bash. The HTML must be in this thread's OpenSandbox workspace or /data/shared. This preview is visible only to the model and is not sent to Telegram.",
    inputSchema: z.object({
      path: z.string().regex(/^\//, "path must be an absolute virtual path"),
    }),
    execute: async ({ path: virtualPath }, signal): Promise<RenderOfficePreviewResult> => {
      const normalizedPath = normalizeBashCwd(virtualPath);
      try {
        const extension = path.posix.extname(normalizedPath).toLowerCase();
        if (extension !== ".html" && extension !== ".htm") {
          throw new Error("Office preview path must end in .html or .htm.");
        }
        input.logger?.info("tool render_office_preview starting", {
          threadId: input.thread.id,
          path: normalizedPath,
        });
        const bytes = await exportSandboxFileBytes(input, normalizedPath, signal);
        let html: string;
        try {
          html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("Office preview HTML must be valid UTF-8.");
        }
        if (!/(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(html)) {
          throw new Error("Office preview input must contain an HTML document.");
        }
        const rendered = await renderOfficeHtml(input.config, html, signal);
        input.logger?.info("tool render_office_preview complete", {
          threadId: input.thread.id,
          path: normalizedPath,
          mediaType: rendered.mediaType,
          bytes: rendered.bytes.length,
        });
        return {
          rendered: true,
          path: normalizedPath,
          media_type: rendered.mediaType,
          size: rendered.bytes.length,
          image_base64: rendered.bytes.toString("base64"),
        };
      } catch (error) {
        return toToolError(input, "render_office_preview", error, {
          threadId: input.thread.id,
          path: normalizedPath,
        });
      }
    },
    toModelOutput: ({ output }) => {
      if ("error" in output) return { type: "error-json", value: output };
      return {
        type: "content",
        value: [
          {
            type: "text",
            text: `Rendered Office preview ${output.path} (${output.media_type}, ${output.size} bytes).`,
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
        media_type: output.media_type,
        size: output.size,
      };
    },
  });
}
