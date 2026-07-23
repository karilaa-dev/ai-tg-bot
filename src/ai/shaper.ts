import { SentenceAssembler } from "../telegram/sentences.js";
import { asRecord, numberField, stringField } from "../util/records.js";
import { escapeHtml } from "../util/text.js";

type ReasoningThinkingItem = {
  kind: "reasoning" | "demoted";
  text: string;
};

type ToolThinkingItem = {
  kind: "tool";
  name: string;
  key: string;
  label: string;
  summary?: string;
};

export type ThinkingItem = ReasoningThinkingItem | ToolThinkingItem;

export type ToolCallMetadata = {
  fileName?: string;
};

export type ThinkingRunSummary = {
  reasoningSummaries: string[];
  toolCallCount: number;
  toolCounts: ToolCountSummary[];
};

export type ToolCountSummary = {
  label: string;
  count: number;
};

type ToolCallRecord = {
  name: string;
  summaryLabel: string;
  summary?: string;
  called: boolean;
};

export class StreamShaper {
  thinking: ThinkingItem[] = [];
  private seg = new SentenceAssembler();
  private finalText: string | undefined;
  private toolStatus = new Map<string, { label: string; summary?: string }>();
  private toolCalls: ToolCallRecord[] = [];

  private assembledText(): string {
    return this.seg.completed.join("") + this.seg.remainder;
  }

  private registerTool(
    name: string,
    display: { key: string; label: string },
    opts: { summary?: string; called: boolean },
  ): void {
    this.toolStatus.set(display.key, { label: display.label, summary: opts.summary });
    this.toolCalls.push({ name, summaryLabel: toolLabel(name), summary: opts.summary, called: opts.called });
    if (opts.called) {
      const existing = this.thinking.find((item): item is ToolThinkingItem => item.kind === "tool" && item.key === display.key);
      if (existing) {
        existing.label = display.label;
        existing.summary = undefined;
        return;
      }
    }
    this.thinking.push({ kind: "tool", name, key: display.key, label: display.label, summary: opts.summary });
  }

  onReasoningDelta(text: string): void {
    const startsNewSection = /^\s*\n/.test(text);
    const delta = startsNewSection ? text.trimStart() : text;
    if (!delta) return;
    const last = this.thinking.at(-1);
    if (!startsNewSection && last?.kind === "reasoning") last.text += delta;
    else this.thinking.push({ kind: "reasoning", text: delta });
  }

  onTextDelta(text: string): void {
    this.finalText = undefined;
    this.seg.push(text);
  }

  onTextFinal(text: string): void {
    this.finalText = text;
    this.seg = new SentenceAssembler();
    this.seg.push(text);
  }

  onToolCall(name: string, input?: unknown, metadata: ToolCallMetadata = {}): void {
    const text = this.assembledText();
    if (text.trim()) this.thinking.push({ kind: "demoted", text });
    this.finalText = undefined;
    this.registerTool(name, toolDisplay(name, input, metadata), { called: true });
    this.seg = new SentenceAssembler();
  }

  onToolResult(name: string, summary: string): void {
    const call = [...this.toolCalls].reverse().find((item) => item.name === name && !item.summary);
    if (call) call.summary = summary;
    const tool = [...this.thinking].reverse().find((item) => item.kind === "tool" && item.name === name && !item.summary);
    if (tool?.kind === "tool") {
      tool.summary = summary;
      const status = this.toolStatus.get(tool.key);
      if (status) status.summary = summary;
      else this.toolStatus.set(tool.key, { label: tool.label, summary });
      return;
    }
    this.registerTool(name, toolDisplay(name), { summary, called: false });
  }

  visibleAnswer(): string {
    return this.assembledText();
  }

  finalAnswer(): string {
    return this.finalText ?? this.assembledText();
  }

  thinkingMd(): string {
    return this.compactThinkingMd();
  }

  streamingThinkingMd(): string {
    return this.thinking
      .map((item) => {
        if (item.kind === "demoted") return "";
        if (item.kind === "tool") return formatToolLine(item.label, item.summary);
        return cleanReasoningMarkdown(item.text);
      })
      .filter(Boolean)
      .join("\n\n");
  }

  compactThinkingMd(): string {
    const chunks: string[] = [];
    let pendingReasoningTitles: string[] = [];
    const flushReasoningTitles = () => {
      if (!pendingReasoningTitles.length) return;
      chunks.push(pendingReasoningTitles.join("\n"));
      pendingReasoningTitles = [];
    };
    for (const item of this.thinking) {
      if (item.kind === "demoted") continue;
      if (item.kind === "reasoning") {
        pendingReasoningTitles.push(...reasoningTitles(item.text));
        continue;
      }
      if (item.kind === "tool") {
        flushReasoningTitles();
        chunks.push(formatToolLine(item.label, item.summary));
      }
    }
    flushReasoningTitles();
    return chunks.filter(Boolean).join("\n\n");
  }

