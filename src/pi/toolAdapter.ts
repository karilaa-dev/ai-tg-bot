import type { TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildToolRegistry } from "../ai/tools/index.js";
import type { ToolBuildInput } from "../ai/tools/types.js";
import { safeJson } from "../util/records.js";

const LEGACY_TOOL_NAMES = [
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
}

export function createPiToolAdapters(bridge: PiToolBridge): ToolDefinition[] {
  const initial = buildToolRegistry(bridge.buildInput());
  return LEGACY_TOOL_NAMES.map((name) => {
    const definition = initial[name];
    if (!definition) throw new Error(`Missing bot tool ${name}`);
    return {
      name,
      label: toolLabel(name),
      description: definition.description,
      promptSnippet: toolSnippet(name),
      parameters: z.toJSONSchema(definition.inputSchema, { io: "input" }) as TSchema,
      executionMode: name === "bash" || name === "create_file" ? "sequential" : undefined,
      async execute(_toolCallId, rawInput, signal) {
        const liveDefinition = buildToolRegistry(bridge.buildInput())[name];
        if (!liveDefinition) throw new Error(`Missing bot tool ${name}`);
        const parsed = await liveDefinition.inputSchema.safeParseAsync(rawInput);
        if (!parsed.success) throw new Error(`Invalid ${name} input: ${parsed.error.message}`);
        const output = await abortableToolExecution(liveDefinition.execute(parsed.data, signal), signal);
        return {
          content: [{ type: "text", text: safeJson(output) }],
          details: output,
        };
      },
    } as ToolDefinition;
  });
}

async function abortableToolExecution<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Tool execution aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function toolLabel(name: string): string {
  return name.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function toolSnippet(name: string): string {
  switch (name) {
    case "bash": return "Run real Bash in the user's persistent OpenSandbox environment. Omit cwd and use relative paths: logical / is the current thread workspace, not filesystem root. Never pass the bot host cwd or probe /home/agent or /workspace; use /data/shared only across threads and pass exact attachment ids in input_file_ids.";
    case "search_thread": return "Search prior chat messages lexically and attached document chunks lexically and semantically.";
    case "load_message": return "Load prior-message metadata, optionally restoring only selected file_ids into transient Pi context.";
    case "search_in_file": return "Search indexed file chunks semantically and lexically.";
    case "read_file_section": return "Read exact indexed sections from an uploaded file.";
    case "create_file": return "Create a file for delivery through the active chat.";
    case "web_search": return "Search the web through Tavily.";
    case "web_extract": return "Extract content from web pages through Tavily.";
    default: return name;
  }
}
