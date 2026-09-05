import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BrowserUseRuntimeError } from "../../browserUse/pageOperations.js";
import { redactBrowserUseError } from "../../browserUse/client.js";
import { downloadPublicBrowserFile } from "../../browserUse/download.js";
import { isAbortError } from "../../files/cancel.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { safeJson } from "../../util/records.js";
import { toToolError } from "./helpers.js";
import { defineBotTool, type BotToolRegistry, type ToolBuildInput } from "./types.js";

const tabIdSchema = z.string().min(1).max(256);
const targetShape = {
  ref: z.string().min(1).max(256).optional(),
  selector: z.string().min(1).max(2_000).optional(),
};

export function createBrowserTools(input: ToolBuildInput): BotToolRegistry {
  const runtime = () => {
    if (!input.browserRuntime) throw new Error("Browser Use Cloud runtime is unavailable.");
    return input.browserRuntime;
  };

  return {
    browser_open: defineBotTool({
      description:
        "Open a Browser Use Cloud tab for stateful or visual web work using the configured default session duration. Set timeout_minutes only when the task clearly needs longer. If a shorter session is already active, the result sets extension_required instead of silently replacing that session; call browser_extend_session to perform the rollover.",
      inputSchema: z.object({
        url: httpUrlSchema(),
        timeout_minutes: z.number().int().min(5).max(240).optional(),
      }),
      execute: async ({ url, timeout_minutes }, signal) => {
        try {
          return await runtime().open(url, timeout_minutes, signal);
        } catch (error) {
          return browserToolError(input, "browser_open", error, {}, signal);
        }
      },
    }),
    browser_list_tabs: defineBotTool({
      description: "List Browser Use tabs owned by this Telegram thread. Cookies are shared across this user's threads, but tabs are not.",
      inputSchema: z.object({}),
      execute: async (_args, signal) => {
        try {
          return await runtime().listTabs(signal);
        } catch (error) {
          return browserToolError(input, "browser_list_tabs", error, {}, signal);
        }
      },
    }),
    browser_navigate: defineBotTool({
      description: "Navigate an existing Browser Use tab to an HTTP(S) URL. Take a new snapshot after navigation because refs reset.",
      inputSchema: z.object({ tab_id: tabIdSchema, url: httpUrlSchema() }),
      execute: async ({ tab_id, url }, signal) => {
        try {
          return await runtime().navigate(tab_id, url, signal);
        } catch (error) {
          return browserToolError(input, "browser_navigate", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_snapshot: defineBotTool({
      description:
        "Read a Browser Use tab through a paginated semantic snapshot and fresh interactive refs such as e1. Includes a model-only screenshot by default.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        offset: z.number().int().min(0).default(0),
        include_screenshot: z.boolean().default(true),
      }),
      execute: async ({ tab_id, offset, include_screenshot }, signal) => {
        try {
          return await runtime().snapshot(tab_id, offset, include_screenshot, signal);
        } catch (error) {
          return browserToolError(input, "browser_snapshot", error, { tabId: tab_id }, signal);
        }
      },
      toModelOutput: ({ output }) => browserImageOutput(output, "Browser snapshot"),
      toToolDetails: ({ output }) => withoutImageData(output),
    }),
    browser_click: defineBotTool({
      description: "Click a Browser Use page element using a ref from the latest snapshot or a CSS selector.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        ...targetShape,
        double_click: z.boolean().default(false),
      }).superRefine(exactlyOneTarget),
      execute: async ({ tab_id, double_click, ...target }, signal) => {
        try {
          return await runtime().click(tab_id, { ...target, doubleClick: double_click }, signal);
        } catch (error) {
          return browserToolError(input, "browser_click", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_type: defineBotTool({
      description: "Type text into a Browser Use page element using a ref or CSS selector.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        ...targetShape,
        text: z.string().max(100_000),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
      }).superRefine(exactlyOneTarget),
      execute: async ({ tab_id, ...target }, signal) => {
        try {
          return await runtime().type(tab_id, target, signal);
        } catch (error) {
          return browserToolError(input, "browser_type", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_press: defineBotTool({
      description: "Press a keyboard key, such as Enter, Escape, or Tab, in a Browser Use tab.",
      inputSchema: z.object({ tab_id: tabIdSchema, key: z.string().min(1).max(100) }),
      execute: async ({ tab_id, key }, signal) => {
        try {
          return await runtime().press(tab_id, key, signal);
        } catch (error) {
          return browserToolError(input, "browser_press", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_scroll: defineBotTool({
      description: "Scroll a Browser Use page vertically or horizontally by a bounded pixel amount.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(10_000).default(700),
      }),
      execute: async ({ tab_id, direction, amount }, signal) => {
        try {
          return await runtime().scroll(tab_id, direction, amount, signal);
        } catch (error) {
          return browserToolError(input, "browser_scroll", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_screenshot: defineBotTool({
      description:
        "Capture a normal desktop screenshot from Browser Use and attach it directly to Telegram without E2B. Use full_page=true only for an explicit whole-page request and delivery=document only for an explicit file/document request. If the screenshot completes the browser task, call browser_close_session before replying.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        full_page: z.boolean().default(false),
        delivery: z.enum(["photo", "document"]).default("photo"),
        caption: z.string().max(1024).optional(),
      }),
      execute: async ({ tab_id, full_page, delivery, caption }, signal) => {
        try {
          if (!input.outgoingFiles) throw new Error("Telegram attachment delivery is unavailable.");
          let screenshot!: Awaited<ReturnType<NonNullable<ToolBuildInput["browserRuntime"]>["screenshot"]>>;
          const attached = await input.outgoingFiles.bytes(async () => {
            screenshot = await runtime().screenshot(tab_id, full_page, signal);
            const extension = screenshot.mediaType === "image/jpeg" ? "jpg" : "png";
            return {
              bytes: screenshot.bytes, name: `browser-screenshot-${randomUUID().slice(0, 8)}.${extension}`,
              mime: screenshot.mediaType, caption, delivery, summary: "Screenshot captured through Browser Use Cloud.",
            };
          }, signal);
          return {
            tab_id,
            full_page,
            viewport: screenshot.viewport,
            delivery: attached.delivery,
            attached: true,
            file_id: attached.fileId,
            marker: chatFileMarker(attached.fileId),
            name: attached.name,
            caption: attached.caption,
            attached_files_used: input.outgoingFiles.items.length,
            session_remaining_seconds: screenshot.session_remaining_seconds,
            screenshot_base64: screenshot.bytes.toString("base64"),
            screenshot_media_type: screenshot.mediaType,
            screenshot_size: screenshot.bytes.length,
          };
        } catch (error) {
          return browserToolError(input, "browser_screenshot", error, { tabId: tab_id }, signal);
        }
      },
      toModelOutput: ({ output }) => browserImageOutput(output, "Browser screenshot"),
      toToolDetails: ({ output }) => withoutImageData(output),
    }),
    browser_list_downloads: defineBotTool({
      description: "List completed files downloaded by this Browser Use tab without exposing their private source URLs.",
      inputSchema: z.object({ tab_id: tabIdSchema }),
      execute: async ({ tab_id }, signal) => {
        try {
          return await runtime().listDownloads(tab_id, signal);
        } catch (error) {
          return browserToolError(input, "browser_list_downloads", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_send_file: defineBotTool({
      description:
        "Attach a completed Browser Use download, latest-snapshot link ref, or known public HTTP(S) URL directly to Telegram without E2B. If delivery completes the browser task, call browser_close_session before replying.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        download_index: z.number().int().min(0).optional(),
        ref: z.string().min(1).max(256).optional(),
        url: httpUrlSchema().optional(),
        name: z.string().min(1).max(255).optional(),
        caption: z.string().max(1024).optional(),
        delivery: z.enum(["auto", "photo", "document"]).default("auto"),
      }).superRefine((value, context) => {
        if ([value.download_index !== undefined, Boolean(value.ref), Boolean(value.url)].filter(Boolean).length !== 1) {
          context.addIssue({ code: "custom", message: "provide exactly one of download_index, ref, or url" });
        }
      }),
      execute: async ({ tab_id, download_index, ref, url, name, caption, delivery }, signal) => {
        try {
          if (!input.outgoingFiles) throw new Error("Telegram attachment delivery is unavailable.");
          let sessionRemainingSeconds!: number;
          let source!: "download" | "link" | "url";
          const attached = await input.outgoingFiles.bytes(async () => {
            sessionRemainingSeconds = await runtime().sessionRemaining(tab_id, true, signal);
            let sourceUrl: string;
            let sourceName: string | undefined;
            if (download_index !== undefined) {
              const resolved = await runtime().resolveDownload(tab_id, download_index, signal);
              sourceUrl = resolved.url;
              sourceName = resolved.filename;
              source = "download";
            } else if (ref) {
              sourceUrl = await runtime().resolveLink(tab_id, ref, signal);
              source = "link";
            } else {
              sourceUrl = url!;
              source = "url";
            }
            const fetched = await downloadPublicBrowserFile(
              sourceUrl,
              input.config.BROWSER_USE_API_TIMEOUT_MS,
              signal,
            );
            return {
              bytes: fetched.bytes,
              name: name ?? sourceName ?? downloadNameFromUrl(fetched.finalUrl),
              mime: fetched.mimeType,
              caption,
              delivery,
              summary: "File downloaded through Browser Use Cloud.",
            };
          }, signal);
          return {
            tab_id,
            source,
            attached: true,
            file_id: attached.fileId,
            marker: chatFileMarker(attached.fileId),
            name: attached.name,
            type: attached.type,
            size: attached.size,
            caption: attached.caption,
            delivery: attached.delivery,
            attached_files_used: input.outgoingFiles.items.length,
            session_remaining_seconds: sessionRemainingSeconds,
          };
        } catch (error) {
          return browserToolError(input, "browser_send_file", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_close_tab: defineBotTool({
      description: "Close one Browser Use tab only when the current task still needs other tabs; otherwise close the whole session.",
      inputSchema: z.object({ tab_id: tabIdSchema }),
      execute: async ({ tab_id }, signal) => {
        try {
          return await runtime().closeTab(tab_id, signal);
        } catch (error) {
          return browserToolError(input, "browser_close_tab", error, { tabId: tab_id }, signal);
        }
      },
    }),
    browser_extend_session: defineBotTool({
      description:
        "Gracefully replace the current Browser Use session with a longer one using the same persistent user profile. URLs, tab IDs, owners, and scroll positions are restored; transient form and JavaScript state are not.",
      inputSchema: z.object({ timeout_minutes: z.number().int().min(5).max(240) }),
      execute: async ({ timeout_minutes }, signal) => {
        try {
          return await runtime().extendSession(timeout_minutes, signal);
        } catch (error) {
          return browserToolError(input, "browser_extend_session", error, {}, signal);
        }
      },
    }),
    browser_close_session: defineBotTool({
      description:
        "Default final browser action: immediately stop this user's Browser Use session before replying when the current browser task is finished. This closes all tabs across the user's threads, saves cookies to the persistent profile, and stops billing. Keep it open only when the same active task immediately needs transient page state; do not keep it open merely for possible future requests.",
      inputSchema: z.object({}),
      execute: async (_args, signal) => {
        try {
          return await runtime().closeSession(signal);
        } catch (error) {
          return browserToolError(input, "browser_close_session", error, {}, signal);
        }
      },
    }),
  };
}

function httpUrlSchema() {
  return z.string().url().refine((value) => /^https?:/i.test(value), "url must use http or https");
}

function exactlyOneTarget(value: { ref?: string; selector?: string }, context: z.RefinementCtx): void {
  if (Boolean(value.ref) === Boolean(value.selector)) {
    context.addIssue({ code: "custom", message: "provide exactly one of ref or selector" });
  }
}

function browserToolError(
  input: ToolBuildInput,
  toolName: string,
  error: unknown,
  details: Record<string, unknown> = {},
  signal?: AbortSignal,
): Record<string, unknown> {
  if (signal?.aborted) throw signal.reason ?? error;
  if (isAbortError(error)) throw error;
  if (error instanceof BrowserUseRuntimeError) return { error: error.code, message: error.message };
  return toToolError(input, toolName, redactBrowserUseError(input.config, error), {
    threadId: input.thread.id,
    ...details,
  });
}

function browserImageOutput(output: Record<string, unknown>, label: string) {
  if (typeof output.error === "string") return { type: "error-json", value: output };
  const data = typeof output.screenshot_base64 === "string" ? output.screenshot_base64 : undefined;
  if (!data) return { type: "json", value: output };
  const details = withoutImageData(output);
  return {
    type: "content",
    value: [
      { type: "text", text: `${label}: ${safeJson(details)}` },
      {
        type: "image-data",
        data,
        mediaType: typeof output.screenshot_media_type === "string" ? output.screenshot_media_type : "image/png",
      },
    ],
  };
}

function withoutImageData(output: Record<string, unknown>): Record<string, unknown> {
  const { screenshot_base64: _screenshotBase64, ...details } = output;
  return details;
}

function downloadNameFromUrl(value: string): string {
  try {
    const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1);
    if (segment) return decodeURIComponent(segment);
  } catch {
    // The downloader already validates URLs.
  }
  return `browser-download-${randomUUID().slice(0, 8)}.bin`;
}
