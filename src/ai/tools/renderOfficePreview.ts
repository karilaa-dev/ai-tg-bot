import { z } from "zod";
import { defineBotTool, type ToolBuildInput } from "./types.js";
export function createRenderOfficePreviewTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Render saved DOCX, PPTX or XLSX through LibreOffice to model-only page images, up to four per call. Check content, clipping, contrast and spacing, especially under wrapped headings. For presentations also judge meaningful imagery, focal points and composition variety; mechanically clean slides can still need redesign. Record visual review through validate_office_file with source_sha256. Previews are never sent to Telegram.",
    inputSchema: z
      .object({
        path: z.string().startsWith("/"),
        page: z.number().int().positive().optional(),
        pages: z.array(z.number().int().positive()).min(1).max(4).optional(),
      })
      .refine(
        (v) => !(v.page !== undefined && v.pages !== undefined),
        "Use page or pages, not both.",
      ),
    execute: async ({ path, page, pages }, signal) => {
      try {
        if (!input.officeValidation)
          throw new Error("Office validation is unavailable.");
        return await input.officeValidation.preview(
          path,
          pages ?? [page ?? 1],
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return { error: String(error) };
      }
    },
    toModelOutput: ({ output }) => {
      if ("error" in output) return { type: "error-json", value: output };
      input.officeValidation!.markSeen(
        output.source_sha256,
        output.images.map((i) => i.page),
      );
      return {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              path: output.path,
              source_sha256: output.source_sha256,
              page_count: output.page_count,
              renderer: output.renderer,
              renderer_version: output.renderer_version,
              pages: output.images.map((i) => i.page),
            }),
          },
          ...output.images.flatMap((i) => [
            { type: "text", text: `Page ${i.page}` },
            {
              type: "image-data",
              data: i.image_base64,
              mediaType: i.media_type,
            },
          ]),
        ],
      };
    },
    toToolDetails: ({ output }) =>
      "error" in output
        ? output
        : {
            ...output,
            images: output.images.map(
              ({ image_base64: _bytes, ...metadata }) => metadata,
            ),
          },
  });
}
