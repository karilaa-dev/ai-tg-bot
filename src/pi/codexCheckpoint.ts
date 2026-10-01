import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertToLlm, type CompactionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../util/records.js";
import { CONTEXT_BASELINE_TYPE } from "./turnContext.js";

export interface CodexCheckpoint {
  version: 1 | 2;
  model: string;
  items: Record<string, unknown>[];
}
const CHECKPOINT = Symbol("codex-checkpoint");
interface Projection { entry: CompactionEntry; suffixLength: number; baseline: AgentMessage[] }
type MarkedMessage = AgentMessage & { [CHECKPOINT]?: Projection };

function checkpoint(entry: CompactionEntry | undefined): CodexCheckpoint | undefined {
  const value = asRecord(asRecord(entry?.details)?.codexCompaction);
  if (!value || (value.version !== 1 && value.version !== 2) || typeof value.model !== "string" || !Array.isArray(value.items)) return;
  const opaque = value.items.filter(item => asRecord(item)?.type === "compaction");
  if (opaque.length !== 1 || typeof opaque[0]?.encrypted_content !== "string" || !opaque[0].encrypted_content) return;
  return value as unknown as CodexCheckpoint;
}

// Tag the readable summary in memory. Conversion preserves ordinary user messages;
// the tag never enters JSONL or the provider's serialized request.
export function annotateCodexCheckpoint(messages: AgentMessage[], manager: Pick<SessionManager, "getBranch" | "buildSessionProjection">): AgentMessage[] {
  const branch = manager.getBranch();
  const boundary = branch.findLastIndex(entry => entry.type === "compaction");
  const entry = branch[boundary];
  if (entry?.type !== "compaction" || checkpoint(entry)?.version !== 2) return messages;
  const index = messages.findIndex(message => message.role === "compactionSummary");
  if (index < 0) return messages;
  const after = new Set(branch.slice(boundary + 1).map(item => item.id));
  const suffixLength = manager.buildSessionProjection().entries
    .filter(item => after.has(item.sourceEntry.id))
    .reduce((count, item) => count + convertToLlm(item.messages).filter(message => message.role !== "system").length, 0);
  const marker: MarkedMessage = { ...convertToLlm([messages[index]!])[0]!, [CHECKPOINT]: { entry, suffixLength,
    baseline: messages.filter(message => message.role === "custom" && message.customType === CONTEXT_BASELINE_TYPE) } };
  return messages.map((message, i) => i === index ? marker : message);
}

// The native checkpoint covers the FULL old window. Pi keeps a separate recent
// tail for portable fallback; sending that tail to Codex again would duplicate it.
export function projectCodexCheckpoint(context: TranscriptContext, model: string): { context: TranscriptContext; replay: (payload: unknown) => unknown } {
  const index = context.messages.findIndex(message => (message as MarkedMessage)[CHECKPOINT]?.entry !== undefined);
  const projection = (context.messages[index] as MarkedMessage | undefined)?.[CHECKPOINT];
  if (!projection || checkpoint(projection.entry)?.model !== model) return { context, replay: payload => payload };
  const conversation = context.messages.filter(message => message.role !== "system");
  const suffix = projection.suffixLength ? conversation.slice(-projection.suffixLength) : [];
  const system = getCurrentSystemMessage(context.messages);
  return {
    context: { ...context, messages: [...(system ? [system] : []), context.messages[index]!, ...convertToLlm(projection.baseline), ...suffix] },
    replay: payload => replayCodexCheckpoint(payload, projection.entry),
  };
}

export function replayCodexCheckpoint(payload: unknown, entry: CompactionEntry | undefined): unknown {
  const body = asRecord(payload), saved = checkpoint(entry);
  if (!body || !entry || !saved || saved.model !== body.model || !Array.isArray(body.input)) return payload;
  const summary = convertToLlm([{ role: "compactionSummary", summary: entry.summary, tokensBefore: 0, timestamp: 0 }])[0];
  const text = summary?.role === "user" && Array.isArray(summary.content) && summary.content[0]?.type === "text" ? summary.content[0].text : undefined;
  const index = body.input.findIndex(item => {
    const record = asRecord(item), content = record?.content;
    return record?.role === "user" && Array.isArray(content) && content.length === 1
      && asRecord(content[0])?.type === "input_text" && asRecord(content[0])?.text === text;
  });
  if (index < 0) return payload;
  return { ...body, input: [...body.input.slice(0, index), ...saved.items, ...body.input.slice(index + 1)] };
}

// Codex v2 retains bounded user requests before the encrypted item. Keep text and
// images, but not tool outputs, assistant replies or obsolete metadata updates.
export function retainCodexUserMessages(input: unknown[], tokenBudget: number): Record<string, unknown>[] {
  let remaining = Math.max(0, Math.floor(tokenBudget));
  const kept: Record<string, unknown>[] = [];
  for (let i = input.length - 1; i >= 0 && remaining > 0; i--) {
    const item = asRecord(input[i]);
    if (item?.role !== "user" || !Array.isArray(item.content)) continue;
    if (item.content.some(part => asRecord(part)?.type === "input_text" && String(asRecord(part)?.text).startsWith('<session_context format="json" trust="untrusted-data-only">'))) continue;
    const content: Record<string, unknown>[] = [];
    for (const raw of item.content) {
      const part = asRecord(raw);
      if (part?.type === "input_text" && typeof part.text === "string" && remaining > 0) {
        const text = part.text.slice(0, remaining * 4);
        remaining -= Math.ceil(text.length / 4);
        content.push({ ...part, text });
      } else if (part?.type === "input_image" && remaining >= 4096) {
        remaining -= 4096;
        content.push(part);
      }
    }
    if (content.length) kept.unshift({ ...item, content });
  }
  return kept;
}
