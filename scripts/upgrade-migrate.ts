import path from "node:path";
import { readUpgradeAuditEnvironmentOrFile } from "../src/upgrade/environment.js";
import { runUpgradeImport } from "../src/upgrade/offlineImport.js";

const artifactsDir = parseArguments(process.argv.slice(2));
if (process.env.UPGRADE_MODE?.trim() !== "import") {
  throw new Error("upgrade:migrate requires UPGRADE_MODE=import.");
}
if (process.getuid?.() === 0) {
  throw new Error("upgrade:migrate must run through docker/entrypoint.sh as the non-root application user.");
}

const piCodingAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR?.trim() || "/app/data/pi");
const baselineFile = path.resolve(
  process.env.UPGRADE_BASELINE_FILE?.trim() || path.join(piCodingAgentDir, "upgrade-baseline.json"),
);
const result = await runUpgradeImport({
  artifactsDir,
  dbUrl: readUpgradeAuditEnvironmentOrFile("DB_URL"),
  piCodingAgentDir,
  baselineFile,
  botToken: readUpgradeAuditEnvironmentOrFile("BOT_TOKEN"),
  e2bDeploymentId: process.env.E2B_DEPLOYMENT_ID?.trim()
    || process.env.OPEN_SANDBOX_DEPLOYMENT_ID?.trim()
    || "ai-tg-bot",
  browserUseDeploymentId: process.env.BROWSER_USE_DEPLOYMENT_ID?.trim() || "ai-tg-bot",
  onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});
process.stdout.write(`${JSON.stringify(result)}\n`);

function parseArguments(args: string[]): string {
  const [flag, directory, ...rest] = args;
  if (flag !== "--from" || !directory || rest.length) {
    throw new Error("Usage: npm run upgrade:migrate -- --from <artifact-directory>");
  }
  return path.resolve(directory);
}
