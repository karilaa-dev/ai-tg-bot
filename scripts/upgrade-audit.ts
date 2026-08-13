import path from "node:path";
import { createDatabase } from "../src/db/index.js";
import {
  createUpgradeAuditManifest,
  readUpgradeAuditManifest,
  verifyUpgradeAuditManifest,
  writeUpgradeAuditManifest,
} from "../src/upgrade/audit.js";

type Command =
  | { kind: "snapshot"; file: string }
  | { kind: "verify"; file: string };

const command = parseCommand(process.argv.slice(2));
const dbUrl = process.env.DB_URL?.trim() || "sqlite:./data/bot.db";
const piCodingAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR?.trim() || "./data/pi");
const botToken = process.env.BOT_TOKEN?.trim() || "";
const e2bDeploymentId = process.env.E2B_DEPLOYMENT_ID?.trim()
  || process.env.OPEN_SANDBOX_DEPLOYMENT_ID?.trim()
  || "ai-tg-bot";
const browserUseDeploymentId = process.env.BROWSER_USE_DEPLOYMENT_ID?.trim() || "ai-tg-bot";
const database = createDatabase({ DB_URL: dbUrl });

try {
  if (command.kind === "snapshot") {
    const manifest = await createUpgradeAuditManifest(
      database.db,
      piCodingAgentDir,
      botToken,
      e2bDeploymentId,
      browserUseDeploymentId,
    );
    const manifestSha256 = await writeUpgradeAuditManifest(command.file, manifest);
    process.stdout.write(`${JSON.stringify({
      status: "snapshot-created",
      file: path.resolve(command.file),
      manifestSha256,
      datasets: Object.fromEntries(
        Object.entries(manifest.datasets).map(([name, dataset]) => [name, dataset.count]),
      ),
      piSessions: manifest.piSessions.count,
      piStateFiles: manifest.piState.count,
    })}\n`);
  } else {
    const loaded = await readUpgradeAuditManifest(command.file);
    const summary = await verifyUpgradeAuditManifest(
      database.db,
      piCodingAgentDir,
      loaded.manifest,
      { botToken, e2bDeploymentId, browserUseDeploymentId },
    );
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      file: path.resolve(command.file),
      ...summary,
      manifestSha256: loaded.manifestSha256,
    })}\n`);
  }
} finally {
  await database.destroy();
}

function parseCommand(args: string[]): Command {
  const [verb, flag, file, ...rest] = args;
  if (rest.length || !file) usage();
  if (verb === "snapshot" && flag === "--out") return { kind: "snapshot", file };
  if (verb === "verify" && flag === "--against") return { kind: "verify", file };
  return usage();
}

function usage(): never {
  process.stderr.write([
    "Usage:",
    "  npm run upgrade:audit -- snapshot --out <manifest.json>",
    "  npm run upgrade:audit -- verify --against <manifest.json>",
    "",
    "DB_URL, PI_CODING_AGENT_DIR, BOT_TOKEN, E2B_DEPLOYMENT_ID, and BROWSER_USE_DEPLOYMENT_ID select the preserved deployment state.",
    "The command never initializes or migrates the database schema.",
    "",
  ].join("\n"));
  process.exit(2);
}
