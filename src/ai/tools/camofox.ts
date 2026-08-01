import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCamofoxClient } from "../../camofox/client.js";
import { downloadPublicBrowserFile } from "../../camofox/download.js";
import { interactiveCamofoxUserId } from "../../camofox/session.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { asRecord, numberField, safeJson } from "../../util/records.js";
import { assertCreatedFileCapacity, prepareDirectCreatedFile, toToolError } from "./helpers.js";
import { defineBotTool, type BotToolRegistry, type ToolBuildInput } from "./types.js";

const tabIdSchema = z.string().min(1).max(256);
const REGULAR_DESKTOP_VIEWPORT = { width: 1920, height: 1080 } as const;
const MIN_SCREENSHOT_HEIGHT = 720;
const MAX_SCREENSHOT_HEIGHT = 1440;
const targetShape = {
  ref: z.string().min(1).max(256).optional(),
  selector: z.string().min(1).max(2_000).optional(),
};

export function createCamofoxTools(input: ToolBuildInput): BotToolRegistry {
  const ownerId = () => interactiveCamofoxUserId(input.config, input.user.tg_id, input.thread.id);
  const client = () => createCamofoxClient(input.config);

  return {
    camofox_create_tab: defineBotTool({
      description:
        "Create an isolated Camoufox browser tab for this Telegram thread and navigate it to an HTTP(S) URL. Returns tab_id for later snapshot and interaction calls.",
      inputSchema: z.object({
        url: z.string().url().refine((value) => /^https?:/i.test(value), "url must use http or https"),
      }),
      execute: async ({ url }, signal) => {
        try {
          input.logger?.info("tool camofox_create_tab starting", { threadId: input.thread.id });
          const tab = await client().createTab(ownerId(), "interactive", url, signal);
          return { tab_id: tab.tabId, url: tab.url };
        } catch (error) {
          return toToolError(input, "camofox_create_tab", error, { threadId: input.thread.id });
        }
      },
    }),
    camofox_list_tabs: defineBotTool({
      description: "List the Camoufox browser tabs owned by this Telegram thread.",
      inputSchema: z.object({}),
      execute: async (_args, signal) => {
        try {
          const tabs = await client().listTabs(ownerId(), signal);
          return {
            tabs: tabs.map((tab) => ({
              tab_id: tab.tabId,
              url: tab.url,
              title: tab.title,
            })),
          };
        } catch (error) {
          return toToolError(input, "camofox_list_tabs", error, { threadId: input.thread.id });
        }
      },
    }),
    camofox_navigate: defineBotTool({
      description:
        "Navigate an existing Camoufox tab to an HTTP(S) URL or a supported search macro. Take a new snapshot after navigation because element refs reset.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        url: z.string().url().refine((value) => /^https?:/i.test(value), "url must use http or https").optional(),
        macro: z.enum([
          "@google_search",
          "@youtube_search",
          "@amazon_search",
          "@reddit_search",
          "@wikipedia_search",
          "@twitter_search",
          "@yelp_search",
          "@spotify_search",
          "@netflix_search",
          "@linkedin_search",
          "@instagram_search",
          "@tiktok_search",
          "@twitch_search",
        ]).optional(),
        query: z.string().min(1).max(2_000).optional(),
      }).superRefine((value, context) => {
        if (Boolean(value.url) === Boolean(value.macro)) {
          context.addIssue({ code: "custom", message: "provide exactly one of url or macro" });
        }
        if (value.macro && !value.query) {
          context.addIssue({ code: "custom", message: "query is required with macro", path: ["query"] });
        }
      }),
      execute: async ({ tab_id, ...navigation }, signal) => {
        try {
          const result = await client().navigate(ownerId(), tab_id, navigation, signal);
          return { tab_id, ...result };
        } catch (error) {
          return toToolError(input, "camofox_navigate", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
    camofox_snapshot: defineBotTool({
      description:
        "Get a paginated accessibility snapshot of a Camoufox tab with stable element refs such as e1 and e2. Includes a model-visible screenshot by default. When has_more is true, call again with next_offset.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        offset: z.number().int().min(0).default(0),
        include_screenshot: z.boolean().default(true),
      }),
      execute: async ({ tab_id, offset, include_screenshot }, signal) => {
        try {
          const snapshot = await client().snapshot(ownerId(), tab_id, {
            offset,
            includeScreenshot: include_screenshot,
          }, signal);
          return {
            tab_id,
            url: snapshot.url,
            snapshot: snapshot.snapshot,
            refs_count: snapshot.refsCount,
            truncated: snapshot.truncated,
            total_chars: snapshot.totalChars,
            has_more: snapshot.hasMore,
            next_offset: snapshot.nextOffset,
            ...(snapshot.screenshot ? {
              screenshot_base64: snapshot.screenshot.bytes.toString("base64"),
              screenshot_media_type: snapshot.screenshot.mediaType,
              screenshot_size: snapshot.screenshot.bytes.length,
            } : {}),
          };
        } catch (error) {
          return toToolError(input, "camofox_snapshot", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
      toModelOutput: ({ output }) => browserImageOutput(output, "Camoufox snapshot"),
      toToolDetails: ({ output }) => withoutImageData(output),
    }),
    camofox_click: defineBotTool({
      description: "Click an element in a Camoufox tab using a ref from the latest snapshot or a CSS selector.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        ...targetShape,
        double_click: z.boolean().default(false),
      }).superRefine(exactlyOneTarget),
      execute: async ({ tab_id, double_click, ...target }, signal) => {
        try {
          const result = await client().click(ownerId(), tab_id, {
            ...target,
            doubleClick: double_click,
          }, signal);
          return { tab_id, ...result };
        } catch (error) {
          return toToolError(input, "camofox_click", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
    camofox_type: defineBotTool({
      description: "Type text into a Camoufox page element using a ref or CSS selector.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        ...targetShape,
        text: z.string().max(100_000),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
      }).superRefine(exactlyOneTarget),
      execute: async ({ tab_id, ...typeInput }, signal) => {
        try {
          const result = await client().type(ownerId(), tab_id, typeInput, signal);
          return { tab_id, ...result };
        } catch (error) {
          return toToolError(input, "camofox_type", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
    camofox_press: defineBotTool({
      description: "Press a keyboard key, such as Enter, Escape, or Tab, in a Camoufox tab.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        key: z.string().min(1).max(100),
      }),
      execute: async ({ tab_id, key }, signal) => {
        try {
          const result = await client().press(ownerId(), tab_id, key, signal);
          return { tab_id, ...result };
        } catch (error) {
          return toToolError(input, "camofox_press", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
    camofox_scroll: defineBotTool({
      description: "Scroll a Camoufox page vertically or horizontally by a bounded pixel amount.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(10_000).default(700),
      }),
      execute: async ({ tab_id, direction, amount }, signal) => {
        try {
          const result = await client().scroll(ownerId(), tab_id, direction, amount, signal);
          return { tab_id, ...result };
        } catch (error) {
          return toToolError(input, "camofox_scroll", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
    camofox_screenshot: defineBotTool({
      description:
        "Capture a regular desktop-width PNG from a Camoufox tab, adapting the height to avoid cutting the page's primary visible section without adding oversized empty margins, and attach it directly to Telegram without E2B. Set full_page=true only when the user explicitly asks for a full-page/whole-page screenshot. Set delivery=document only when the user explicitly asks for a file/document; otherwise use photo. Use snapshots for model-only inspection.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        full_page: z.boolean().default(false).describe(
          "Use true only for an explicit full-page, whole-page, or entire-page request; a normal screenshot must remain false.",
        ),
        delivery: z.enum(["photo", "document"]).default("photo").describe(
          "Use document only when the user explicitly asks to receive the screenshot as a file or document.",
        ),
        caption: z.string().max(1024).optional(),
      }),
      execute: async ({ tab_id, full_page, delivery, caption }, signal) => {
        try {
          if (!input.createdFiles) throw new Error("Telegram attachment delivery is unavailable.");
          const usedBefore = assertCreatedFileCapacity(input);
          const browser = client();
          const browserOwnerId = ownerId();
          await browser.setViewport(
            browserOwnerId,
            tab_id,
            REGULAR_DESKTOP_VIEWPORT.width,
            REGULAR_DESKTOP_VIEWPORT.height,
            signal,
          );
          const viewport = await adaptiveScreenshotViewport(browser, browserOwnerId, tab_id, signal);
          await browser.setViewport(browserOwnerId, tab_id, viewport.width, viewport.height, signal);
          const screenshot = await browser.screenshot(browserOwnerId, tab_id, full_page, signal);
          const attached = await prepareDirectCreatedFile(input, {
            bytes: screenshot.bytes,
            name: `browser-screenshot-${randomUUID().slice(0, 8)}.png`,
            mime: screenshot.mediaType,
            caption,
            delivery,
            summary: "Screenshot captured from a Camofox browser tab.",
          }, signal);
          input.createdFiles.push(attached);
          return {
            tab_id,
            full_page,
            viewport,
            delivery: attached.delivery,
            attached: true,
            file_id: attached.fileId,
            marker: chatFileMarker(attached.fileId),
            name: attached.name,
            caption: attached.caption,
            attached_files_used: usedBefore + 1,
            screenshot_base64: screenshot.bytes.toString("base64"),
            screenshot_media_type: screenshot.mediaType,
            screenshot_size: screenshot.bytes.length,
          };
        } catch (error) {
          return toToolError(input, "camofox_screenshot", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
      toModelOutput: ({ output }) => browserImageOutput(output, "Camoufox screenshot"),
      toToolDetails: ({ output }) => withoutImageData(output),
    }),
    camofox_list_downloads: defineBotTool({
      description:
        "List files downloaded by a Camoufox tab. Use the returned download_index with camofox_send_file to attach one directly to Telegram without E2B.",
      inputSchema: z.object({ tab_id: tabIdSchema }),
      execute: async ({ tab_id }, signal) => {
        try {
          const downloads = await client().downloads(ownerId(), tab_id, signal);
          return {
            tab_id,
            downloads: downloads.map((download, downloadIndex) => ({
              download_index: downloadIndex,
              filename: download.filename,
              state: download.state,
            })),
          };
        } catch (error) {
          return toToolError(input, "camofox_list_downloads", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
    camofox_send_file: defineBotTool({
      description:
        "Fetch a public HTTP(S) file from a Camofox download index, a link ref on the current page, or a known URL, and attach it directly to Telegram without E2B.",
      inputSchema: z.object({
        tab_id: tabIdSchema,
        download_index: z.number().int().min(0).optional(),
        ref: z.string().min(1).max(256).optional(),
        url: z.string().url().refine((value) => /^https?:/i.test(value), "url must use http or https").optional(),
        name: z.string().min(1).max(255).optional(),
        caption: z.string().max(1024).optional(),
        delivery: z.enum(["auto", "photo", "document"]).default("auto"),
      }).superRefine((value, context) => {
        const selectors = [value.download_index !== undefined, Boolean(value.ref), Boolean(value.url)]
          .filter(Boolean).length;
        if (selectors !== 1) {
          context.addIssue({ code: "custom", message: "provide exactly one of download_index, ref, or url" });
        }
      }),
      execute: async ({ tab_id, download_index, ref, url, name, caption, delivery }, signal) => {
        try {
          if (!input.createdFiles) throw new Error("Telegram attachment delivery is unavailable.");
          const usedBefore = assertCreatedFileCapacity(input);
          let sourceUrl: string;
          let sourceName: string | undefined;
          let source: "download" | "link" | "url";
          if (download_index !== undefined) {
            const downloads = await client().downloads(ownerId(), tab_id, signal);
            const download = downloads[download_index];
            if (!download) throw new Error(`Camofox download index ${download_index} was not found.`);
            if (!/(?:complete|finished|success)/i.test(download.state)) {
              throw new Error(`Camofox download is not ready (state: ${download.state}).`);
            }
            sourceUrl = download.url;
            sourceName = download.filename;
            source = "download";
          } else if (ref) {
            const links = await client().links(ownerId(), tab_id, signal);
            const link = links.find((candidate) => candidate.ref === ref);
            if (!link) throw new Error(`Camofox page link ref ${ref} was not found.`);
            sourceUrl = link.href;
            source = "link";
          } else {
            sourceUrl = url!;
            source = "url";
          }
          const fetched = await downloadPublicBrowserFile(
            sourceUrl,
            input.config.CAMOFOX_TIMEOUT_MS,
            signal,
          );
          const attached = await prepareDirectCreatedFile(input, {
            bytes: fetched.bytes,
            name: name ?? sourceName ?? downloadNameFromUrl(fetched.finalUrl),
            mime: fetched.mimeType,
            caption,
            delivery,
            summary: "File downloaded through a Camofox browser tab.",
          }, signal);
          input.createdFiles.push(attached);
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
            attached_files_used: usedBefore + 1,
          };
        } catch (error) {
          return toToolError(input, "camofox_send_file", error, {
            threadId: input.thread.id,
            tabId: tab_id,
            downloadIndex: download_index,
          });
        }
      },
    }),
    camofox_close_tab: defineBotTool({
      description: "Close a Camoufox browser tab owned by this Telegram thread.",
      inputSchema: z.object({ tab_id: tabIdSchema }),
      execute: async ({ tab_id }, signal) => {
        try {
          await client().closeTab(ownerId(), tab_id, signal);
          return { closed: true, tab_id };
        } catch (error) {
          return toToolError(input, "camofox_close_tab", error, { threadId: input.thread.id, tabId: tab_id });
        }
      },
    }),
  };
}

function exactlyOneTarget(
  value: { ref?: string; selector?: string },
  context: z.RefinementCtx,
): void {
  if (Boolean(value.ref) === Boolean(value.selector)) {
    context.addIssue({ code: "custom", message: "provide exactly one of ref or selector" });
  }
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
        mediaType: typeof output.screenshot_media_type === "string"
          ? output.screenshot_media_type
          : "image/png",
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
    // The downloader already validates URLs; retain a safe fallback here.
  }
  return `browser-download-${randomUUID().slice(0, 8)}.bin`;
}

async function adaptiveScreenshotViewport(
  browser: ReturnType<typeof createCamofoxClient>,
  ownerId: string,
  tabId: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const measured = await browser.evaluate(ownerId, tabId, `(() => {
    const width = Math.round(window.innerWidth || document.documentElement.clientWidth || 1920);
    const viewportHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || 1080);
    const baseHeight = Math.min(1080, Math.max(720, viewportHeight));
    const remainingHeight = Math.max(1, document.documentElement.scrollHeight - window.scrollY);
    const root = document.querySelector('main, [role="main"]');
    const blocks = root
      ? Array.from(root.children)
      : Array.from(document.querySelectorAll('body > section, body > article'));
    const primary = blocks
      .map((element) => element.getBoundingClientRect())
      .find((rect) => rect.top <= baseHeight * 0.35 && rect.bottom > baseHeight);
    const contentHeight = primary ? Math.ceil(primary.bottom) : baseHeight;
    return {
      width,
      height: Math.min(1440, remainingHeight, Math.max(baseHeight, contentHeight)),
    };
  })()`, signal);
  const result = asRecord(measured.result);
  return {
    width: clampInteger(
      numberField(result, "width") ?? REGULAR_DESKTOP_VIEWPORT.width,
      1280,
      REGULAR_DESKTOP_VIEWPORT.width,
    ),
    height: clampInteger(
      numberField(result, "height") ?? REGULAR_DESKTOP_VIEWPORT.height,
      MIN_SCREENSHOT_HEIGHT,
      MAX_SCREENSHOT_HEIGHT,
    ),
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
