import { z } from "zod";
import { resolveThreadFileDescriptors } from "../../e2b/threadFiles.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createPublishWebsiteTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Publish an HTTP server that is already running in this thread's E2B sandbox. Start it as a persistent background process with stdin/stdout/stderr detached, bind it to 0.0.0.0, then pass its port here. The returned HTTPS URL is public. After the final Telegram response the sandbox stays active for 15 minutes, then pauses; publishing again explicitly resumes it.",
    inputSchema: z.object({
      port: z.number().int().min(1024).max(65_535),
      path: z.string().max(2048).default("/"),
    }),
    execute: async ({ port, path = "/" }, signal) => {
      try {
        if (!input.commandRuntime) throw new Error("E2B command runtime is unavailable.");
        const threadFiles = await resolveThreadFileDescriptors(input, signal);
        const published = await input.commandRuntime.publishWebsite({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          port,
          path,
          threadFiles,
          signal,
        });
        input.registerPublishedWebsite?.(published);
        return {
          published: true,
          url: published.url,
          port: published.port,
          path: published.path,
          public: true,
          pauses_after_minutes: published.pausesAfterMinutes,
        };
      } catch (error) {
        input.logger?.warn("tool publish_website failed", {
          threadId: input.thread.id,
          port,
          error: String(error),
        });
        return { error: String(error) };
      }
    },
  });
}
