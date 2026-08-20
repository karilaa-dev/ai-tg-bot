import { readFileSync } from "node:fs";

type UpgradeAuditSecret = "DB_URL" | "BOT_TOKEN";

const IMAGE_DEFAULTS: Partial<Record<UpgradeAuditSecret, string>> = {
  DB_URL: "sqlite:/app/data/bot.db",
};

export function readUpgradeAuditEnvironmentOrFile(
  name: UpgradeAuditSecret,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const direct = environment[name]?.trim();
  const file = environment[`${name}_FILE`]?.trim();
  if (direct && file && direct !== IMAGE_DEFAULTS[name]) {
    throw new Error(`Set only ${name} or ${name}_FILE, not both.`);
  }
  if (file) return readFileSync(file, "utf8").trim();
  return direct || "";
}
