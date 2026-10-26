import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { asRecord } from "../util/records.js";
import { toolResultFailed } from "../pi/toolOutcome.js";

export const TOOL_ACTIVITY_LIMITS = { calls: 64, payloadChars: 24_000, totalChars: 192_000, reasoning: 24 };
const REDACTED = "[redacted]";
const OMITTED = "[details omitted]";
const MAX_SANITIZE_CHARS = TOOL_ACTIVITY_LIMITS.payloadChars * 2;
const payloadSchema = z.object({
  format: z.enum(["json", "text"]),
  text: z.string().max(TOOL_ACTIVITY_LIMITS.payloadChars),
  truncated: z.boolean(),
});
const callSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/),
  status: z.enum(["running", "succeeded", "error", "cancelled"]),
  args: payloadSchema.nullable(),
  result: payloadSchema.nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  /** Reasoning summaries recorded before this call started, so the web can show one chronological chain. */
  reasoningBefore: z.number().int().nonnegative().max(1_000).optional(),
});
export type ToolPayload = z.infer<typeof payloadSchema>;
export type ToolCallDetail = z.infer<typeof callSchema>;
export interface ToolActivity {
  version: 1;
  calls: ToolCallDetail[];
  reasoning: string[];
  omittedCalls: number;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ToolEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>;

function normalizedKey(key: string): string { return key.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function secretKey(key: string): boolean {
  return /(?:password|passwd|secret|apikey|accesstoken|refreshtoken|idtoken|authtoken|bottoken|admintoken|privatekey|authorization|credential|cookie)/.test(normalizedKey(key))
    || /^(?:token|bearer|signature)$/i.test(key);
}
function internalKey(key: string): boolean {
  return /^(?:openui|modelhint|transport|transportmetadata|rawresponse|rawrequest|headers|requestheaders|responseheaders|sessionid|sandboxid|telegramfileid|fileuniqueid|tgmessageid|imagebase64|screenshotbase64|imagedata|base64|bytes|buffer|stack|stacktrace|_meta|__proto__|constructor|prototype)$/i.test(key)
    || /^(?:openui|modelhint|transportmetadata|rawresponse|rawrequest|requestheaders|responseheaders|requestid|responseid|toolcallid|sessionid|sandboxid|telegramfileid|fileuniqueid|tgmessageid|imagebase64|screenshotbase64|imagedata|stacktrace|cdpurl|liveurl|websocketurl|connectionkey|remotekey|sourcecanonicalpath|fulloutputpath)$/.test(normalizedKey(key));
}

function boundedText(text: string): string {
  if (text.length <= MAX_SANITIZE_CHARS) return text;
  // Keep complete lines so a cut-off credential cannot evade literal redaction.
  const prefix = text.slice(0, MAX_SANITIZE_CHARS);
  const end = prefix.lastIndexOf("\n");
  return end < 0 ? OMITTED : `${prefix.slice(0, end)}\n${OMITTED}`;
}

function quotedValueEnd(text: string, start: number, delimiter: string): number {
  let end = start + delimiter.length;
  let slashes = 0;
  const slashCount = delimiter.length - 1;
  const quote = delimiter.at(-1);
  while (end < text.length) {
    const char = text[end++];
    if (char === quote && slashes % (2 * (slashCount + 1)) === slashCount) break;
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  return end;
}

function compoundValueEnd(text: string, start: number): number {
  let end = start + 1;
  let depth = 1;
  while (end < text.length && depth > 0) {
    const delimiter = /^(?:\\{0,8})["'`]/.exec(text.slice(end, end + 10))?.[0];
    if (delimiter) end = quotedValueEnd(text, end, delimiter);
    else {
      const char = text[end++];
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
    }
  }
  return end;
}

function unquotedValueEnd(text: string, start: number): number {
  if (text[start] === "{" || text[start] === "[") return compoundValueEnd(text, start);
  let end = start;
  while (end < text.length && !/[\s&,;"'<>}\]]/.test(text[end] ?? "")) end++;
  return end;
}

function redactSerializedStrings(text: string, secrets: readonly string[], depth: number): string {
  const chunks: string[] = [];
  let copied = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    const end = quotedValueEnd(text, index, '"');
    const token = text.slice(index, end);
    let value: unknown;
    try { value = JSON.parse(token); } catch { index = end - 1; continue; }
    if (typeof value !== "string") { index = end - 1; continue; }
    const property = /^\s*:\s*/.exec(text.slice(end));
    if (property && (secretKey(value) || internalKey(value))) {
      const start = end + property[0].length;
      const valueEnd = text[start] === '"' ? quotedValueEnd(text, start, '"') : unquotedValueEnd(text, start);
      chunks.push(text.slice(copied, start), JSON.stringify(secretKey(value) ? REDACTED : OMITTED));
      copied = valueEnd;
      index = valueEnd - 1;
    } else {
      const safe = depth >= 8 ? OMITTED : redactText(value, secrets, depth + 1);
      if (safe !== value) {
        chunks.push(text.slice(copied, index), JSON.stringify(safe));
        copied = end;
      }
      index = end - 1;
    }
  }
  chunks.push(text.slice(copied));
  return chunks.join("");
}

function redactAssignments(text: string): string {
  const assignments = /\b([A-Za-z_][\w-]{0,119})(\\{0,8}["'])?\s*([=:])\s*/g;
  const chunks: string[] = [];
  let copied = 0;
  for (let match = assignments.exec(text); match; match = assignments.exec(text)) {
    const key = match[1] ?? "";
    if (!secretKey(key) && !internalKey(key)) continue;
    const start = assignments.lastIndex;
    const opening = /^(?:\\{0,8})["'`]/.exec(text.slice(start, start + 10))?.[0];
    let end = start;
    let delimiter = match[3] === ":" ? match[2] ?? "" : "";
    const placeholder = [REDACTED, OMITTED].find(value => text.startsWith(value, start));
    if (placeholder) end += placeholder.length;
    else if (opening) {
      delimiter = opening;
      end = quotedValueEnd(text, start, delimiter);
    } else end = unquotedValueEnd(text, start);
    chunks.push(text.slice(copied, start), delimiter, secretKey(key) ? REDACTED : OMITTED, delimiter);
    copied = end;
    assignments.lastIndex = end;
  }
  chunks.push(text.slice(copied));
  return chunks.join("");
}

export function redactToolText(text: string, secrets: readonly string[] = []): string {
  return redactText(text, secrets, 0);
}

function redactText(text: string, secrets: readonly string[], depth: number): string {
  let safe = boundedText(text);
  for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
  safe = redactSerializedStrings(safe, secrets, depth);
  return redactAssignments(safe
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[\w+/=.-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk-(?:proj-)?[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|xox[baprs]-[\w-]+|\d{8,12}:[\w-]{30,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, REDACTED)
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^'"\r\n]+)/gi, `$1: ${REDACTED}`)
    .replace(/([?&](?:key|auth|sig)=)[^&\s"']+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/data:[\w/+.-]+;base64,[\w+/=\s]+/gi, "[binary content omitted]")
    .replace(/\b[A-Za-z0-9+/]{512,}={0,2}/g, "[binary content omitted]")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""));
}

function safePayload(input: unknown, secrets: ActivitySecrets, limit = TOOL_ACTIVITY_LIMITS.payloadChars): ToolPayload | null {
  if (input === undefined) return null;
  if (secrets.withhold) return { format: "text", text: OMITTED, truncated: true };
  let truncated = false;
  let remaining = Math.max(0, limit - 512);
  const seen = new WeakSet<object>();
  const clean = (value: unknown, depth: number): JsonValue => {
    if (remaining <= 0 || depth > 8) { truncated = true; return OMITTED; }
    remaining -= 8;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      if (value.length > MAX_SANITIZE_CHARS) truncated = true;
      const safe = secrets.sanitize(value);
      const available = Math.max(0, remaining);
      const text = safe.slice(0, available);
      remaining -= text.length;
      if (safe.length > text.length) { truncated = true; return `${text}\n${OMITTED}`; }
      return text;
    }
    if (typeof value !== "object") return "[unavailable]";
    if (seen.has(value)) { truncated = true; return OMITTED; }
    seen.add(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[binary content omitted]";
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const item of value.slice(0, 64)) {
        if (remaining <= 0) break;
        result.push(clean(item, depth + 1));
      }
      if (result.length < value.length) { truncated = true; result.push(OMITTED); }
      return result;
    }
    const record = asRecord(value);
    const object = record && typeof record.name === "string" && Object.hasOwn(record, "args")
      ? { ...record, args: privateToolArgs(record.name, record.args, secrets) } : value;
    const result: { [key: string]: JsonValue } = {};
    let count = 0;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      if (count++ >= 64 || remaining <= 0) { truncated = true; break; }
      if (key.length > 120) { truncated = true; continue; }
      if (internalKey(key)) continue;
      const safeKey = secrets.sanitize(key).slice(0, 120);
      remaining -= safeKey.length;
      result[safeKey] = secretKey(key) ? REDACTED : clean(Reflect.get(object, key), depth + 1);
    }
    return result;
  };
  const cleaned = clean(input, 0);
  const format = typeof cleaned === "string" ? "text" : "json";
  let text = format === "text" && typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned, null, 2);
  // Escaping and indentation can expand JSON. Keep it valid by bounding a preview value.
  if (text.length > limit) {
    truncated = true;
    if (format === "json") {
      let preview = text.slice(0, Math.floor(limit / 2));
      while (JSON.stringify({ preview, omitted: true }, null, 2).length > limit) preview = preview.slice(0, Math.floor(preview.length / 2));
      text = JSON.stringify({ preview, omitted: true }, null, 2);
    } else text = text.slice(0, Math.max(0, limit - OMITTED.length - 1)) + `\n${OMITTED}`;
  }
  return { format, text, truncated };
}

function safeRecordedPayload(payload: ToolPayload, secrets: ActivitySecrets, limit: number): ToolPayload | null {
  let input: unknown = payload.text;
  if (payload.format === "json") {
    try { input = JSON.parse(payload.text); } catch { /* Malformed stored JSON stays readable text. */ }
  }
  const result = safePayload(input, secrets, limit);
  if (result) result.truncated ||= payload.truncated;
  return result;
}

function usefulResult(name: string, input: unknown): unknown {
  const wrapper = asRecord(input);
  if (!wrapper) return input;
  const details = wrapper.details;
  const text = Array.isArray(wrapper.content) ? wrapper.content.flatMap(part => {
    const item = asRecord(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n\n") : "";
  // Built-in tools keep execution metadata in details; their useful output lives in content.
  if (name === "read" && Array.isArray(wrapper.content)) return text;
  if (name === "codemode" && text) {
    const output = text.replace(/^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, "");
    const nested = asRecord(details)?.calls;
    const calls = Array.isArray(nested) ? nested.slice(0, 64).flatMap(item => {
      const call = asRecord(item);
      if (!call || typeof call.name !== "string" || call.name === "finish_response") return [];
      return [{ name: call.name, args: call.args, status: call.status, durationMs: call.durationMs, error: call.error }];
    }) : [];
    return calls.length ? { output, calls } : output;
  }
  if (details !== undefined && details !== null && (typeof details !== "object" || Object.keys(details).length > 0)) return details;
  if (wrapper.structuredContent !== undefined) return wrapper.structuredContent;
  if (Array.isArray(wrapper.content)) {
    return text || (wrapper.content.length ? "[non-text content omitted]" : undefined);
  }
  return input;
}

function cancelledResult(result: unknown, failed: boolean): boolean {
  const record = asRecord(result);
  if (record?.cancelled === true || record?.canceled === true || record?.status === "cancelled" || record?.status === "canceled") return true;
  const error = typeof result === "string" ? result : record?.error;
  return failed && typeof error === "string" && /^(?:Error: |AbortError: )?(?:Operation aborted|Turn cancelled(?: by user)?\.?|The operation was aborted\.?|Tool execution (?:aborted|cancelled)\.?)$/i.test(error.trim());
}

function secretForms(value: string): string[] {
  try { return [...new Set([value, encodeURIComponent(value)])]; } catch { return [value]; }
}

class ActivitySecrets {
  private readonly values: string[] = [];
  private chars = 0;
  withhold = false;

  remember(value: string): void {
    if (this.withhold || value.length < 4 || this.values.includes(value)) return;
    if (value.length > MAX_SANITIZE_CHARS) { this.withhold = true; return; }
    for (const form of secretForms(value)) {
      if (this.values.includes(form)) continue;
      if (this.values.length >= 128 || this.chars + form.length > TOOL_ACTIVITY_LIMITS.totalChars) {
        this.withhold = true;
        return;
      }
      this.values.push(form);
      this.chars += form.length;
    }
    this.values.sort((a, b) => b.length - a.length);
  }

  sanitize(text: string): string {
    return this.withhold ? OMITTED : redactToolText(text, this.values);
  }
}

type SourceToken = { kind: "word" | "number" | "punctuation" | "string"; text: string };

// This is a disclosure allowlist, not a JavaScript evaluator. Unsupported syntax
// withholds the whole source, including values assigned before a browser call.
function privateCode(code: string, secrets: ActivitySecrets): string {
  if (code.length > MAX_SANITIZE_CHARS) { secrets.withhold = true; return OMITTED; }
  const tokens: SourceToken[] = [];
  let ambiguous = false;
  for (let index = 0; index < code.length;) {
    if (tokens.length >= 4_096) { secrets.withhold = true; return OMITTED; }
    const char = code[index];
    if (/\s/.test(char)) { index++; continue; }
    if (code.startsWith("//", index)) {
      const end = code.indexOf("\n", index + 2);
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index + 2);
      if (end < 0) { ambiguous = true; break; }
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let value = "";
      let closed = false;
      for (index++; index < code.length;) {
        const next = code[index++];
        if (next === quote) { closed = true; break; }
        if (quote === "`" && next === "$" && code[index] === "{") ambiguous = true;
        if (next !== "\\") { value += next; continue; }
        const escape = code[index++];
        if (escape === "\n") continue;
        if (escape === "\r") { if (code[index] === "\n") index++; continue; }
        if (escape === "u" || escape === "x") {
          const braced = escape === "u" && code[index] === "{";
          const digits = braced ? /^\{([0-9a-f]{1,6})\}/i.exec(code.slice(index, index + 8))
            : (escape === "u" ? /^([0-9a-f]{4})/i : /^([0-9a-f]{2})/i).exec(code.slice(index, index + 4));
          const point = digits ? Number.parseInt(digits[1], 16) : -1;
          if (!digits || point < 0 || point > 0x10ffff) { ambiguous = true; continue; }
          value += String.fromCodePoint(point);
          index += digits[0].length;
        } else {
          const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
          if (!escape || /[1-9]/.test(escape)) ambiguous = true;
          value += escapes[escape] ?? escape ?? "";
        }
      }
      if (!closed) ambiguous = true;
      tokens.push({ kind: "string", text: value });
      continue;
    }
    if (/[a-zA-Z_$]/.test(char)) {
      const start = index++;
      while (index < code.length && /[\w$]/.test(code[index])) index++;
      tokens.push({ kind: "word", text: code.slice(start, index) });
      continue;
    }
    if (/\d/.test(char)) {
      const start = index++;
      while (index < code.length && /[\w.]/.test(code[index])) index++;
      tokens.push({ kind: "number", text: code.slice(start, index) });
      continue;
    }
    // Regex literals, escaped identifiers and non-ASCII identifiers require a
    // full parser. Never mistake their contents for safely inspected source.
    const previous = tokens.at(-1);
    const division = previous?.kind === "number" || (previous?.kind === "word"
      && !/^(?:return|throw|await|yield|case|delete|typeof|void|new|in|of|else|instanceof)$/.test(previous.text));
    if ((char === "/" && !division) || char === "\\" || char.charCodeAt(0) > 127) ambiguous = true;
    tokens.push({ kind: "punctuation", text: char });
    index++;
  }
  const privateWords = new Set(["browser_type", "globalThis", "global", "window", "self", "this", "eval", "Function", "Reflect", "constructor", "import", "load"]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "word" && privateWords.has(token.text)) ambiguous = true;
    if (token.kind === "word" && token.text === "tools") {
      // Bare/aliased tools and every computed access can carry browser_type.
      if (tokens[index + 1]?.text !== "." || tokens[index + 2]?.kind !== "word"
        || tokens[index + 3]?.text !== "(") ambiguous = true;
    }
  }
  if (!ambiguous) return code;
  secrets.remember(code);
  for (const token of tokens) if (token.kind === "string") secrets.remember(token.text);
  return OMITTED;
}

function privateToolArgs(name: string, args: unknown, secrets: ActivitySecrets): unknown {
  if (name === "codemode") {
    const record = asRecord(args);
    if (!record || typeof record.code !== "string") return OMITTED;
    return { ...record, code: privateCode(record.code, secrets) };
  }
  if (name !== "browser_type") return args;
  // Opaque browser refs cannot tell us whether the target is a password field.
  const record = asRecord(args);
  if (!record) return REDACTED;
  if (typeof record.text === "string" && record.text !== REDACTED) {
    secrets.remember(record.text);
    return { ...record, text: REDACTED };
  }
  return record;
}

/** Only execution events enter this collection; partial tool-call JSON never reaches the UI. */
export class ToolActivityCollector {
  private readonly calls = new Map<string, { call: ToolCallDetail; startedAt: number }>();
  private omittedCalls = 0;
  private readonly secrets = new ActivitySecrets();

  constructor(config: object = {}) {
    for (const [key, value] of Object.entries(config)) {
      if (secretKey(key) && typeof value === "string" && value.length >= 8) this.secrets.remember(value);
    }
  }

  sanitizeText(text: string): string {
    return this.secrets.sanitize(text);
  }

  /** `reasoningCount` is how many reasoning summaries preceded the event; it is kept from the call's first event. */
  onEvent(event: ToolEvent, aborted = false, reasoningCount?: number): void {
    if (event.toolName === "finish_response" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(event.toolName)) return;
    const args = event.type === "tool_execution_end" ? undefined : privateToolArgs(event.toolName, event.args, this.secrets);
    let entry = this.calls.get(event.toolCallId);
    if (!entry && this.calls.size >= TOOL_ACTIVITY_LIMITS.calls) {
      if (event.type === "tool_execution_start") this.omittedCalls++;
      else safePayload(usefulResult(event.toolName,
        event.type === "tool_execution_update" ? event.partialResult : event.result), this.secrets);
      return;
    }
    if (!entry) {
      entry = { startedAt: Date.now(), call: { id: `tool-${this.calls.size + 1}`, name: event.toolName,
        status: "running", args: event.type === "tool_execution_end" ? null : safePayload(args, this.secrets), result: null, durationMs: null,
        ...(reasoningCount === undefined ? {} : { reasoningBefore: Math.min(1_000, Math.max(0, Math.trunc(reasoningCount))) }) } };
      this.calls.set(event.toolCallId, entry);
    }
    if (event.type === "tool_execution_start") return;
    const output = usefulResult(event.toolName, event.type === "tool_execution_update" ? event.partialResult : event.result);
    entry.call.result = safePayload(output, this.secrets);
    if (event.type === "tool_execution_end") {
      const failed = event.isError || toolResultFailed(output);
      entry.call.status = (aborted && failed) || cancelledResult(output, failed) ? "cancelled" : failed ? "error" : "succeeded";
      entry.call.durationMs = Math.max(0, Date.now() - entry.startedAt);
    }
  }

  snapshot(reasoning: readonly string[] = [], unfinished: "running" | "error" | "cancelled" = "error"): ToolActivity | undefined {
    if (!this.calls.size && !this.omittedCalls) return undefined;
    let remaining = TOOL_ACTIVITY_LIMITS.totalChars;
    const bounded = (payload: ToolPayload | null): ToolPayload | null => {
      if (!payload) return null;
      const result = safeRecordedPayload(payload, this.secrets, Math.min(TOOL_ACTIVITY_LIMITS.payloadChars, Math.max(512, remaining)));
      if (result) remaining -= result.text.length;
      return result;
    };
    const calls: ToolCallDetail[] = [];
    for (const { call, startedAt } of this.calls.values()) {
      const active = call.status === "running";
      calls.push({ ...call, status: active ? unfinished : call.status,
        durationMs: active ? Math.max(0, Date.now() - startedAt) : call.durationMs,
        args: remaining > 512 ? bounded(call.args) : { format: "text", text: OMITTED, truncated: true },
        result: remaining > 512 ? bounded(call.result) : { format: "text", text: OMITTED, truncated: true } });
    }
    const safeReasoning = reasoning.slice(0, TOOL_ACTIVITY_LIMITS.reasoning).flatMap(text => {
      if (remaining <= 512) return [];
      const payload = safePayload(text, this.secrets, Math.min(8_000, remaining));
      if (!payload) return [];
      remaining -= payload.text.length;
      return [payload.text];
    });
    return { version: 1, calls, reasoning: safeReasoning, omittedCalls: this.omittedCalls };
  }
}

/** Validate old/untrusted database payloads and reapply privacy and size limits. */
export function savedToolActivity(input: unknown): ToolActivity | undefined {
  const record = asRecord(input);
  if (record?.version !== 1 || !Array.isArray(record.calls)) return undefined;
  const secrets = new ActivitySecrets();
  // Uninspected historical calls may contain values echoed by retained calls.
  if (record.calls.length > TOOL_ACTIVITY_LIMITS.calls) secrets.withhold = true;
  const validated = record.calls.slice(0, TOOL_ACTIVITY_LIMITS.calls).flatMap(candidate => {
    const parsed = callSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.name === "finish_response") return [];
    const call = parsed.data;
    if ((call.name === "browser_type" || call.name === "codemode") && call.args) {
      let args: unknown = call.args.text;
      try { args = JSON.parse(call.args.text); } catch { /* Withhold malformed private input. */ }
      call.args = safePayload(privateToolArgs(call.name, args, secrets), secrets);
    }
    // Discover nested browser values before sanitizing any earlier call/output.
    if (call.result) call.result = safeRecordedPayload(call.result, secrets, TOOL_ACTIVITY_LIMITS.payloadChars);
    return [call];
  });
  const calls: ToolCallDetail[] = [];
  let remaining = TOOL_ACTIVITY_LIMITS.totalChars;
  for (const call of validated) {
    const safe = (payload: ToolPayload | null): ToolPayload | null => {
      if (!payload) return null;
      if (remaining < 512) return { format: "text", text: OMITTED, truncated: true };
      const result = safeRecordedPayload(payload, secrets, Math.min(TOOL_ACTIVITY_LIMITS.payloadChars, remaining));
      if (result) remaining -= result.text.length;
      return result;
    };
    calls.push({ ...call, id: `tool-${calls.length + 1}`, args: safe(call.args), result: safe(call.result) });
  }
  if (!calls.length) return undefined;
  const reasoning = Array.isArray(record.reasoning) ? record.reasoning.slice(0, TOOL_ACTIVITY_LIMITS.reasoning).flatMap(text => {
    if (typeof text !== "string" || remaining < 512) return [];
    const safe = safePayload(text, secrets, Math.min(8_000, remaining));
    if (!safe) return [];
    remaining -= safe.text.length;
    return [safe.text];
  }) : [];
  const omittedCalls = typeof record.omittedCalls === "number" && Number.isSafeInteger(record.omittedCalls) && record.omittedCalls >= 0 ? record.omittedCalls : 0;
  return { version: 1, calls, reasoning, omittedCalls: omittedCalls + Math.max(0, record.calls.length - TOOL_ACTIVITY_LIMITS.calls) };
}
