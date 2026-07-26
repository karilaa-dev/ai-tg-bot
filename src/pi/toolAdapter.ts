import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildToolRegistry } from "../ai/tools/index.js";
import type { ToolBuildInput } from "../ai/tools/types.js";
import { raceWithAbort } from "../files/cancel.js";
import { asRecord, safeJson } from "../util/records.js";

const BOT_TOOL_NAMES = [
  "search_thread",
  "load_message",
  "search_in_file",
  "read_file_section",
  "create_file",
  "bash",
  "web_search",
  "web_extract",
] as const;

export interface PiToolBridge {
  buildInput(): ToolBuildInput;
  holdCommandActivity?(): void;
}

export function createPiToolAdapters(bridge: PiToolBridge): ToolDefinition[] {
  const initial = buildToolRegistry(bridge.buildInput());
  return BOT_TOOL_NAMES.map((name) => {
    const definition = initial[name];
    if (!definition) throw new Error(`Missing bot tool ${name}`);
    return {
      name,
      label: toolLabel(name),
      description: definition.description,
      promptSnippet: toolSnippet(name),
      parameters: z.toJSONSchema(definition.inputSchema, { io: "input" }) as TSchema,
      executionMode: name === "bash" || name === "create_file" ? "sequential" : undefined,
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
        return { content, details: output };
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

function toolSnippet(name: string): string {
  switch (name) {
    case "bash": return "Run real Bash in the current user-and-thread OpenSandbox environment. Omit cwd and use relative paths: logical / is the current thread workspace, not filesystem root. Only the current workspace, read-only staged attachments, and /data/shared are mounted; sibling threads are inaccessible. Never pass the bot host cwd or probe /home/agent or /workspace. Use /data/shared only for intentional cross-thread files and pass exact attachment ids in input_file_ids.";
    case "search_thread": return "Search prior chat messages lexically and attached document chunks lexically and semantically.";
    case "load_message": return "Load prior-message metadata, optionally restoring only selected file_ids into transient Pi context.";
    case "search_in_file": return "Search indexed file chunks semantically and lexically.";
    case "read_file_section": return "Read exact indexed sections from an uploaded file.";
    case "create_file": return "Attach an existing sandbox file through the active chat.";
    case "web_search": return "Search the web through Tavily.";
    case "web_extract": return "Extract content from web pages through Tavily.";
    default: return name;
  }
}
