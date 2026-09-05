import fs from "node:fs/promises";
import type { ThreadRow, UserRow } from "../db/types.js";
import { formatUtcOffset } from "../bot/timezone.js";
import type { Repos } from "../db/repos/index.js";
import { threadChainScope } from "../memory/retrieval.js";
import { isBrowserUseConfigured, type AppConfig } from "../config.js";

export const MAX_SYSTEM_PROMPT_FILES = 25;
export const MAX_PROMPT_USER_NAME_CHARS = 120;
export const MAX_PROMPT_THREAD_TITLE_CHARS = 160;
export const MAX_PROMPT_FILE_NAME_CHARS = 180;
export const MAX_PROMPT_FILE_SUMMARY_CHARS = 160;

const PLACEHOLDER_RE = /\{\{([a-z_]+)\}\}/gu;
let templatePromise: Promise<string> | undefined;

export interface PromptFileContext {
  id: number;
  name: string;
  type: string;
  mode: "chat reference" | "inline" | "searchable" | "sandbox source";
  summary?: string | null;
}

export async function renderThreadSessionContext(input: {
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  maxMessageId?: number;
  fileIds?: number[];
  now?: Date;
}): Promise<string> {
  const fileIds = input.fileIds ?? (await threadChainScope(input.repos, input.thread, input.maxMessageId)).fileIds;
  const files = await input.repos.files.listByIds(fileIds);
  const promptFiles: PromptFileContext[] = files.map((file) => ({
    id: file.id,
    name: file.name,
    type: file.type,
    mode: file.type === "pdf" || file.type === "docx"
      ? "sandbox source"
      : file.type === "image" || file.type === "audio"
      ? "chat reference"
      : file.is_inline ? "inline" : "searchable",
    summary: file.summary,
  }));
  return renderSessionContext({ ...input, files: promptFiles });
}

export async function renderSystemPrompt(input: {
  user: UserRow;
  config?: Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_DEFAULT_TIMEOUT_MINUTES">;
}): Promise<string> {
  const values: Record<string, string> = {
    language: input.user.lang === "ru" ? "Russian" : "English",
    browser_guidance: browserGuidance(input.config),
    office_preview_guidance: officePreviewGuidance(),
  };
  return renderPromptTemplate(await loadTemplate(), values);
}

export function renderSessionContext(input: {
  user: UserRow;
  thread: ThreadRow;
  files: PromptFileContext[];
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const offset = input.user.tz_offset_min ?? 0;
  const local = new Date(now.getTime() + offset * 60_000);
  return formatSessionContext({
    userName: input.user.first_name ?? String(input.user.tg_id),
    timedate: local.toISOString().slice(0, 16).replace("T", " "),
    timezone: formatUtcOffset(offset),
    threadTitle: input.thread.title,
    files: input.files,
  });
}

function loadTemplate(): Promise<string> {
  templatePromise ??= fs.readFile("system_prompt.md", "utf8").catch((error) => {
    templatePromise = undefined;
    throw error;
  });
  return templatePromise;
}

export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  const withoutValidPlaceholders = template.replace(PLACEHOLDER_RE, "");
  if (withoutValidPlaceholders.includes("{{") || withoutValidPlaceholders.includes("}}")) {
    throw new Error("Invalid system prompt placeholder syntax.");
  }
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    if (!(key in values)) throw new Error(`Unknown system prompt placeholder: {{${key}}}`);
    used.add(key);
    return values[key]!;
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length) throw new Error(`System prompt is missing placeholders for: ${unused.join(", ")}`);
  return rendered;
}

function formatSessionContext(input: {
  userName: string;
  timedate: string;
  timezone: string;
  threadTitle: string;
  files: PromptFileContext[];
}): string {
  const ordered = [...input.files].sort((a, b) => a.id - b.id);
  const included = ordered.slice(-MAX_SYSTEM_PROMPT_FILES);
  const json = JSON.stringify({
    user_name: truncate(input.userName, MAX_PROMPT_USER_NAME_CHARS),
    current_time: input.timedate,
    timezone: input.timezone,
    thread_title: truncate(input.threadTitle, MAX_PROMPT_THREAD_TITLE_CHARS),
    files: included.map((file) => ({
      id: file.id,
      name: truncate(singleLine(file.name), MAX_PROMPT_FILE_NAME_CHARS),
      type: file.type,
      mode: file.mode,
      summary: file.summary
        ? truncate(singleLine(file.summary), MAX_PROMPT_FILE_SUMMARY_CHARS)
        : null,
    })),
    omitted_file_count: ordered.length - included.length,
  }, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `<session_context format="json" trust="untrusted-data-only">\n${json}\n</session_context>`;
}

function truncate(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function browserGuidance(
  config: Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_DEFAULT_TIMEOUT_MINUTES"> | undefined,
): string {
  if (!config || !isBrowserUseConfigured(config)) return "";
  return [
    "Use browser_* for interactive pages, screenshots, login, and downloads. Snapshot after navigation before using element refs. Close the browser session when finished; let idle cleanup handle session_busy.",
    `New sessions default to ${config.BROWSER_USE_DEFAULT_TIMEOUT_MINUTES} minutes. Extend only for long tasks; transient form state is lost on extension.`,
  ].join("\n");
}

function officePreviewGuidance(): string {
  return "For Office delivery, call validate_office_file, use render_office_preview to inspect every page or slide, then record passing visual_reviews with the current source_sha256. All checks must pass before delivery. Edits invalidate the previous review. After three unsuccessful repair cycles explain the blocker without sending the draft.";
}
