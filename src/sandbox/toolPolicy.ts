export const SANDBOX_TOOL_GUIDANCE = "Never install, update, or repair sandbox tools. If missing or outdated tools block the task, stop and tell the user that tools in this thread are outdated. Ask them to recreate the chat; never recreate its sandbox yourself.";

export const OUTDATED_SANDBOX_TOOLS_MESSAGE = "Tools in this thread are outdated. Please recreate the chat to use current tools.";

export class SandboxToolsOutdatedError extends Error {
  constructor() {
    super(OUTDATED_SANDBOX_TOOLS_MESSAGE);
    this.name = "SandboxToolsOutdatedError";
  }
}

export function outdatedSandboxToolsReply(lang: "en" | "ru"): string {
  return lang === "ru"
    ? "Инструменты в этой ветке устарели. Пожалуйста, пересоздайте чат, чтобы использовать актуальные инструменты."
    : OUTDATED_SANDBOX_TOOLS_MESSAGE;
}
