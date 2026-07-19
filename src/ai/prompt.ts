import fs from "node:fs/promises";
import type { ThreadRow, UserRow } from "../db/types.js";
import { formatUtcOffset } from "../bot/timezone.js";
import type { Repos } from "../db/repos/index.js";
import { threadChainScope } from "../memory/retrieval.js";

export async function renderThreadSystemPrompt(input: {
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  now?: Date;
}): Promise<string> {
  const scope = await threadChainScope(input.repos, input.thread);
  const files = await input.repos.files.listByIds(scope.fileIds);
  const filesOverview = files.map((file) => {
    const mode = file.type === "image" ? "chat reference" : file.is_inline ? "inline" : "searchable";
    return `- #${file.id} ${file.name} (${file.type}, ${mode}; bash: /attachments/${file.id})${file.summary ? ` — ${file.summary.split("\n")[0]}` : ""}`;
  }).join("\n");
  return renderSystemPrompt({ ...input, filesOverview });
}

export async function renderSystemPrompt(input: {
  user: UserRow;
  thread: ThreadRow;
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
  };
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{{${key}}}`, value);
  return out;
}
