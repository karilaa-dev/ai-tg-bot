import { z } from "zod";
import { VisualReviewSchema } from "../../office/validation.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";
export function createValidateOfficeFileTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Validate a saved DOCX, PPTX, or XLSX file and return named check results, actual-file page count, and visual review coverage. First validate, then render_office_preview every page. Record your explicit visual_reviews with the returned source_sha256 after inspecting the images. Only previously rendered pages can pass. Any edit requires fresh validation and review. Failed, missing, or stale checks block delivery. After three unsuccessful repair cycles explain the blocker without sending the draft.",
    inputSchema: z.object({
      path: z.string().startsWith("/"),
      source_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      visual_reviews: z.array(VisualReviewSchema).max(500).default([]),
    }),
    execute: async ({ path, source_sha256, visual_reviews }, signal) => {
      try {
        if (!input.officeValidation)
          throw new Error("Office validation is unavailable.");
        return await input.officeValidation.validate(
          path,
          source_sha256,
          visual_reviews,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return { error: String(error) };
      }
    },
  });
}
