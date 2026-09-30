import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  buildSessionProjection,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Repos } from "../db/repos/index.js";
import type { MessageRow, ThreadRow } from "../db/types.js";
import { asRecord, safeJson } from "../util/records.js";

export type CodexHistoryContent =
  | { type: "input_text" | "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export type CodexHistoryItem =
  | { type: "message"; role: "user" | "assistant"; content: CodexHistoryContent[]; phase?: "final_answer" }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string | CodexHistoryContent[] };

export interface ThreadHistory {
  items: CodexHistoryItem[];
  source: "pi" | "database" | "empty";
  snapshotMessageId: number | null;
}

export interface LoadThreadHistoryInput {
  repos: Pick<Repos, "threads" | "messages">;
  thread: ThreadRow;
  /** The accepted turn is excluded by passing its user message id minus one. */
  maxMessageId?: number;
  /** Import only database rows added after an existing Codex checkpoint. */
  afterMessageId?: number;
  /** Existing native threads already contain rows linked to their own turns. */
  skipNativeLinkedMessages?: boolean;
  piSessionFile?: string | null;
  piEntryId?: string | null;
}

/** Read-only import. Pi files and their entry ids remain available for old forks. */
export async function loadThreadHistory(input: LoadThreadHistoryInput): Promise<ThreadHistory> {
  const chain = await input.repos.threads.chain(input.thread);
  const allVisible = input.afterMessageId === undefined
    ? await input.repos.messages.listForThreadChain(chain)
    : await input.repos.messages.listForThreadChain(chain, input.maxMessageId, input.afterMessageId);
  const visible = allVisible.filter(message => input.maxMessageId === undefined || message.id <= input.maxMessageId);
  const checkpointRows = visible.filter(message => input.afterMessageId === undefined || message.id > input.afterMessageId);
  const messages = input.skipNativeLinkedMessages && input.afterMessageId !== undefined
    ? checkpointRows.filter(message => !message.pi_entry_id?.startsWith("codex:"))
    : checkpointRows;
  const snapshotMessageId = checkpointRows.at(-1)?.id ?? input.afterMessageId ?? null;
  const sessionFile = input.piSessionFile === undefined ? input.thread.pi_session_file : input.piSessionFile;
  const parent = chain.at(-2);
  const sharesParentSession = parent && sessionFile && sessionFile === parent.pi_session_file
    && input.thread.fork_point_message_id !== null;
  const forkPoint = sharesParentSession ? visible.find(message => message.id === input.thread.fork_point_message_id) : undefined;
  const forkEntryId = forkPoint?.pi_entry_id && !/^(?:codex|openrouter):/.test(forkPoint.pi_entry_id) ? forkPoint.pi_entry_id : undefined;
  const piEntryId = input.piEntryId ?? forkEntryId;

  // Catch-up must not replay the old Pi transcript into an already populated thread.
  if (sessionFile && input.afterMessageId === undefined && (!sharesParentSession || piEntryId || /^(?:codex|openrouter):/.test(forkPoint?.pi_entry_id ?? ""))) {
    try {
      const excludedEntryIds = allVisible.filter(message => input.maxMessageId !== undefined && message.id > input.maxMessageId)
        .flatMap(message => message.pi_entry_id ? [message.pi_entry_id] : []);
      const session = convertPiSessionEntries(await readFile(sessionFile, "utf8"), { piEntryId, excludedEntryIds });
      if (session.items.length) {
        const knownEntries = new Set(session.entryIds);
        const allEntries = new Set(session.allEntryIds);
        const knownMessageTexts = new Set(session.messageKeys);
        const supplemental = messages.filter(message => {
          // A row linked to another Pi branch is not part of this conversation.
          if (message.pi_entry_id && allEntries.has(message.pi_entry_id) && !knownEntries.has(message.pi_entry_id)) return false;
          if (message.pi_entry_id) return !knownEntries.has(message.pi_entry_id);
          // Old deployments did not always save entry ids. Avoid replaying their text.
          return !knownMessageTexts.has(`${message.role}\0${message.text_plain}`);
        });
        return { items: [...session.items, ...databaseHistoryItems(supplemental)], source: "pi", snapshotMessageId };
      }
    } catch {
      // Missing, truncated, or invalid session files must never erase database history.
    }
  }
  return {
    items: databaseHistoryItems(messages),
    source: messages.length ? "database" : "empty",
    snapshotMessageId,
  };
}