  toolStatusMd(): string {
    return [...this.toolStatus.values()].map(({ label, summary }) => formatToolLine(label, summary)).join("\n");
  }

  runSummary(): ThinkingRunSummary {
    return {
      reasoningSummaries: this.thinking.flatMap((item) => {
        if (item.kind !== "reasoning") return [];
        const summary = cleanReasoningMarkdown(item.text);
        return summary ? [summary] : [];
      }),
      toolCallCount: this.toolCalls.filter((tool) => tool.called).length,
      toolCounts: aggregateToolCounts(this.toolCalls),
    };
  }
}

function aggregateToolCounts(tools: ToolCallRecord[]): ToolCountSummary[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (!tool.called) continue;
    counts.set(tool.summaryLabel, (counts.get(tool.summaryLabel) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

function reasoningTitles(text: string): string[] {
  const title = cleanReasoningMarkdown(text).split("\n").map((line) => normalizeReasoningTitle(line)).find(Boolean);
  return title && looksLikeReasoningTitle(title) ? [title] : [];
}

function looksLikeReasoningTitle(line: string): boolean {
  if (!line || line.length > 120) return false;
  return !/[.!?]$/.test(line);
}

function cleanReasoningMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]*<!--(?:[\s\S]*?-->|[\s\S]*$)[ \t]*/g, "\n\n")
    .replace(/<(?:!|!-)?$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeReasoningTitle(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim();
}

function toolLabel(name: string): string {
  switch (name) {
    case "web_search":
      return "🔎 Searching web";
    case "web_extract":
      return "🌐 Reading page";
    case "search_thread":
      return "💬 Searching chat";
    case "load_message":
      return "📨 Loading message";
    case "search_in_file":
      return "📄 Searching file";
    case "read_file_section":
      return "📖 Reading file";
    case "generate_image":
      return "🖼️ Generating image";
    case "create_file":
      return "📎 Creating file";
    case "bash":
      return "🐚 Running bash";
    default:
      return `🛠️ Using ${name.replaceAll("_", " ")}`;
  }
}

function formatToolLine(label: string, summary?: string): string {
  const compact = summary?.trim();
  return compact ? `${label} (${compact})` : label;
}

function toolDisplay(name: string, input?: unknown, metadata: ToolCallMetadata = {}): { key: string; label: string } {
  const subject = toolSubject(name, input, metadata);
  const label = subject ? `${toolLabel(name)} <code>${escapeHtml(subject)}</code>` : toolLabel(name);
  return { key: `${name}:${subject ?? ""}`, label };
}

function toolSubject(name: string, input?: unknown, metadata: ToolCallMetadata = {}): string | undefined {
  const record = asRecord(input);
  switch (name) {
    case "web_search":
    case "search_thread":
      return truncateSubject(stringField(record, "query"), 64);
    case "web_extract":
      return urlsSubject(record);
    case "search_in_file":
    case "read_file_section":
      return metadata.fileName ?? fileIdSubject(record);
    case "generate_image":
      return generateImageSubject(record);
    case "create_file":
      return truncateSubject(stringField(record, "name") ?? stringField(record, "path"), 64);
    case "load_message": {
      const messageId = numberField(record, "message_id");
      return messageId === undefined ? undefined : `#${messageId}`;
    }
    case "bash":
      return bashSubject(record);
    default:
      return undefined;
  }
}

function generateImageSubject(record: Record<string, unknown> | undefined): string | undefined {
  const prompt = truncateSubject(stringField(record, "prompt"), 64);
  const references = record?.reference_file_ids;
  const referenceCount = Array.isArray(references) ? references.length : 0;
  if (!prompt) return referenceCount ? `${referenceCount} reference${referenceCount === 1 ? "" : "s"}` : undefined;
  return referenceCount ? `${prompt} +${referenceCount} ref${referenceCount === 1 ? "" : "s"}` : prompt;
}

function bashSubject(record: Record<string, unknown> | undefined): string | undefined {
  const script = stringField(record, "script")?.replace(/\s+/g, " ").trim();
  if (!script) return undefined;
  const tools = ["node", "python3", "python", "curl"].filter((name) => new RegExp(`\\b${name}\\b`).test(script));
  const uniqueTools = tools.filter((name, index) => name !== "python" || !tools.includes("python3") || tools.indexOf(name) === index);
  const prefix = uniqueTools.length > 1 ? `${uniqueTools.join(" + ")}: ` : "";
  return truncateSubject(`${prefix}${script}`, 64);
}

function urlsSubject(record: Record<string, unknown> | undefined): string | undefined {
  const value = record?.urls;
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (!urls.length) return undefined;
  const suffix = urls.length > 1 ? ` +${urls.length - 1}` : "";
  return truncateSubject(`${urls[0].trim()}${suffix}`, 64);
}

function fileIdSubject(record: Record<string, unknown> | undefined): string | undefined {
  const fileId = numberField(record, "file_id");
  return fileId === undefined ? undefined : `#${fileId}`;
}

function truncateSubject(value: string | undefined, max: number): string | undefined {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
