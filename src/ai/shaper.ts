import { SentenceAssembler, insideOpenFence } from "../telegram/sentences.js";

export type ThinkingItem = {
  kind: "reasoning" | "demoted";
  text: string;
} | {
  kind: "tool";
  name: string;
  count: number;
  summary?: string;
};

export class StreamShaper {
  thinking: ThinkingItem[] = [];
  private seg = new SentenceAssembler();
  private toolCounts = new Map<string, number>();
  private toolSummaries = new Map<string, string>();
  private toolOrder: string[] = [];

  onReasoningDelta(text: string): void {
    const last = this.thinking.at(-1);
    if (last?.kind === "reasoning") last.text += text;
    else this.thinking.push({ kind: "reasoning", text });
  }

  onTextDelta(text: string): void {
    this.seg.push(text);
  }

  onToolCall(name: string): void {
    const text = this.seg.completed.join("") + this.seg.remainder;
    if (text.trim()) this.thinking.push({ kind: "demoted", text });
    const count = (this.toolCounts.get(name) ?? 0) + 1;
    this.toolCounts.set(name, count);
    if (count === 1) this.toolOrder.push(name);
    this.thinking.push({ kind: "tool", name, count });
    this.seg = new SentenceAssembler();
  }

  onToolResult(name: string, summary: string): void {
    this.toolSummaries.set(name, summary);
    const tool = [...this.thinking].reverse().find((item) => item.kind === "tool" && item.name === name && !item.summary);
    if (tool?.kind === "tool") {
      tool.summary = summary;
      return;
    }
    let count = this.toolCounts.get(name);
    if (!count) {
      count = 1;
      this.toolCounts.set(name, count);
      if (!this.toolOrder.includes(name)) this.toolOrder.push(name);
    }
    this.thinking.push({ kind: "tool", name, count, summary });
  }

  visibleAnswer(): string {
    const complete = this.seg.completed;
    let out = complete.slice(0, Math.max(0, complete.length - 2)).join("");
    if (insideOpenFence(this.seg.remainder)) out += this.seg.remainder;
    return out;
  }

  finalAnswer(): string {
    return this.seg.completed.join("") + this.seg.remainder;
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
        if (item.kind === "tool") return formatToolLine(item.name, item.count, item.summary);
        return item.text;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  toolStatusMd(): string {
    return this.toolOrder
      .map((name) => {
        const count = this.toolCounts.get(name) ?? 0;
        const summary = this.toolSummaries.get(name);
        return formatToolLine(name, count, summary);
      })
      .join("\n");
  }
}

function toolLabel(name: string): string {
  switch (name) {
    case "web_search":
      return "🔎Searching web";
    case "search_thread":
      return "💬Searching chat";
    case "load_message":
      return "📨Loading message";
    case "search_in_file":
      return "📄Searching file";
    case "read_file_section":
      return "📖Reading file";
    default:
      return `🛠️Using ${name.replaceAll("_", " ")}`;
  }
}

function formatToolLine(name: string, count: number, summary?: string): string {
  const label = `${toolLabel(name)}${count > 1 ? ` x${count}` : ""}`;
  const compact = compactSummary(summary);
  return compact ? `${label}(${compact})` : label;
}

function compactSummary(summary?: string): string {
  const trimmed = summary?.trim();
  if (!trimmed) return "";
  return trimmed.match(/^(\d+)\b/)?.[1] ?? trimmed;
}
