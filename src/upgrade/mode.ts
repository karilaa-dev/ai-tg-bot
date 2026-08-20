export function assertTelegramStartupAllowed(environment: NodeJS.ProcessEnv = process.env): void {
  const mode = environment.UPGRADE_MODE ?? "";
  if (!mode) return;
  if (mode === "import") {
    throw new Error("Telegram startup is disabled while UPGRADE_MODE=import.");
  }
  throw new Error("UPGRADE_MODE must be unset or 'import'.");
}
