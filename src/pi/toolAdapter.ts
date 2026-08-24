import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildToolRegistry } from "../ai/tools/index.js";
import type { ToolBuildInput } from "../ai/tools/types.js";
import { raceWithAbort } from "../files/cancel.js";
import { asRecord, safeJson } from "../util/records.js";

const BASE_BOT_TOOL_NAMES = [
  "search_thread",
  "load_message",
  "search_in_file",
  "read_file_section",
  "materialize_chat_files",
  "render_pdf_pages",
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
      parameters: z.toJSONSchema(definition.inputSchema, { io: "input" }) as TSchema,
      executionMode: name === "bash"
        || name === "materialize_chat_files"
        || name === "render_pdf_pages"
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
