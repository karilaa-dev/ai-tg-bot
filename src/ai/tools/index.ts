import { createSearchThreadTool } from "./searchThread.js";
import { createLoadMessageTool } from "./loadMessage.js";
import { createSearchInFileTool } from "./searchInFile.js";
import { createReadFileSectionTool } from "./readFileSection.js";
import { createCreateFileTool } from "./createFile.js";
import { createFinishResponseTool } from "./finishResponse.js";
import { createBashTool } from "./bash.js";
import { createWebSearchTool } from "./webSearch.js";
import { createWebExtractTool } from "./webExtract.js";
import { createPublishWebsiteTool } from "./publishWebsite.js";
import { createBrowserTools } from "./browser.js";
import { isBrowserUseConfigured } from "../../config.js";
import { createRenderOfficePreviewTool } from "./renderOfficePreview.js";
import { createMaterializeChatFilesTool } from "./materializeChatFiles.js";
import { createRenderPdfPagesTool } from "./renderPdfPages.js";
import { createInspectWorkspaceImagesTool } from "./inspectWorkspaceImages.js";
import type { BotToolRegistry, ToolBuildInput } from "./types.js";

export type {
  BotToolRegistry,
  ToolBuildInput,
} from "./types.js";

export function buildToolRegistry(input: ToolBuildInput): BotToolRegistry {
  return {
    search_thread: createSearchThreadTool(input),
    load_message: createLoadMessageTool(input),
    search_in_file: createSearchInFileTool(input),
    read_file_section: createReadFileSectionTool(input),
    materialize_chat_files: createMaterializeChatFilesTool(input),
    render_pdf_pages: createRenderPdfPagesTool(input),
    inspect_workspace_images: createInspectWorkspaceImagesTool(input),
    create_file: createCreateFileTool(input),
    finish_response: createFinishResponseTool(input),
    publish_website: createPublishWebsiteTool(input),
    bash: createBashTool(input),
    web_search: createWebSearchTool(input),
    web_extract: createWebExtractTool(input),
    ...(isBrowserUseConfigured(input.config) && input.browserRuntime ? {
      render_office_preview: createRenderOfficePreviewTool(input),
      ...createBrowserTools(input),
    } : {}),
  };
}
