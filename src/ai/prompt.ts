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
  mode: "chat reference" | "inline" | "searchable";
  summary?: string | null;
}

export async function renderThreadSessionContext(input: {
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  now?: Date;
}): Promise<string> {
  const scope = await threadChainScope(input.repos, input.thread);
  const files = await input.repos.files.listByIds(scope.fileIds);
  const promptFiles: PromptFileContext[] = files.map((file) => ({
    id: file.id,
    name: file.name,
    type: file.type,
    mode: file.type === "image"
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
    office_preview_guidance: officePreviewGuidance(input.config),
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
    "# Browser Use Cloud",
    "",
    "- Use `web_extract` for one stateless read of known readable pages. Use `browser_*` for screenshots, visual verification, scrolling, clicks, forms, login, downloads, or continued page actions; do not substitute Bash browsers, curl, or `create_file` for those tasks.",
    "- Browser screenshots and files go directly to Telegram. Use `browser_screenshot` for a requested screenshot, full-page capture only when explicitly requested, and document delivery only when explicitly requested as a file/document.",
    "- Cookies and persistent storage are shared through the user's private profile; tabs are thread-owned. Element refs expire after navigation, so snapshot again before interacting.",
    `- Sessions use a configured default of ${config.BROWSER_USE_DEFAULT_TIMEOUT_MINUTES} minutes. Request or extend a longer session only for clearly long tasks; extension preserves profile, URLs, tab IDs, and scroll positions but not transient form or JavaScript state.`,
    "- When the current browser task is complete, call `browser_close_session` as the final browser action. Use `browser_close_tab` only while the same task still needs other tabs. If closure reports `session_busy`, do not force or repeatedly retry it; automatic idle cleanup is the fallback.",
  ].join("\n");
}

function officePreviewGuidance(
  config: Pick<AppConfig, "BROWSER_USE_API_KEY"> | undefined,
): string {
  if (!config || !isBrowserUseConfigured(config)) return "";
  return [
    "- For every created or materially edited PPTX, call `render_office_preview` for every slide. For every created or materially edited DOCX, preview every rendered page.",
    "- Inspect each image for overlap, clipping, overflow, wrapping, contrast, cropping, margins, gaps, alignment, density, placeholders, and narrative order. Fix failures, save and validate again, then re-preview changed pages; stop after three unsuccessful fix cycles and report the blocker.",
    "- Do not attach the Office file until structural validation and required visual QA pass. Preview images are model-only and are not sent to Telegram.",
  ].join("\n");
}
