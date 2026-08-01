import fs from "node:fs/promises";
import type { ThreadRow, UserRow } from "../db/types.js";
import { formatUtcOffset } from "../bot/timezone.js";
import type { Repos } from "../db/repos/index.js";
import { threadChainScope } from "../memory/retrieval.js";
import { isCamofoxConfigured, type AppConfig } from "../config.js";

export async function renderThreadSystemPrompt(input: {
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  config?: Pick<AppConfig, "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY" | "WEB_EXTRACT_PROVIDER">;
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
  config?: Pick<AppConfig, "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY" | "WEB_EXTRACT_PROVIDER">;
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
    camofox_guidance: camofoxGuidance(input.config),
    office_preview_guidance: officePreviewGuidance(input.config),
  };
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{{${key}}}`, value);
  return out;
}

function camofoxGuidance(
  config: Pick<AppConfig, "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY" | "WEB_EXTRACT_PROVIDER"> | undefined,
): string {
  if (!config || !isCamofoxConfigured(config)) return "";
  const loader = config.WEB_EXTRACT_PROVIDER === "camofox"
    ? "`web_extract` loads known URLs through Camofox; its Tavily-specific query/depth/format options do not change Camofox snapshots."
    : "`web_extract` continues to load known URLs through Tavily.";
  return [
    `- ${loader}`,
    "- For every real-browser action, use the appropriate Camofox tool. Start with `camofox_create_tab`; use `camofox_navigate`, `camofox_snapshot`, `camofox_click`, `camofox_type`, `camofox_press`, and `camofox_scroll` for navigation, reading, and interaction; use `camofox_screenshot` and `camofox_send_file` for delivery; and finish with `camofox_close_tab`.",
    "- Never use `bash`, E2B, Chrome/Chromium, Playwright, Puppeteer, Selenium, curl, or another browser/runtime for opening, navigating, interacting with, capturing, or downloading from web pages when Camofox tools are available. Do not use `create_file` to deliver a browser screenshot or browser file.",
    "- `web_search` remains the Tavily search tool. `web_extract` may load known URLs through the configured extraction provider, but neither replaces Camofox for an interactive browser action.",
    "- `camofox_snapshot` screenshots are model-only. For every request to receive a web-page screenshot, use `camofox_screenshot` directly; never use `bash`, a sandbox browser, or `create_file` for browser screenshots.",
    "- A normal screenshot uses Camofox's regular 1920-pixel desktop surface with an automatically chosen height (normally 720-1440 pixels) that keeps the primary visible section intact without oversized empty margins. Keep full_page=false. Use full_page=true only when the user explicitly says full page, whole page, entire page, or equivalent.",
    "- A normal screenshot is delivered as a Telegram photo. If and only if the user asks for it as a file or document, set delivery=document; this still captures and delivers directly through Camofox without E2B.",
    "- To send a browser file, call `camofox_send_file` with a page-link ref or public HTTP(S) URL. For a recorded browser download, call `camofox_list_downloads` first and pass its completed download_index. Delivery is direct and does not use E2B.",
    "- Camofox tabs and cookies are isolated to this Telegram thread. Element refs reset after navigation; take a new snapshot before interacting again.",
    "- Close tabs with `camofox_close_tab` when the browsing task is complete.",
  ].join("\n");
}

function officePreviewGuidance(
  config: Pick<AppConfig, "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY"> | undefined,
): string {
  if (!config || !isCamofoxConfigured(config)) return "";
  return [
    "After creating or materially editing an Office document, call `render_office_preview` for model-only visual QA of the relevant page or slide.",
    "The preview screenshot is not sent to Telegram. Fix visible layout problems before attaching the Office file.",
  ].join("\n");
}
