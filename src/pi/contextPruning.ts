import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEditEntryDraft, InlineExtension, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { toolResultFailed } from "./toolOutcome.js";
import { asRecord } from "../util/records.js";

const KEEP_RECENT_RESULTS = 6;
const LARGE_RESULT_CHARS = 6000;
const PRUNED_PREFIX = "[Earlier tool result shortened.";
const PROTECTED_TOOLS = new Set(["finish_response", "validate_office_file", "memo"]);

export function createContextPruningExtension(): InlineExtension {
  return {
    name: "context-pruning",
    factory: (pi) => {
      pi.on("turn_end", (event) => {
        if (event.outcome !== "completed") return;
        const edits = pruneOldToolResults(event.context.contextEntries);
        return edits.length ? { entries: [...event.entries, ...edits] } : undefined;
      });
    },
  };
}

// Edit only model context. Raw tool messages, metadata, usage and branch history stay intact.
export function pruneOldToolResults(entries: ProjectedSessionEntry[]): ContextEditEntryDraft[] {
  const results = entries.flatMap((entry) => entry.messages.flatMap((message) =>
    message.role === "toolResult" ? [{ entryId: entry.sourceEntry.id, message }] : []));
  return results.slice(0, -KEEP_RECENT_RESULTS).flatMap(({ entryId, message }) => {
    if (PROTECTED_TOOLS.has(message.toolName) || message.isError || toolResultFailed(message.details)) return [];
    if (message.nestedCalls && (!message.nestedCalls.complete || message.nestedCalls.calls.some((call) => call.status !== "ok"))) return [];
    const failedSources = asRecord(message.details)?.failed_results;
    if (Array.isArray(failedSources) && failedSources.length) return [];
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n");
    if (text.startsWith(PRUNED_PREFIX)) return [];
    const images = message.content.filter((part) => part.type === "image").length;
    if (!images && text.length <= LARGE_RESULT_CHARS) return [];
    const content = summarizeResult(message, text, images);
    return [{ type: "context_edit" as const, targetId: entryId, replacement: { content } }];
  });
}

function summarizeResult(message: ToolResultMessage, text: string, images: number): TextContent[] {
  const references = resultReferences(message.details, text);
  const excerpt = text.length > LARGE_RESULT_CHARS
    ? `${text.slice(0, 2000)}\n[Middle omitted]\n${text.slice(-1000)}`
    : text;
  return [{
    type: "text",
    text: [
      `${PRUNED_PREFIX} Original preserved in session history.]`,
      `Tool: ${message.toolName}. ${images ? `${images} earlier inspection image(s) omitted. ` : ""}Use the original source or tool to inspect again when needed.`,
      excerpt,
      references.length ? `Retained source and artifact references:\n${references.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
  }];
}

function resultReferences(details: unknown, text: string): string[] {
  const references = new Set<string>();
  const add = (value: string) => { if (references.size < 64) references.add(value); };
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || references.size >= 64 || !value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:.*(?:path|url)|file_?id|fileIds|virtualPath)$/iu.test(key)) {
        if (typeof item === "string" || typeof item === "number") add(`${key}: ${item}`);
        if (Array.isArray(item)) for (const ref of item) if (typeof ref === "number" || typeof ref === "string") add(`${key}: ${ref}`);
      }
      visit(item, depth + 1);
    }
  };
  visit(details, 0);
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+|(?:\/[\w.@%+~-]+)+\.[a-z\d]{1,8}\b/giu)) add(match[0]);
  return [...references];
}
