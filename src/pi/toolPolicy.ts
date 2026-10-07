import { createToolSearchExtension, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const RESEARCH_TOOLS = new Set([
  "search_thread", "load_message", "search_in_file", "read_file_section", "web_search", "web_extract",
]);
export const INITIAL_ACTIVE_TOOL_NAMES = ["read", "bash", "finish_response", "codemode", "tool_search", "memo"];
const CORE_TOOLS = new Set(INITIAL_ACTIVE_TOOL_NAMES);

export function botToolPolicy(name: string): Pick<ToolDefinition, "exposure" | "defaultActive" | "namespace" | "annotations"> {
  const readOnly = RESEARCH_TOOLS.has(name);
  return {
    exposure: readOnly ? "deferred" : "model-only",
    defaultActive: CORE_TOOLS.has(name),
    namespace: name === "memo"
      ? { name: "memory", description: "OptMem permanent notes, summaries and recall" }
      : name.startsWith("browser_")
      ? { name: "browser", description: "Interactive browser tabs, navigation, screenshots, downloads and session management" }
      : readOnly
        ? { name: "research", description: "Web search and extraction, chat recall, attachment searches and bulk reads" }
        : { name: "workspace", description: "Files, PDF and Office previews, image generation, transcription and publishing" },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
  };
}

// Native search ranks inactive model-only tools too, without making them callable from scripts.
export function createBotToolSearchExtension(): InlineExtension {
  const search = createToolSearchExtension();
  const discoveryExposure = (name: string, exposure: ToolDefinition["exposure"]) =>
    exposure === "model-only" && !CORE_TOOLS.has(name) ? "deferred" as const : exposure ?? "direct";
  return {
    name: "bot-tool-search",
    factory: (pi) => search({
      ...pi,
      getAllTools: () => pi.getAllTools().map((tool) => ({ ...tool, exposure: discoveryExposure(tool.name, tool.exposure) })),
      registerTool: (tool) => pi.registerTool({
        ...tool,
        prepareLoadout: (loadout) => tool.prepareLoadout?.({
          ...loadout,
          getExposure: (name) => discoveryExposure(name, loadout.getExposure(name)) ?? "direct",
        }),
      }),
    }),
  };
}
