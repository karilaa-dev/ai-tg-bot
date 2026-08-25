import { z } from "zod";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createPublishWebsiteTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Publish an HTTP server already running persistently in this thread's E2B sandbox and bound to 0.0.0.0. Use only for a user's request to create, start, host, or publish a website, and publish only its intended contents; never add private attachments or unrelated workspace data unless the user explicitly requested that material on the public site. Put the site in a dedicated workspace subdirectory, start the server from that exact directory with stdin and output detached (for example: nohup command </dev/null >server.log 2>&1 &), then pass that directory as site_dir. The harness rejects workspace-root and Telegram-file serving and checks the listener process directory. The returned HTTPS URL is public and unauthenticated, so do not publish secrets. The result reports when the sandbox will pause; publishing again explicitly resumes it.",
    inputSchema: z.object({
      port: z.number().int().min(1024).max(65_535),
      site_dir: z.string().regex(/^\//, "site_dir must be an absolute virtual path").max(2048),
      path: z.string().max(2048).default("/"),
    }),
    execute: async ({ port, site_dir: siteDirectory, path = "/" }, signal) => {
      try {
        if (!input.commandRuntime) throw new Error("E2B command runtime is unavailable.");
        const published = await input.commandRuntime.publishWebsite({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          port,
          siteDirectory,
          path,
          signal,
        });
        input.registerPublishedWebsite?.(published);
        return {
          published: true,
          url: published.url,
          port: published.port,
          site_directory: published.siteDirectory,
          path: published.path,
          public: true,
          authentication: "none",
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
