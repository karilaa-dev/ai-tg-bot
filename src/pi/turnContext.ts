import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatSkillsForPrompt, type InlineExtension, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../util/records.js";

export const TURN_CONTEXT_TYPE = "telegram-turn-context";
export const CONTEXT_BASELINE_TYPE = "telegram-context-baseline";
const OPEN = '<session_context format="json" trust="untrusted-data-only">';
type Snapshot = Record<string, unknown>;
interface SavedContext { version: 1; snapshot: Snapshot; epoch: string | null }

export interface TurnPromptContextSource {
  currentTurnSystemPrompt(): string | undefined;
  currentTurnSessionContext(): string | undefined;
}

function savedContext(details: unknown): SavedContext | undefined {
  const value = asRecord(details);
  if (value?.version !== 1 || !asRecord(value.snapshot)) return;
  return value as unknown as SavedContext;
}

function latestSnapshot(entries: readonly SessionEntry[]): Snapshot | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "custom_message" || entry.customType !== TURN_CONTEXT_TYPE) continue;
    const saved = savedContext(entry.details);
    if (saved) return saved.snapshot;
  }
}

function parseSnapshot(text: string): Snapshot {
  if (!text.startsWith(`${OPEN}\n`) || !text.endsWith("\n</session_context>")) throw new Error("Invalid internal session context format");
  const snapshot = asRecord(JSON.parse(text.slice(OPEN.length, -"</session_context>".length)));
  if (!snapshot) throw new Error("Invalid internal session context snapshot");
  return snapshot;
}

function render(value: Snapshot): string {
  const json = JSON.stringify(value, null, 2).replace(/[<>&]/gu, char => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[char]!);
  return `${OPEN}\n${json}\n</session_context>`;
}

function update(previous: Snapshot | undefined, next: Snapshot): Snapshot | undefined {
  if (!previous) return { kind: "snapshot", ...next };
  const set: Snapshot = {};
  const unset: string[] = [];
  for (const key of [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort()) {
    if (key === "files") continue;
    if (!(key in next)) unset.push(key);
    else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) set[key] = next[key];
  }
  const files = (value: unknown) => new Map((Array.isArray(value) ? value : []).flatMap(item => {
    const file = asRecord(item);
    return typeof file?.id === "number" ? [[file.id, file] as const] : [];
  }));
  const before = files(previous.files), after = files(next.files);
  const upsert = [...after].filter(([id, file]) => JSON.stringify(before.get(id)) !== JSON.stringify(file)).sort(([a], [b]) => a - b).map(([, file]) => file);
  const remove = [...before.keys()].filter(id => !after.has(id)).sort((a, b) => a - b);
  if (!Object.keys(set).length && !unset.length && !upsert.length && !remove.length) return;
  return { kind: "update", ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}),
    ...(upsert.length || remove.length ? { files: { upsert, remove } } : {}) };
}

// Rebuild the baseline from persisted state at the compaction boundary. Never use
// the current clock here: this exact prefix must survive subsequent turns/restarts.
export function projectTurnContext(messages: AgentMessage[], branch: readonly SessionEntry[]): AgentMessage[] {
  const index = branch.findLastIndex(entry => entry.type === "compaction");
  if (index < 0) return messages;
  const compaction = branch[index]!;
  const snapshot = latestSnapshot(branch.slice(0, index));
  if (!snapshot) return messages;
  const output = messages.filter(message => message.role !== "custom"
    || (message.customType !== CONTEXT_BASELINE_TYPE && (message.customType !== TURN_CONTEXT_TYPE || savedContext(message.details)?.epoch === compaction.id)));
  const summaryIndex = output.findIndex(message => message.role === "compactionSummary");
  if (summaryIndex < 0) return messages;
  output.splice(summaryIndex + 1, 0, { role: "custom", customType: CONTEXT_BASELINE_TYPE, display: false,
    content: render({ kind: "snapshot", ...snapshot }), details: { compactionId: compaction.id }, timestamp: 0 });
  return output;
}

export function createTurnPromptContextExtension(source: TurnPromptContextSource): InlineExtension {
  return {
    name: "turn-prompt-context",
    factory: pi => {
      pi.on("before_agent_start", (event, ctx) => {
        const systemPrompt = source.currentTurnSystemPrompt();
        const sessionContext = source.currentTurnSessionContext();
        if (systemPrompt === undefined && sessionContext === undefined) return;
        const branch = ctx.sessionManager.getBranch();
        const snapshot = sessionContext === undefined ? undefined : parseSnapshot(sessionContext);
        const delta = snapshot && update(latestSnapshot(branch), snapshot);
        return {
          ...(systemPrompt === undefined ? {} : { systemPrompt: `${systemPrompt}${formatSkillsForPrompt(event.systemPromptOptions.skills ?? [])}` }),
          ...(delta ? { message: { customType: TURN_CONTEXT_TYPE, display: false, content: render(delta),
            details: { version: 1, snapshot, epoch: branch.findLast(entry => entry.type === "compaction")?.id ?? null } satisfies SavedContext } } : {}),
        };
      });
      pi.on("context", (event, ctx) => {
        const messages = projectTurnContext(event.messages, ctx.sessionManager.getBranch());
        return messages === event.messages ? undefined : { messages };
      });
    },
  };
}