export function databaseHistoryItems(messages: readonly MessageRow[]): CodexHistoryItem[] {
  return messages.flatMap(message => {
    let stored: unknown;
    try { stored = JSON.parse(message.content_json); } catch { stored = undefined; }
    const record = asRecord(stored);
    const text = message.text_plain || (typeof record?.text === "string" ? record.text : "");
    const metadata = record ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "text")) : undefined;
    const details = metadata && Object.keys(metadata).length
      ? `\n\nStored message data:\n${safeJson(metadata)}`
      : !record && stored != null ? `\n\nStored message data:\n${safeJson(stored)}` : "";
    const content = `${message.role === "system" ? "[Previous conversation note]\n" : ""}${text}${details}`;
    return content ? [textMessage(message.role === "assistant" ? "assistant" : "user", content)] : [];
  });
}

export function convertPiSessionEntries(
  input: string | readonly FileEntry[],
  options: { piEntryId?: string | null; excludedEntryIds?: readonly string[] } = {},
): { items: CodexHistoryItem[]; entryIds: string[]; allEntryIds: string[]; messageKeys: string[] } {
  const parsed = typeof input === "string" ? parseSessionEntries(input) : structuredClone([...input]);
  const records = parsed.filter(entry => asRecord(entry) && typeof entry.type === "string");
  if (!records.some(entry => entry.type === "session")) throw new Error("Pi session header is missing.");
  migrateSessionEntries(records);
  const entries = records.filter((entry): entry is SessionEntry => entry.type !== "session"
    && typeof entry.id === "string" && entry.id.length > 0);
  const index = new Map(entries.map(entry => [entry.id, entry]));
  const leafId = options.piEntryId ?? entries.at(-1)?.id;
  if (!leafId) return { items: [], entryIds: [], allEntryIds: [], messageKeys: [] };
  let current = index.get(leafId);
  if (!current) throw new Error(`Pi branch entry ${leafId} is missing.`);
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) throw new Error("Pi session contains a cyclic branch.");
    seen.add(current.id);
    branch.push(current);
    if (!current.parentId) break;
    const parent = index.get(current.parentId);
    if (!parent) throw new Error(`Pi branch parent ${current.parentId} is missing.`);
    current = parent;
  }
  branch.reverse();
  const excluded = new Set(options.excludedEntryIds);
  const firstExcluded = branch.findIndex(entry => excluded.has(entry.id));
  if (firstExcluded >= 0) branch.splice(firstExcluded);
  if (!branch.length) return { items: [], entryIds: [], allEntryIds: entries.map(entry => entry.id), messageKeys: [] };

  // Resume the same active window Pi would use. Re-expanding summarized raw
  // history can overflow the new model before it has a chance to compact.
  const projection = buildSessionProjection(branch, branch.at(-1)!.id);
  const items = projection.entries.flatMap(({ sourceEntry, messages }) => messages.flatMap(message => {
    if (sourceEntry.type === "compaction" && sourceEntry.details !== undefined && asRecord(message)?.role === "compactionSummary") {
      return convertPiMessage({ ...message, summary: `${sourceEntry.summary}\n\nSummary data:\n${safeJson(sourceEntry.details)}` });
    }
    return convertPiMessage(message);
  }));
  // Raw branch ids and text still represent summarized database rows. Keep
  // them as deduplication coverage without putting those rows back in context.
  return { items: normalizeHistoryCallIds(completeToolExchanges(items)), entryIds: branch.map(entry => entry.id), allEntryIds: entries.map(entry => entry.id), messageKeys: piDatabaseMessageKeys(branch) };
}

/** Responses limits call ids to 64 characters; Pi may persist longer ids. */
export function normalizeHistoryCallIds<T extends object>(items: readonly T[]): T[] {
  const ids = [...new Set(items.flatMap(item => {
    const id = asRecord(item)?.call_id;
    return typeof id === "string" ? [id] : [];
  }))];
  const reserved = new Set(ids.filter(id => id.length <= 64));
  const replacements = new Map<string, string>();
  for (const id of ids.filter(id => id.length > 64).sort()) {
    let candidate = "";
    for (let salt = 0; !candidate || reserved.has(candidate); salt++) {
      candidate = `pi_${createHash("sha256").update(salt ? `${salt}\0${id}` : id).digest("base64url")}`;
    }
    reserved.add(candidate);
    replacements.set(id, candidate);
  }
  return items.map(item => {
    const id = asRecord(item)?.call_id;
    return typeof id === "string" && replacements.has(id) ? { ...item, call_id: replacements.get(id)! } : item;
  });
}

export interface CodexRolloutHistory {
  items: Record<string, unknown>[];
  invalidCallIds: number;
  turnIds: string[];
  artifactPaths: string[];
}

