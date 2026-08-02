import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildToolRegistry } from "../ai/tools/index.js";
import type { ToolBuildInput } from "../ai/tools/types.js";
import { raceWithAbort } from "../files/cancel.js";
import { asRecord, safeJson } from "../util/records.js";
import type { AppConfig } from "../config.js";

const BASE_BOT_TOOL_NAMES = [
  "search_thread",
  "load_message",
  "search_in_file",
  "read_file_section",
  "create_file",
  "publish_website",
  "bash",
  "web_search",
  "web_extract",
] as const;

const BROWSER_TOOL_NAMES = [
  "render_office_preview",
  "browser_open",
  "browser_list_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_screenshot",
  "browser_list_downloads",
  "browser_send_file",
  "browser_close_tab",
  "browser_extend_session",
  "browser_close_session",
] as const;

export interface PiToolBridge {
  buildInput(): ToolBuildInput;
  holdCommandActivity?(): void;
}

export function createPiToolAdapters(bridge: PiToolBridge): ToolDefinition[] {
  const initialInput = bridge.buildInput();
  const initial = buildToolRegistry(initialInput);
  const names = [
    ...BASE_BOT_TOOL_NAMES,
    ...BROWSER_TOOL_NAMES.filter((name) => Boolean(initial[name])),
  ];
  return names.map((name) => {
    const definition = initial[name];
    if (!definition) throw new Error(`Missing bot tool ${name}`);
    return {
      name,
      label: toolLabel(name),
      description: definition.description,
      promptSnippet: toolSnippet(name, initialInput.config),
      parameters: z.toJSONSchema(definition.inputSchema, { io: "input" }) as TSchema,
      executionMode: name === "bash"
        || name === "create_file"
        || name === "publish_website"
        || name === "render_office_preview"
        || name.startsWith("browser_")
        ? "sequential"
        : undefined,
      async execute(toolCallId, rawInput, signal) {
        const liveDefinition = buildToolRegistry(bridge.buildInput())[name];
        if (!liveDefinition) throw new Error(`Missing bot tool ${name}`);
        const parsed = await liveDefinition.inputSchema.safeParseAsync(rawInput);
        if (!parsed.success) throw new Error(`Invalid ${name} input: ${parsed.error.message}`);
        if (liveDefinition.holdsCommandActivity) bridge.holdCommandActivity?.();
        const output = await raceWithAbort(liveDefinition.execute(parsed.data, signal), signal);
        let content: Array<TextContent | ImageContent> = [];
        if (liveDefinition.toModelOutput) {
          try {
            const modelOutput = await liveDefinition.toModelOutput({
              toolCallId,
              input: parsed.data,
              output,
            });
            content = piContentFromModelOutput(modelOutput);
          } catch {
            // A model-output formatting failure must not erase a completed tool result.
          }
        }
        if (!content.length) content = [{ type: "text", text: safeJson(output) }];
        let details: unknown = output;
        if (liveDefinition.toToolDetails) {
          try {
            details = await liveDefinition.toToolDetails({
              toolCallId,
              input: parsed.data,
              output,
            });
          } catch {
            // Details are persistence-only metadata and must not fail a completed tool call.
            details = { details_unavailable: true };
          }
        }
        return { content, details };
      },
    } as ToolDefinition;
  });
}

function piContentFromModelOutput(modelOutput: unknown): Array<TextContent | ImageContent> {
  const output = asRecord(modelOutput);
  if (!output) return [];
  if (output.type === "json" || output.type === "error-json") {
    return [{ type: "text", text: safeJson(output.value) }];
  }
  if (output.type === "text" || output.type === "error-text") {
    return [{ type: "text", text: String(output.value ?? "") }];
  }
  if (output.type !== "content" || !Array.isArray(output.value)) return [];
  const items: Array<TextContent | ImageContent> = [];
  for (const part of output.value) {
    const record = asRecord(part);
    if (!record) continue;
    if (record.type === "text") {
      items.push({ type: "text", text: String(record.text ?? "") });
    } else if (record.type === "image-data" && typeof record.data === "string") {
      items.push({
        type: "image",
        data: record.data,
        mimeType: typeof record.mediaType === "string" ? record.mediaType : "image/*",
      });
    } else {
      items.push({ type: "text", text: safeJson(record) });
    }
  }
  return items;
}

function toolLabel(name: string): string {
  return name.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function toolSnippet(name: string, config: AppConfig): string {
  switch (name) {
    case "bash": return "Run Bash in the current thread's persistent custom E2B Base toolbox. Logical / is /home/user/workspace. Telegram attachments are automatically synchronized read-only at /home/user/telegram-files; copy them into the workspace before editing. OfficeCLI, ImageMagick, archive tools, compilers, and common CLI utilities are preinstalled. Chromium is intentionally absent because browser work uses Browser Use Cloud. Nothing is shared with other sandboxes, and missing tools are not installed automatically.";
    case "search_thread": return "Search prior chat messages lexically and attached document chunks lexically and semantically.";
    case "load_message": return "Load prior-message metadata, optionally restoring only selected file_ids into transient Pi context.";
    case "search_in_file": return "Search indexed file chunks semantically and lexically.";
    case "read_file_section": return "Read exact indexed sections from an uploaded file.";
    case "create_file": return "Attach an existing sandbox file through the active chat.";
    case "publish_website": return "Publish an already-running E2B HTTP port as a public HTTPS URL for 15 minutes after the final response.";
    case "web_search": return "Search the web through Tavily.";
    case "web_extract": return "Perform one stateless readable-page extraction through Tavily. Use browser tools when continued or visual interaction is needed.";
    case "render_office_preview": return "Render one OfficeCLI-generated page or slide through Browser Use Cloud for model-only visual QA. Preview and inspect every slide before delivery; re-preview changed slides after fixes. Browser credentials are never available inside bash.";
    case "browser_open": return "Open a thread-owned tab in the user's profile-backed Browser Use Cloud session. Request longer than five minutes only for clearly long tasks.";
    case "browser_snapshot": return "Read the current page through semantic text, fresh element refs, and an optional model-only screenshot. Re-snapshot after navigation.";
    case "browser_navigate": return "Navigate an existing thread-owned Browser Use tab.";
    case "browser_click": return "Click a Browser Use element by latest-snapshot ref or CSS selector.";
    case "browser_type": return "Type into a Browser Use element by ref or CSS selector.";
    case "browser_press": return "Press a key in a Browser Use tab.";
    case "browser_scroll": return "Scroll a Browser Use tab.";
    case "browser_screenshot": return "Capture a regular desktop screenshot and attach it directly to Telegram. Full-page and document delivery require explicit user wording; never route it through E2B. If this completes the browser task, call browser_close_session before the final answer.";
    case "browser_list_downloads": return "List completed downloads recorded for a Browser Use tab without exposing private URLs.";
    case "browser_send_file": return "Attach a browser download, latest-snapshot link, or public HTTP(S) URL directly to Telegram without E2B. If this completes the browser task, call browser_close_session before the final answer.";
    case "browser_list_tabs": return "List tabs owned by this thread; cookies remain shared across the user's threads.";
    case "browser_close_tab": return "Close one tab only when the current task still needs other browser tabs; otherwise close the whole session.";
    case "browser_extend_session": return "Gracefully roll the user browser into a longer session with the same profile, URLs, tab IDs, and scroll positions.";
    case "browser_close_session": return "Default final browser action: stop the entire user browser before answering once the current browser task is complete, preserving profile cookies while closing every tab and ending billing.";
    default: return name;
  }
}
