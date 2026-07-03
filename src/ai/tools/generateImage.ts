import { z } from "zod";
import { MAX_CREATED_FILES_PER_ANSWER } from "../../files/limits.js";
import {
  assertCreatedFileCapacity,
  createGeneratedImageAttachment,
  resolveImageGenerationReferences,
  toToolError,
} from "./helpers.js";
import {
  GENERATED_IMAGE_FINAL_TEXT_GUIDANCE,
  defineBotTool,
  type CreatedFileAttachment,
  type ToolBuildInput,
} from "./types.js";

export function createGenerateImageTool(input: ToolBuildInput) {
  let generateImageQueued = false;
  return defineBotTool({
    description:
      'Generate or edit an image with the configured Codex app-server image model. The bot waits for generation to finish, then sends your final text followed by a separate captionless Telegram photo message. Use this when the user asks you to create, draw, render, generate, or edit an image. For edits or image references, pass current-thread image file ids in reference_file_ids. This tool is terminal: after a successful call, do not call more tools. Write one concise past-tense final sentence starting with "Done —" that says what you generated or changed, even for first-time image generation. Examples: "Done — I generated a pixel-styled Hatsune Miku." or "Done — I made her sitting and changed her hair to red." If you return empty text, the bot will send a generic ready message before the photo. Do not say the image is still generating, queued, or coming soon in your final text. Do not mention using imagegen, generate_image, or an image tool in final text; tool usage belongs in reasoning.',
    inputSchema: z.object({
      prompt: z.string().min(1).max(4000),
      reference_file_ids: z.array(z.coerce.number().int().positive()).max(4).default([]),
      mode: z.enum(["auto", "generate", "edit"]).default("auto"),
      size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
      caption: z.string().max(1024).optional(),
    }),
    execute: async ({ prompt, reference_file_ids = [], mode = "auto", size = "1024x1024", caption }) => {
      try {
        if (!input.imageGenerator) throw new Error("image generator is unavailable");
        const usedBefore = assertCreatedFileCapacity(input);
        if (input.createdFiles?.some((file) => file.origin === "generated_image")) {
          throw new Error("an image has already been generated for this answer; finish the conversation with that image");
        }
        if (generateImageQueued) {
          throw new Error("an image is already being generated for this answer; finish the conversation with that image");
        }
        const promptText = prompt.trim();
        if (!promptText) throw new Error("prompt is empty");
        const references = await resolveImageGenerationReferences(input, reference_file_ids);
        if (mode === "edit" && !references.length) {
          throw new Error("mode edit requires at least one reference_file_id");
        }
        generateImageQueued = true;
        const generatedInput = {
          prompt: promptText,
          model: input.config.CODEX_IMAGE_MODEL,
          quality: input.config.CODEX_IMAGE_QUALITY,
          size,
          mode,
          references,
        };
        const pushAttachment = () => createGeneratedImageAttachment(input, {
          promptText,
          generatedInput,
          caption,
          usedBefore,
        }).then((result) => {
          input.createdFiles?.push(result.attachment);
          return { attachment: result.attachment, revisedPrompt: result.revisedPrompt };
        });
        const baseResult = {
          generated_image: true as const,
          terminal: true as const,
          model: input.config.CODEX_IMAGE_MODEL,
          quality: input.config.CODEX_IMAGE_QUALITY,
          requested_size: size,
          mode,
          reference_file_ids,
          final_text_guidance: GENERATED_IMAGE_FINAL_TEXT_GUIDANCE,
        };
        if (input.pendingCreatedFiles) {
          const pending = pushAttachment().catch((err) =>
            toToolError(input, "generate_image", err, { threadId: input.thread.id }),
          );
          input.pendingCreatedFiles.push(pending);
          input.logger?.info("tool generate_image queued", {
            threadId: input.thread.id,
            pendingFiles: input.pendingCreatedFiles.length,
            model: input.config.CODEX_IMAGE_MODEL,
            quality: input.config.CODEX_IMAGE_QUALITY,
            size,
          });
          return {
            status: `image generation started (${usedBefore + 1}/${MAX_CREATED_FILES_PER_ANSWER} files used)`,
            ...baseResult,
            pending: true,
          };
        }
        const result = await pushAttachment();
        const attachment: CreatedFileAttachment = result.attachment;
        return {
          file_id: attachment.fileId,
          name: attachment.name,
          type: attachment.type,
          size: attachment.size,
          caption: attachment.caption ?? null,
          status: `1 image generated (${usedBefore + 1}/${MAX_CREATED_FILES_PER_ANSWER} files used)`,
          ...baseResult,
          revised_prompt: result.revisedPrompt ?? null,
        };
      } catch (err) {
        return toToolError(input, "generate_image", err, { threadId: input.thread.id });
      }
    },
  });
}
