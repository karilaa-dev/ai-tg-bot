import { SentenceAssembler } from "../telegram/sentences.js";

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

export class StreamShaper {
  thinking: ThinkingItem[] = [];
  private seg = new SentenceAssembler();
  private finalText: string | undefined;
  private toolSummaries = new Map<string, string>();
  private toolLabels = new Map<string, string>();
  private toolOrder: string[] = [];

  onReasoningDelta(text: string): void {
    const last = this.thinking.at(-1);
    if (last?.kind === "reasoning") last.text += text;
    else this.thinking.push({ kind: "reasoning", text });
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
    const text = this.seg.completed.join("") + this.seg.remainder;
    if (text.trim()) this.thinking.push({ kind: "demoted", text });
    this.finalText = undefined;
    const display = toolDisplay(name, input, metadata);
    if (!this.toolOrder.includes(display.key)) this.toolOrder.push(display.key);
    this.toolLabels.set(display.key, display.label);
    this.toolSummaries.delete(display.key);
    const existing = this.thinking.find((item): item is ToolThinkingItem => item.kind === "tool" && item.key === display.key);
    if (existing) {
      existing.label = display.label;
      existing.summary = undefined;
    } else {
      this.thinking.push({ kind: "tool", name, key: display.key, label: display.label });
    }
    this.seg = new SentenceAssembler();
  }

  onToolResult(name: string, summary: string): void {
    const tool = [...this.thinking].reverse().find((item) => item.kind === "tool" && item.name === name && !item.summary);
    if (tool?.kind === "tool") {
      tool.summary = summary;
      this.toolSummaries.set(tool.key, summary);
      return;
    }
    const display = toolDisplay(name);
    if (!this.toolOrder.includes(display.key)) this.toolOrder.push(display.key);
    this.toolLabels.set(display.key, display.label);
    this.toolSummaries.set(display.key, summary);
    this.thinking.push({ kind: "tool", name, key: display.key, label: display.label, summary });
  }

  visibleAnswer(): string {
    return this.seg.completed.join("") + this.seg.remainder;
  }

  finalAnswer(): string {
    return this.finalText ?? this.seg.completed.join("") + this.seg.remainder;
  }

  thinkingMd(): string {
    return this.thinking
      .map((item) => {
        if (item.kind === "demoted") {
          return item.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
        }
        if (item.kind === "tool") return formatToolLine(item.label, item.summary);
        return item.text;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  toolStatusMd(): string {
    return this.toolOrder.map((key) => formatToolLine(this.toolLabels.get(key) ?? key, this.toolSummaries.get(key))).join("\n");
  }
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

function bashSubject(record: Record<string, unknown> | undefined): string | undefined {
  const script = stringField(record, "script")?.replace(/\s+/g, " ").trim();
  if (!script) return undefined;
  const tools = ["js-exec", "python3", "python", "curl"].filter((name) => new RegExp(`\\b${name}\\b`).test(script));
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

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateSubject(value: string | undefined, max: number): string | undefined {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