/** Read the effective native window, retaining compaction and rollback boundaries. */
export function codexRolloutHistory(input: string, options: { lastTurnId?: string } = {}): CodexRolloutHistory {
  const records = input.split("\n").filter(line => line.trim()).flatMap(line => {
    let parsed: unknown;
    // Native rollout loading ignores malformed audit lines and truncated tails.
    try { parsed = JSON.parse(line); } catch { return []; }
    const record = asRecord(parsed);
    return record && typeof record.type === "string" && asRecord(record.payload) ? [record] : [];
  });
  if (!records.some(record => record.type === "session_meta")) throw new Error("Codex rollout session header is missing.");
  const effective: Record<string, unknown>[] = [];
  const starts: Array<{ id: string; index: number; user: boolean }> = [];
  let hasNativeTurn = false;
  let foundCutoff = options.lastTurnId === undefined;
  let reachedCutoff = false;
  for (const record of records) {
    const payload = asRecord(record.payload)!;
    const started = record.type === "event_msg" && (payload.type === "task_started" || payload.type === "turn_started");
    if (started && typeof payload.turn_id === "string") {
      if (reachedCutoff) break;
      hasNativeTurn = true;
      starts.push({ id: payload.turn_id, index: effective.length, user: false });
      if (payload.turn_id === options.lastTurnId) { foundCutoff = true; reachedCutoff = true; }
    }
    if (record.type === "event_msg" && payload.type === "thread_rolled_back") {
      let remaining = typeof payload.num_turns === "number" ? Math.max(0, payload.num_turns) : 0;
      while (remaining-- > 0) {
        const nativeIndex = starts.findLastIndex(start => start.user);
        const native = starts[nativeIndex];
        // Manual compaction starts a native task without accepting a new user.
        // Remove that context-only suffix along with the newest real user turn.
        const userIndex = effective.findLastIndex(value => value.type === "response_item"
          && isNativeUserMessage(asRecord(value.payload)!));
        if (!native && hasNativeTurn) break;
        const cut = native?.index ?? userIndex;
        if (cut === undefined || cut < 0) break;
        effective.splice(cut);
        if (native) starts.splice(nativeIndex);
      }
      continue;
    }
    if (record.type === "response_item" && isNativeUserMessage(payload) && starts.length) starts.at(-1)!.user = true;
    effective.push(record);
  }
  if (!foundCutoff) throw new Error("The requested native fork turn is absent from the preserved rollout.");
  let items: Record<string, unknown>[] = [];
  const artifactPaths = new Set<string>();
  for (const record of effective) {
    const payload = asRecord(record.payload)!;
    if (record.type === "response_item") items.push(payload);
    if (record.type === "compacted") {
      if (Array.isArray(payload.replacement_history)) {
        items = payload.replacement_history.map(value => asRecord(asRecord(value)?.item ?? value)).filter((value): value is Record<string, unknown> => Boolean(value));
      } else if (typeof payload.message === "string") {
        // Old local checkpoints retained a bounded text fallback for recent
        // users, never all earlier user messages or their discarded media.
        const users: Record<string, unknown>[] = [];
        let remaining = 80_000;
        for (const item of items.toReversed()) {
          if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) continue;
          const text = item.content.map(value => asRecord(value)).flatMap(part => typeof part?.text === "string" ? [part.text] : []).join("\n");
          if (!text || !remaining) continue;
          const bounded = Buffer.from(text).subarray(0, remaining).toString("utf8");
          users.unshift({ ...item, content: [{ type: "input_text", text: bounded }] });
          remaining -= Buffer.byteLength(bounded);
        }
        items = [...users, asRecord(textMessage("user", payload.message || "(no summary available)"))!];
      } else throw new Error("Codex compaction checkpoint is invalid.");
    }
    if (record.type === "event_msg" && payload.type === "item_completed") {
      const item = asRecord(payload.item);
      const saved = item?.savedPath ?? item?.saved_path;
      if ((item?.type === "imageGeneration" || item?.type === "image_generation") && typeof saved === "string") artifactPaths.add(saved);
    }
    if (record.type === "event_msg" && payload.type === "image_generation_end" && typeof payload.saved_path === "string") artifactPaths.add(payload.saved_path);
  }
  // Current native instructions replace instructions persisted by the old process.
  items = items.filter(item => item.type !== "message" || item.role !== "system" && item.role !== "developer");
  const invalidCallIds = new Set(items.flatMap(item => typeof item.call_id === "string" && item.call_id.length > 64 ? [item.call_id] : [])).size;
  return { items: normalizeHistoryCallIds(items), invalidCallIds, turnIds: starts.map(start => start.id), artifactPaths: [...artifactPaths] };
}

