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

const CAMOFOX_TOOL_NAMES = [
  "render_office_preview",
  "camofox_create_tab",
  "camofox_list_tabs",
  "camofox_navigate",
  "camofox_snapshot",
  "camofox_click",
  "camofox_type",
  "camofox_press",
  "camofox_scroll",
  "camofox_screenshot",
  "camofox_list_downloads",
  "camofox_send_file",
  "camofox_close_tab",
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
    ...CAMOFOX_TOOL_NAMES.filter((name) => Boolean(initial[name])),
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
        || name.startsWith("camofox_")
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
    case "bash": return "Run Bash in the current thread's persistent custom E2B Base toolbox. Logical / is /home/user/workspace. Telegram attachments are automatically synchronized read-only at /home/user/telegram-files; copy them into the workspace before editing. OfficeCLI, ImageMagick, archive tools, compilers, and common CLI utilities are preinstalled. Chromium is intentionally absent because browser work uses Camofox. Nothing is shared with other sandboxes, and missing tools are not installed automatically.";
    case "search_thread": return "Search prior chat messages lexically and attached document chunks lexically and semantically.";
    case "load_message": return "Load prior-message metadata, optionally restoring only selected file_ids into transient Pi context.";
    case "search_in_file": return "Search indexed file chunks semantically and lexically.";
    case "read_file_section": return "Read exact indexed sections from an uploaded file.";
    case "create_file": return "Attach an existing sandbox file through the active chat.";
    case "publish_website": return "Publish an already-running E2B HTTP port as a public HTTPS URL for 15 minutes after the final response.";
    case "web_search": return "Search the web through Tavily.";
    case "web_extract": return config.WEB_EXTRACT_PROVIDER === "camofox"
      ? "Load known web page URLs through isolated, disposable Camofox sessions. Accessibility text is returned; Tavily-specific query, depth, and format options are accepted only for compatibility."
      : "Extract content from web pages through Tavily.";
    case "render_office_preview": return "Render an OfficeCLI-generated document page through the bot-side Camofox service for model-only visual QA. The Camofox credential is never available inside bash.";
    case "camofox_create_tab": return "Open a per-thread Camoufox browser tab. Keep its tab_id for later calls and close it when the browsing task is complete.";
    case "camofox_snapshot": return "Read the current page through accessibility refs and an optional screenshot. Re-snapshot after navigation before reusing refs.";
    case "camofox_navigate": return "Navigate an existing per-thread Camoufox tab.";
    case "camofox_click": return "Click a Camoufox element by a ref from the latest snapshot or by CSS selector.";
    case "camofox_type": return "Type into a Camoufox element by ref or CSS selector.";
    case "camofox_press": return "Press a key in a Camoufox tab.";
    case "camofox_scroll": return "Scroll a Camoufox tab.";
    case "camofox_screenshot": return "Capture Camofox's regular 1920-pixel desktop surface with an adaptive, content-aware height and attach it directly to Telegram. Full-page and document delivery require explicit user wording; never route browser screenshots through E2B.";
    case "camofox_list_downloads": return "List downloads recorded by a Camoufox tab without exposing their source URLs.";
    case "camofox_send_file": return "Attach a public HTTP(S) file selected from a browser download, page-link ref, or URL directly to Telegram without routing it through E2B.";
    case "camofox_list_tabs": return "List Camoufox tabs owned by this Telegram thread.";
    case "camofox_close_tab": return "Close a Camoufox tab owned by this Telegram thread.";
    default: return name;
  }
}
