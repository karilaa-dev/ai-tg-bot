import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../../src/db/index.js";
import type { UpgradeAuditSummary } from "../../src/upgrade/audit.js";
import {
  parseChecksumManifest,
  runUpgradeImport,
} from "../../src/upgrade/offlineImport.js";

const execFileAsync = promisify(execFile);
const DB_URL = "postgresql://importer:secret%20value@postgres:5432/aibot";
const MANIFEST_SHA256 = "a".repeat(64);

describe("offline upgrade import", () => {
  let tempDir: string;
  let artifactsDir: string;
  let piDir: string;
  let baselineFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-offline-import-"));
    artifactsDir = path.join(tempDir, "import");
    piDir = path.join(tempDir, "pi");
    baselineFile = path.join(piDir, "upgrade-baseline.json");
    await fs.mkdir(artifactsDir);
    await fs.mkdir(piDir);
    await createArtifacts(artifactsDir, tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("accepts only the two fixed checksum entries", () => {
    const dumpHash = "1".repeat(64);
    const piHash = "2".repeat(64);
    expect(parseChecksumManifest(`${dumpHash}  aibot.dump\n${piHash} *pi-home.tgz\n`)).toEqual({
      "aibot.dump": dumpHash,
      "pi-home.tgz": piHash,
    });
    expect(() => parseChecksumManifest(`${dumpHash}  renamed.dump\n${piHash}  pi-home.tgz\n`))
      .toThrow("unexpected filename");
    expect(() => parseChecksumManifest(`${dumpHash}  aibot.dump\n`)).toThrow("missing pi-home.tgz");
    expect(() => parseChecksumManifest("not-a-checksum\n")).toThrow("malformed line");
  });

  it("restores, migrates, and verifies in a fixed order", async () => {
    const calls: string[] = [];
    const commands: Array<{ command: string; args: string[]; environment?: NodeJS.ProcessEnv }> = [];
    const database = fakeDatabase(calls);
    const result = await runUpgradeImport({
      artifactsDir,
      dbUrl: DB_URL,
      piCodingAgentDir: piDir,
      baselineFile,
      botToken: "123:bot-token",
      e2bDeploymentId: "source-e2b",
      browserUseDeploymentId: "source-browser",
      dependencies: {
        assertDatabaseEmpty: async () => { calls.push("database-empty"); },
        runCommand: async (command, args, environment) => {
          commands.push({ command, args, environment });
          if (command === "tar") {
            calls.push("pi-restored");
            await execFileAsync(command, args);
          } else if (args.includes("--list")) {
            calls.push("dump-inspected");
          } else {
            calls.push("postgres-restored");
          }
        },
        createDatabase: () => database,
        verifyBaseline: async (input) => {
          calls.push("baseline-verified");
          expect(input).toMatchObject({
            piCodingAgentDir: piDir,
            baselineFile,
            botToken: "123:bot-token",
            e2bDeploymentId: "source-e2b",
            browserUseDeploymentId: "source-browser",
          });
          await fs.writeFile(`${baselineFile}.verified`, "verified\n");
          return { skipped: false, summary: auditSummary() };
        },
      },
    });

    expect(result).toMatchObject({ status: "import-complete", manifestSha256: MANIFEST_SHA256 });
    expect(calls).toEqual([
      "dump-inspected",
      "database-empty",
      "postgres-restored",
      "pi-restored",
      "schema-migrated",
      "baseline-verified",
      "database-destroyed",
    ]);
    const restore = commands.find((command) => command.command === "pg_restore" && !command.args.includes("--list"));
    expect(restore?.args).toEqual([
      "--dbname", "aibot", "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl",
      path.join(artifactsDir, "aibot.dump"),
    ]);
    expect(restore?.environment).toMatchObject({
      PGHOST: "postgres",
      PGPORT: "5432",
      PGUSER: "importer",
      PGPASSWORD: "secret value",
      PGDATABASE: "aibot",
    });
    expect(JSON.parse(await fs.readFile(path.join(artifactsDir, ".upgrade-import-state.json"), "utf8")))
      .toMatchObject({ status: "complete", manifestSha256: MANIFEST_SHA256 });
  });

  it("rejects checksum corruption before inspecting destinations", async () => {
    await fs.appendFile(path.join(artifactsDir, "aibot.dump"), "corrupt");
    const assertDatabaseEmpty = vi.fn();
    await expect(runUpgradeImport(baseInput({ assertDatabaseEmpty })))
      .rejects.toThrow("aibot.dump checksum does not match");
    expect(assertDatabaseEmpty).not.toHaveBeenCalled();
    await expect(fs.access(path.join(artifactsDir, ".upgrade-import-state.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unexpected upload filenames and overlapping source and Pi paths", async () => {
    await fs.writeFile(path.join(artifactsDir, "renamed.dump"), "unexpected");
    await expect(runUpgradeImport(baseInput())).rejects.toThrow("unexpected filename: renamed.dump");
    await fs.rm(path.join(artifactsDir, "renamed.dump"));

    await expect(runUpgradeImport({
      ...baseInput(),
      piCodingAgentDir: artifactsDir,
      baselineFile: path.join(artifactsDir, "upgrade-baseline.json"),
    })).rejects.toThrow("must be separate directories");
  });

  it("rejects malformed archives, missing artifacts, and nonempty targets before mutation", async () => {
    const archive = path.join(artifactsDir, "pi-home.tgz");
    await fs.writeFile(archive, "not a tar archive");
    await rewriteChecksums(artifactsDir);
    await expect(runUpgradeImport(baseInput())).rejects.toThrow("tar failed");

    await createArtifacts(artifactsDir, tempDir);
    await fs.rename(path.join(artifactsDir, "aibot.dump"), path.join(artifactsDir, "renamed.dump"));
    await expect(runUpgradeImport(baseInput())).rejects.toThrow("aibot.dump must be a regular file");

    await fs.rename(path.join(artifactsDir, "renamed.dump"), path.join(artifactsDir, "aibot.dump"));
    await fs.writeFile(path.join(piDir, "unexpected"), "data");
    await expect(runUpgradeImport(baseInput({
      inspectPiArchive: async () => undefined,
    }))).rejects.toThrow("Target Pi volume is not empty");
  });

  it("rejects symbolic links in the Pi archive", async () => {
    const source = path.join(tempDir, "pi-with-link");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "upgrade-baseline.json"), "{}\n");
    await fs.symlink("upgrade-baseline.json", path.join(source, "linked-baseline.json"));
    await execFileAsync("tar", ["-C", source, "-czf", path.join(artifactsDir, "pi-home.tgz"), "."]);
    await rewriteChecksums(artifactsDir);

    await expect(runUpgradeImport(baseInput())).rejects.toThrow("non-regular file or symbolic link");
  });

  it("rejects a stale verification marker during archive preflight", async () => {
    const source = path.join(tempDir, "pi-with-marker");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "upgrade-baseline.json"), "{}\n");
    await fs.writeFile(path.join(source, "upgrade-baseline.json.verified"), "stale\n");
    await execFileAsync("tar", ["-C", source, "-czf", path.join(artifactsDir, "pi-home.tgz"), "."]);
    await rewriteChecksums(artifactsDir);
    const assertDatabaseEmpty = vi.fn();

    await expect(runUpgradeImport(baseInput({ assertDatabaseEmpty })))
      .rejects.toThrow("stale verification marker");
    expect(assertDatabaseEmpty).not.toHaveBeenCalled();
    await expect(fs.access(path.join(artifactsDir, ".upgrade-import-state.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a failed attempt marker after target mutation and refuses a retry", async () => {
    const database = fakeDatabase([], new Error("migration exploded"));
    const input = baseInput({
      inspectPiArchive: async () => undefined,
      runCommand: async (command, args) => {
        if (command === "tar") await execFileAsync(command, args);
      },
      createDatabase: () => database,
    });
    await expect(runUpgradeImport(input)).rejects.toThrow("migration exploded");
    expect(JSON.parse(await fs.readFile(path.join(artifactsDir, ".upgrade-import-state.json"), "utf8")))
      .toMatchObject({ status: "failed", message: "migration exploded" });
    await expect(runUpgradeImport(input)).rejects.toThrow("already contains an upgrade attempt state");
  });

  it("records a failed pg_restore and never opens the application database", async () => {
    const createDatabase = vi.fn(() => fakeDatabase([]));
    const input = baseInput({
      inspectPiArchive: async () => undefined,
      runCommand: async (command, args) => {
        if (command === "pg_restore" && !args.includes("--list")) {
          throw new Error("pg_restore failed (1): restore exploded");
        }
      },
      createDatabase,
    });

    await expect(runUpgradeImport(input)).rejects.toThrow("restore exploded");
    expect(createDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(artifactsDir, ".upgrade-import-state.json"), "utf8")))
      .toMatchObject({ status: "failed", message: expect.stringContaining("restore exploded") });
    await expect(runUpgradeImport(input)).rejects.toThrow("already contains an upgrade attempt state");
  });

  it("rejects a verification that tries to skip", async () => {
    await expect(runUpgradeImport(baseInput({
      verifyBaseline: async () => ({ skipped: true }),
    }))).rejects.toThrow("unexpectedly skipped");
  });

  it("requires verification to create the completion marker", async () => {
    await expect(runUpgradeImport(baseInput({
      verifyBaseline: async () => ({ skipped: false, summary: auditSummary() }),
    }))).rejects.toThrow("upgrade verification marker must be a regular file");
    expect(JSON.parse(await fs.readFile(path.join(artifactsDir, ".upgrade-import-state.json"), "utf8")))
      .toMatchObject({ status: "failed" });
  });

  it("requires PostgreSQL and refuses a nonempty database", async () => {
    await expect(runUpgradeImport({ ...baseInput(), dbUrl: "sqlite:/app/data/bot.db" }))
      .rejects.toThrow("requires a PostgreSQL DB_URL");
    await expect(runUpgradeImport(baseInput({
      inspectPiArchive: async () => undefined,
      assertDatabaseEmpty: async () => { throw new Error("Target PostgreSQL database is not empty."); },
    }))).rejects.toThrow("database is not empty");
  });

  it("requires the source bot identity before destination mutation", async () => {
    const assertDatabaseEmpty = vi.fn();
    await expect(runUpgradeImport({
      ...baseInput({ assertDatabaseEmpty }),
      botToken: "",
    })).rejects.toThrow("BOT_TOKEN is required");
    expect(assertDatabaseEmpty).not.toHaveBeenCalled();
  });

  function baseInput(dependencies: NonNullable<Parameters<typeof runUpgradeImport>[0]["dependencies"]> = {}) {
    return {
      artifactsDir,
      dbUrl: DB_URL,
      piCodingAgentDir: piDir,
      baselineFile,
      botToken: "123:bot-token",
      e2bDeploymentId: "source-e2b",
      browserUseDeploymentId: "source-browser",
      dependencies: {
        assertDatabaseEmpty: async () => undefined,
        runCommand: async (command: string, args: string[]) => {
          if (command === "tar") await execFileAsync(command, args);
        },
        createDatabase: () => fakeDatabase([]),
        verifyBaseline: async () => ({ skipped: false, summary: auditSummary() }),
        ...dependencies,
      },
    };
  }
});

function fakeDatabase(calls: string[], initializeError?: Error): AppDatabase {
  return {
    dialect: "postgres",
    db: {} as AppDatabase["db"],
    search: {} as AppDatabase["search"],
    initialize: async () => {
      if (initializeError) throw initializeError;
      calls.push("schema-migrated");
    },
    destroy: async () => { calls.push("database-destroyed"); },
  };
}

function auditSummary(): UpgradeAuditSummary {
  return {
    manifestSha256: MANIFEST_SHA256,
    datasets: {} as UpgradeAuditSummary["datasets"],
    piSessions: 1,
    piStateFiles: 2,
  };
}

async function createArtifacts(artifactsDir: string, tempDir: string): Promise<void> {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, "aibot.dump"), "fake custom dump\n");
  const source = await fs.mkdtemp(path.join(tempDir, "pi-source-"));
  await fs.mkdir(path.join(source, "sessions"));
  await fs.writeFile(path.join(source, "upgrade-baseline.json"), "{}\n");
  await fs.writeFile(path.join(source, "sessions", "thread.jsonl"), "{}\n");
  await execFileAsync("tar", ["-C", source, "-czf", path.join(artifactsDir, "pi-home.tgz"), "."]);
  await rewriteChecksums(artifactsDir);
}

async function rewriteChecksums(artifactsDir: string): Promise<void> {
  const dumpHash = await sha256(path.join(artifactsDir, "aibot.dump"));
  const piHash = await sha256(path.join(artifactsDir, "pi-home.tgz"));
  await fs.writeFile(
    path.join(artifactsDir, "SHA256SUMS"),
    `${dumpHash}  aibot.dump\n${piHash}  pi-home.tgz\n`,
  );
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}