function isNativeUserMessage(item: Record<string, unknown>): boolean {
  if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return false;
  const kinds = asRecord(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  if (Array.isArray(kinds) && kinds.some(kind => typeof kind === "string" && kind.startsWith("contextual."))) return false;
  const text = item.content.flatMap(value => typeof asRecord(value)?.text === "string" ? [String(asRecord(value)!.text)] : []).join("\n").trimStart();
  return !/^<(?:environment_context|permissions|skills_instructions|system_reminder|compaction_summary|summary)[>\s]/.test(text)
    && !text.startsWith("Another language model started to solve this problem");
}

function piDatabaseMessageKeys(branch: readonly SessionEntry[]): string[] {
  const keys: string[] = [];
  const add = (role: string, text: unknown) => { if (typeof text === "string" && text) keys.push(`${role}\0${text}`); };
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    if (message.role === "user" || message.role === "assistant") {
      add(message.role, inputContent(message.content).flatMap(part => part.type === "input_image" ? [] : [part.text]).join(""));
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const part = asRecord(value);
        if (part?.type === "toolCall" && part.name === "finish_response") add("assistant", asRecord(part.arguments)?.text);
      }
    }
    if (message.role === "toolResult" && message.toolName === "finish_response") add("assistant", asRecord(message.details)?.text);
  }
  return keys;
}

function convertPiMessage(value: unknown): CodexHistoryItem[] {
  const message = asRecord(value);
  if (!message) return [];
  const role = message.role;
  // The new runtime supplies its own instructions and tool descriptions.
  if (role === "system") return [];
  if (role === "branchSummary" || role === "compactionSummary") {
    return typeof message.summary === "string"
      ? [textMessage("user", `Previous Pi ${role === "branchSummary" ? "branch" : "compaction"} summary:\n${message.summary}`)] : [];
  }
  if (role === "bashExecution") {
    if (message.excludeFromContext) return [];
    return [textMessage("user", `Historical bash command:\n${String(message.command ?? "")}\n\n${String(message.output ?? "")}${message.fullOutputPath ? `\nFull output: ${String(message.fullOutputPath)}` : ""}`)];
  }
  if (role === "toolResult") {
    const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const output = inputContent(message.content);
    if (message.details !== undefined) output.push({ type: "input_text", text: `Result data:\n${safeJson(message.details)}` });
    if (message.isError) output.unshift({ type: "input_text", text: "This historical tool call failed." });
    if (!callId) return output.length ? [{ type: "message", role: "user", content: output }] : [];
    return [{ type: "function_call_output", call_id: callId, output: output.length ? output : "" }];
  }
  if (role === "assistant") {
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const items: CodexHistoryItem[] = [];
    let texts: string[] = [];
    const flushText = () => {
      if (texts.length) items.push(textMessage("assistant", texts.join("")));
      texts = [];
    };
    for (const value of parts) {
      const part = asRecord(value);
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
        flushText();
        items.push({ type: "function_call", name: part.name, arguments: typeof part.arguments === "string" ? part.arguments : safeJson(part.arguments ?? {}), call_id: part.id });
      }
    }
    flushText();
    return items;
  }
  const content = inputContent(message.content);
  if (role === "custom" && message.details !== undefined) content.push({ type: "input_text", text: `Context data:\n${safeJson(message.details)}` });
  return content.length ? [{ type: "message", role: "user", content }] : [];
}

function inputContent(value: unknown): CodexHistoryContent[] {
  if (typeof value === "string") return value ? [{ type: "input_text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((value): CodexHistoryContent[] => {
    const part = asRecord(value);
    if (part?.type === "text" && typeof part.text === "string") return [{ type: "input_text", text: part.text }];
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      return [{ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }];
    }
    return [];
  });
}

function textMessage(role: "user" | "assistant", text: string): CodexHistoryItem {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...(role === "assistant" ? { phase: "final_answer" as const } : {}) };
}

function completeToolExchanges(items: CodexHistoryItem[]): CodexHistoryItem[] {
  const output: CodexHistoryItem[] = [];
  const pending = new Map<string, string>();
  const closePending = () => {
    for (const [callId, name] of pending) output.push({ type: "function_call_output", call_id: callId, output: `The prior ${name} invocation has no persisted result. It was interrupted before migration.` });
    pending.clear();
  };
  for (const item of items) {
    if (item.type === "message") {
      if (item.role === "user") closePending();
      output.push(item);
    } else if (item.type === "function_call") {
      pending.set(item.call_id, item.name);
      output.push(item);
    } else if (pending.has(item.call_id)) {
      pending.delete(item.call_id);
      output.push(item);
    } else {
      const content = typeof item.output === "string" ? [{ type: "input_text" as const, text: item.output }] : item.output;
      output.push({ type: "message", role: "user", content: [{ type: "input_text", text: `Historical tool result ${item.call_id}:` }, ...content] });
    }
  }
  closePending();
  return output;
}
