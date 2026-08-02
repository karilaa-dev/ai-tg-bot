import fs from "node:fs/promises";
import type { ThreadRow, UserRow } from "../db/types.js";
import { formatUtcOffset } from "../bot/timezone.js";
import type { Repos } from "../db/repos/index.js";
import { threadChainScope } from "../memory/retrieval.js";
import { isBrowserUseConfigured, type AppConfig } from "../config.js";

export async function renderThreadSystemPrompt(input: {
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  config?: Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_DEFAULT_TIMEOUT_MINUTES">;
  now?: Date;
}): Promise<string> {
  const scope = await threadChainScope(input.repos, input.thread);
  const files = await input.repos.files.listByIds(scope.fileIds);
  const filesOverview = files.map((file) => {
    const mode = !file.content_sha256
      ? "sandbox file"
      : file.type === "image"
        ? "chat reference"
        : file.is_inline ? "inline" : "searchable";
    return `- #${file.id} ${file.name} (${file.type}, ${mode}; automatically restored read-only for sandbox tools)${file.summary ? ` — ${file.summary.split("\n")[0]}` : ""}`;
  }).join("\n");
  return renderSystemPrompt({ ...input, filesOverview });
}

export async function renderSystemPrompt(input: {
  user: UserRow;
  thread: ThreadRow;
  config?: Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_DEFAULT_TIMEOUT_MINUTES">;
  filesOverview?: string;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const template = await fs.readFile("system_prompt.md", "utf8");
  const offset = input.user.tz_offset_min ?? 0;
  const local = new Date(now.getTime() + offset * 60_000);
  const timedate = local.toISOString().slice(0, 16).replace("T", " ");
  const values: Record<string, string> = {
    user_name: input.user.first_name ?? String(input.user.tg_id),
    language: input.user.lang === "ru" ? "Russian" : "English",
    timedate,
    timezone: formatUtcOffset(offset),
    thread_title: input.thread.title,
    files_overview: input.filesOverview?.trim() || "- none",
    browser_guidance: browserGuidance(input.config),
    office_preview_guidance: officePreviewGuidance(input.config),
  };
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{{${key}}}`, value);
  return out;
}

function browserGuidance(
  config: Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_DEFAULT_TIMEOUT_MINUTES"> | undefined,
): string {
  if (!config || !isBrowserUseConfigured(config)) return "";
  return [
    "- `web_search` and `web_extract` use Tavily. Use `web_extract` for one stateless read of known page URLs. If the task needs screenshots, visual verification, scrolling, clicks, forms, login, downloads, or continued page actions, switch to the `browser_*` tools instead of chaining extraction as browser automation.",
    "- For real-browser work, start with `browser_open`; use `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, and `browser_scroll`; use `browser_screenshot` and `browser_send_file` for delivery.",
    "- Never use `bash`, E2B, Chrome/Chromium, Playwright, Puppeteer, Selenium, curl, or `create_file` for opening, interacting with, capturing, or downloading from web pages when Browser Use tools are available.",
    "- `browser_snapshot` screenshots are model-only. For a user-requested web screenshot, call `browser_screenshot` directly. Keep full_page=false unless the user explicitly requests the full, whole, or entire page.",
    "- Normal screenshots are Telegram photos. Set delivery=document if and only if the user explicitly asks for a file or document. Browser screenshots and files are delivered directly without E2B.",
    "- For a recorded download, call `browser_list_downloads` and pass its download_index to `browser_send_file`. A latest-snapshot link ref or known public HTTP(S) URL can also be sent directly.",
    "- Cookies and persistent browser storage are shared across all Telegram threads belonging to this user through one private Browser Use profile. Tabs remain private to their originating thread. Element refs reset after navigation; snapshot again before interacting.",
    `- Browser sessions default to ${config.BROWSER_USE_DEFAULT_TIMEOUT_MINUTES} minutes. Request a longer timeout in \`browser_open\` for clearly long tasks. If a tool reports extension_required or little remaining time, call \`browser_extend_session\`; it preserves the profile, URLs, scroll positions, and tab IDs but not unsaved forms, sessionStorage, dialogs, or JavaScript state.`,
    "- Treat the cloud browser as a temporary paid execution resource, not as a page to keep warm. Before giving the final answer, if this turn used `browser_*` and no browser action remains in the current task, you MUST call `browser_close_session`. This is the default after delivering screenshots or files, completing visual verification, extracting information, or finishing clicks/forms.",
    "- A possible future user request is not a reason to leave the browser open: cookies and persistent storage are saved in the user profile when the session closes. Keep the session open only for the rare case where the same currently active task will immediately continue and specifically needs transient tab, form, scroll, or JavaScript state.",
    "- Call `browser_close_tab` instead only when that one tab is finished but the current task still needs other browser tabs. Do not close the whole session between steps of the same task. Every successful browser task should normally end with `browser_close_session` as its final browser tool call.",
    "- If `browser_close_session` returns session_busy, another thread is using the shared user browser. Do not force closure or repeatedly retry; the automatic five-minute cleanup remains the fallback.",
  ].join("\n");
}

function officePreviewGuidance(
  config: Pick<AppConfig, "BROWSER_USE_API_KEY"> | undefined,
): string {
  if (!config || !isBrowserUseConfigured(config)) return "";
  return [
    "For every presentation you create or materially edit, determine its slide count with OfficeCLI and call `render_office_preview` once for every slide. Inspect the actual rendered image of every slide; a schema check or HTML text alone is not visual QA.",
    "Judge each slide adversarially for overlap, clipping, off-slide objects, narrow or excessive wrapping, unreadable contrast, distorted or cropped images, inconsistent margins and gaps, misalignment, unintended density, and broken narrative order.",
    "Fix every visible problem, save and validate again, then re-preview each changed slide. Repeat until a complete pass finds no problems, with at most three fix-and-preview cycles before reporting a blocker.",
    "The preview screenshots are model-only and are not sent to Telegram. Do not call `create_file` for a presentation until all OfficeCLI gates pass and every slide has passed visual QA. If previewing fails, state that the deck was not visually verified instead of claiming completion.",
  ].join("\n");
}
