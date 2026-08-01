import { createOpenRouterTextEmbedder } from "../../memory/embeddings.js";
import { createSearchThreadTool } from "./searchThread.js";
import { createLoadMessageTool } from "./loadMessage.js";
import { createSearchInFileTool } from "./searchInFile.js";
import { createReadFileSectionTool } from "./readFileSection.js";
import { createCreateFileTool } from "./createFile.js";
import { createBashTool } from "./bash.js";
import { createWebSearchTool } from "./webSearch.js";
import { createWebExtractTool } from "./webExtract.js";
import { createPublishWebsiteTool } from "./publishWebsite.js";
import { createCamofoxTools } from "./camofox.js";
import { isCamofoxConfigured } from "../../config.js";
import { createRenderOfficePreviewTool } from "./renderOfficePreview.js";
import type { BotToolRegistry, ToolBuildInput } from "./types.js";

export type {
  BotToolDefinition,
  BotToolRegistry,
  CreatedFileAttachment,
  PendingCreatedFile,
  ToolBuildInput,
} from "./types.js";

export function buildToolRegistry(input: ToolBuildInput): BotToolRegistry {
  const embedder = input.embedder ?? createOpenRouterTextEmbedder(input.config, input.logger);
  return {
    search_thread: createSearchThreadTool(input, embedder),
    load_message: createLoadMessageTool(input),
    search_in_file: createSearchInFileTool(input, embedder),
    read_file_section: createReadFileSectionTool(input),
    create_file: createCreateFileTool(input),
    publish_website: createPublishWebsiteTool(input),
    bash: createBashTool(input),
    web_search: createWebSearchTool(input),
    web_extract: createWebExtractTool(input),
    ...(isCamofoxConfigured(input.config) ? {
      render_office_preview: createRenderOfficePreviewTool(input),
      ...createCamofoxTools(input),
    } : {}),
  };
}
