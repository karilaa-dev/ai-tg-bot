import fs from "node:fs/promises";
import path from "node:path";
import { readUpgradeAuditEnvironmentOrFile } from "../src/upgrade/environment.js";
import { createPostgresService } from "../src/upgrade/exportConnection.js";

const outputFile = parseArguments(process.argv.slice(2));
const dbUrl = readUpgradeAuditEnvironmentOrFile("DB_URL");
const service = createPostgresService(dbUrl);

await fs.writeFile(outputFile, service, { encoding: "utf8", flag: "w", mode: 0o600 });
await fs.chmod(outputFile, 0o600);
process.stdout.write("PostgreSQL connection validated.\n");

function parseArguments(args: string[]): string {
  const [flag, file, ...rest] = args;
  if (flag !== "--out" || !file || rest.length) {
    throw new Error("Usage: upgrade-export-connection --out <pg-service-file>");
  }
  return path.resolve(file);
}
