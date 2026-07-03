import { tool, zodSchema, type Tool } from "ai";
import { createOpenRouterTextEmbedder } from "../../memory/embeddings.js";
import { asRecord, safeJson } from "../../util/records.js";
import { createSearchThreadTool } from "./searchThread.js";
import { createLoadMessageTool } from "./loadMessage.js";
import { createSearchInFileTool } from "./searchInFile.js";
import { createReadFileSectionTool } from "./readFileSection.js";
import { createGenerateImageTool } from "./generateImage.js";
import { createCreateFileTool } from "./createFile.js";
import { createBashTool } from "./bash.js";
import { createWebSearchTool } from "./webSearch.js";
import { createWebExtractTool } from "./webExtract.js";
import type {
  BotToolRegistry,
  CodexDynamicToolSpec,
  CodexToolContentItem,
  ToolBuildInput,
} from "./types.js";

export type {
  BotImageGenerator,
  BotToolDefinition,
  BotToolRegistry,
  CodexDynamicToolSpec,
  CodexToolContentItem,
  CreatedFileAttachment,
  ImageGenerationMode,
  ImageGenerationReference,
  ImageGenerationRequest,
  ImageGenerationResult,
  PendingCreatedFile,
  ToolBuildInput,
} from "./types.js";

export function buildTools(input: ToolBuildInput): Record<string, Tool<any, unknown>> {
  return Object.fromEntries(
    // AI SDK v6's tool() requires toModelOutput to return ToolResultOutput (JSONValue-constrained),
    // while BotToolDefinition.toModelOutput returns unknown so formatBotToolResultForCodex can reuse
    // it; the cast bridges that single boundary.
    Object.entries(buildToolRegistry(input)).map(([name, definition]) => [name, tool(definition as never) as Tool<any, unknown>]),
  );
}

export function buildToolRegistry(input: ToolBuildInput): BotToolRegistry {
  const embedder = input.embedder ?? createOpenRouterTextEmbedder(input.config, input.logger);
  return {
    search_thread: createSearchThreadTool(input, embedder),
    load_message: createLoadMessageTool(input),
    search_in_file: createSearchInFileTool(input, embedder),
    read_file_section: createReadFileSectionTool(input),
    generate_image: createGenerateImageTool(input),
    create_file: createCreateFileTool(input),
    bash: createBashTool(input),
    web_search: createWebSearchTool(input),
    web_extract: createWebExtractTool(input),
  };
}

export function buildCodexToolSpecs(
  registry: BotToolRegistry,
  namespace = "telegram",
): CodexDynamicToolSpec[] {
  return Object.entries(registry).map(([name, definition]) => ({
    namespace,
    name,
    description: definition.description,
    inputSchema: zodSchema(definition.inputSchema).jsonSchema,
    exposeToContext: true,
  }));
}

export async function executeBotTool(registry: BotToolRegistry, name: string, input: unknown): Promise<unknown> {
  const definition = registry[name];
  if (!definition) throw new Error(`unknown tool: ${name}`);
  const parsed = await definition.inputSchema.safeParseAsync(input);
  if (!parsed.success) throw new Error(`invalid ${name} input: ${parsed.error.message}`);
  return definition.execute(parsed.data);
}

export async function formatBotToolResultForCodex(
  registry: BotToolRegistry,
  name: string,
  input: unknown,
  output: unknown,
  toolCallId: string,
): Promise<CodexToolContentItem[]> {
  const definition = registry[name];
  if (definition?.toModelOutput) {
    try {
      const parsed = await definition.inputSchema.safeParseAsync(input);
      const modelOutput = await definition.toModelOutput({
        toolCallId,
        input: parsed.success ? parsed.data : input,
        output,
      });
      const converted = codexContentFromModelOutput(modelOutput);
      if (converted.length) return converted;
    } catch {
      return [{ type: "inputText", text: safeJson(output) }];
    }
  }
  return [{ type: "inputText", text: safeJson(output) }];
}

function codexContentFromModelOutput(modelOutput: unknown): CodexToolContentItem[] {
  const output = asRecord(modelOutput);
  if (!output) return [];
  if (output.type === "json" || output.type === "error-json") {
    return [{ type: "inputText", text: safeJson(output.value) }];
  }
  if (output.type === "text" || output.type === "error-text") {
    return [{ type: "inputText", text: String(output.value ?? "") }];
  }
  if (output.type !== "content" || !Array.isArray(output.value)) return [];
  const items: CodexToolContentItem[] = [];
  for (const part of output.value) {
    const record = asRecord(part);
    if (!record) continue;
    if (record.type === "text") {
      items.push({ type: "inputText", text: String(record.text ?? "") });
    } else if (record.type === "image-data" && typeof record.data === "string") {
      const mediaType = typeof record.mediaType === "string" ? record.mediaType : "image/*";
      items.push({ type: "inputImage", imageUrl: `data:${mediaType};base64,${record.data}` });
    } else {
      items.push({ type: "inputText", text: safeJson(record) });
    }
  }
  return items;
}
