import { z } from "zod";
import { buildToolRegistry } from "../ai/tools/index.js";
import { toolResultFailed } from "../ai/toolOutcome.js";
import type { ImageContent, TextContent } from "../ai/runtime.js";
import type { ThreadBridge } from "./threadBridge.js";
import { asRecord, safeJson } from "../util/records.js";
import { raceWithAbort } from "../files/cancel.js";
import { APPROVED_SKILLS, readSkill } from "./skills.js";
import { sanitizeFileName } from "../e2b/telegramFileMaterializer.js";
import { createGenerateImageTool } from "./images.js";

export interface DynamicToolSpec { name: string; description: string; inputSchema: Record<string, unknown>; deferLoading?: boolean }
export interface ToolResult { content: Array<TextContent | ImageContent>; details: unknown; isError: boolean; completed?: boolean }
const nativeReplacements = new Set(["bash", "materialize_chat_files", "web_search", "web_extract", "inspect_workspace_images", "generate_image"]);
const sandboxTools = new Set(["bash", "render_pdf_pages", "render_office_preview", "validate_office_file", "inspect_workspace_images", "publish_website", "generate_image"]);

export function dynamicToolSpecs(bridge: ThreadBridge, fallback = false): DynamicToolSpec[] {
  return [
    { name: "read_skill", description: "Read the complete sandbox workflow guide by name before its task. This returns its content; no shell read is needed.", inputSchema: { type: "object", properties: { name: { type: "string", enum: APPROVED_SKILLS.map(skill => skill.name) } }, required: ["name"], additionalProperties: false } },
    ...Object.entries({ ...buildToolRegistry(bridge.buildInput()), ...(fallback ? { generate_image: createGenerateImageTool(bridge) } : {}) })
      .filter(([name]) => fallback ? name !== "materialize_chat_files" : !nativeReplacements.has(name))
      .map(([name, tool]) => ({ name, description: name === "load_message" ? "Load a previous chat message and its attachments. Select image bytes or extracted document context with file_ids. Source files are restored automatically before workspace access." : tool.description, inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>, deferLoading: !["finish_response", "create_file", "load_message"].includes(name) })),
  ];
}

/** Deferred functions must live inside an app-server namespace, not flat declarations. */
export function nativeToolSpecs(bridge: ThreadBridge): Array<{ type: "namespace"; name: string; description: string; tools: Array<DynamicToolSpec & { type: "function" }> }> {
  return [{ type: "namespace", name: "telegram", description: "Telegram chat history, attachments, delivery, and installed specialist workflows.", tools: dynamicToolSpecs(bridge).map(tool => ({ type: "function", ...tool })) }];
}

export async function executeBotTool(bridge: ThreadBridge, name: string, args: unknown, callId: string, signal?: AbortSignal): Promise<ToolResult> {
  if (name === "read_skill") {
    const skill = z.object({ name: z.string() }).parse(args);
    return { content: [{ type: "text", text: await readSkill(skill.name) }], details: { name: skill.name }, isError: false };
  }
  const tool = name === "generate_image" ? createGenerateImageTool(bridge) : buildToolRegistry(bridge.buildInput())[name];
  if (!tool || name === "materialize_chat_files") throw new Error(`Unavailable bot tool: ${name}`);
  const parsed = await tool.inputSchema.parseAsync(args);
  const record = asRecord(parsed);
  const files = name === "create_file" ? [record] : name === "finish_response" && Array.isArray(record?.files) ? record.files.map(asRecord) : [];
  const needsWorkspace = files.some(file => typeof file?.path === "string" && !bridge.isNativeArtifact(file.path));
  if (tool.holdsCommandActivity) bridge.holdCommandActivity();
  if (sandboxTools.has(name) || needsWorkspace || name === "transcribe_audio" && typeof record?.path === "string") await bridge.prepareCommandFiles(signal);
  let output = await raceWithAbort(tool.execute(parsed, signal), signal);
  if (name === "load_message") {
    const loaded = asRecord(output);
    if (loaded) output = { ...loaded, files: Array.isArray(loaded.files) ? loaded.files.map(value => {
      const file = asRecord(value);
      if (!file) return value;
      const { recommended_tool, ...metadata } = file;
      return { ...metadata, ...(recommended_tool === "materialize_chat_files" ? { workspace_path: `/home/user/telegram-files/${file.file_id}--${sanitizeFileName(String(file.name ?? "file"))}`, note: "The source file is restored automatically before workspace access." } : { recommended_tool }) };
    }) : loaded.files };
  }
  let content: Array<TextContent | ImageContent> = [];
  if (tool.toModelOutput) {
    try { content = modelOutputContent(await tool.toModelOutput({ toolCallId: callId, input: parsed, output })); } catch { /* keep completed output */ }
  }
  if (!content.length) content = [{ type: "text", text: safeJson(output) }];
  let details: unknown = output;
  if (tool.toToolDetails) {
    try { details = await tool.toToolDetails({ toolCallId: callId, input: parsed, output }); } catch { details = { details_unavailable: true }; }
  }
  if (name === "load_message") {
    const loaded = asRecord(output);
    const ids = Array.isArray(loaded?.materialized_file_ids) ? loaded.materialized_file_ids.filter((id): id is number => typeof id === "number") : [];
    for (const file of await bridge.repos.files.listByIds(ids)) {
      if (file.type === "image") { const image = await bridge.resolveImage(file, signal); content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType }); }
      else if (file.is_inline && file.content_md) content.push({ type: "text", text: `<attachment id="${file.id}">\n${file.content_md}\n</attachment>` });
    }
  }
  return { content, details, isError: toolResultFailed(output), ...(name === "finish_response" && asRecord(output)?.completed === true ? { completed: true } : {}) };
}

function modelOutputContent(value: unknown): Array<TextContent | ImageContent> {
  const output = asRecord(value);
  if (!output) return [];
  if (output.type === "json" || output.type === "error-json") return [{ type: "text", text: safeJson(output.value) }];
  if (output.type === "text" || output.type === "error-text") return [{ type: "text", text: String(output.value ?? "") }];
  if (output.type !== "content" || !Array.isArray(output.value)) return [];
  return output.value.flatMap((part): Array<TextContent | ImageContent> => {
    const item = asRecord(part);
    if (item?.type === "text") return [{ type: "text", text: String(item.text ?? "") }];
    if (item?.type === "image-data" && typeof item.data === "string") return [{ type: "image", data: item.data, mimeType: typeof item.mediaType === "string" ? item.mediaType : "image/png" }];
    return [{ type: "text", text: safeJson(part) }];
  });
}
