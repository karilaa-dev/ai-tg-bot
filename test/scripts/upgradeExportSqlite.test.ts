import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const exporter = path.resolve("node_modules/.bin/tsx");
const script = path.resolve("scripts/upgrade-export-sqlite.ts");

describe("SQLite migration export", () => {
  let tempDir: string | undefined;
  let sourceDirectory: string | undefined;

  afterEach(async () => {
    if (sourceDirectory) await fs.chmod(sourceDirectory, 0o700).catch(() => undefined);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("backs up a stopped WAL database from a read-only source mount", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-sqlite-export-"));
    sourceDirectory = path.join(tempDir, "source");
    const outputDirectory = path.join(tempDir, "output");
    const sourceFile = path.join(sourceDirectory, "bot.db");
    const outputFile = path.join(outputDirectory, "bot.db");
    await fs.mkdir(sourceDirectory);
    await fs.mkdir(outputDirectory);

    await execFileAsync(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const source = new Database(process.argv[1]);
      source.pragma("journal_mode = WAL");
      source.pragma("wal_autocheckpoint = 0");
      source.exec("create table sample(value text not null)");
      source.prepare("insert into sample values (?)").run("preserved");
      process.exit(0);
    `, sourceFile]);

    const walFile = `${sourceFile}-wal`;
    expect((await fs.stat(walFile)).size).toBeGreaterThan(0);
    const mainOnlyFile = path.join(tempDir, "main-only.db");
    await fs.copyFile(sourceFile, mainOnlyFile);
    const mainOnly = new Database(mainOnlyFile);
    try {
      expect(() => mainOnly.prepare("select value from sample").all()).toThrow(/no such table/);
    } finally {
      mainOnly.close();
    }

    await Promise.all([sourceFile, walFile, `${sourceFile}-shm`].map(async (file) => {
      await fs.chmod(file, 0o444).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }));
    await fs.chmod(sourceDirectory, 0o555);

    await expect(execFileAsync(exporter, [script, "--out", outputFile], {
      env: { ...process.env, DB_URL: `sqlite:${sourceFile}` },
    })).resolves.toMatchObject({ stdout: expect.stringContaining("sqlite-backup-created") });

    const backup = new Database(outputFile, { readonly: true, fileMustExist: true });
    try {
      expect(backup.prepare("select value from sample").all()).toEqual([{ value: "preserved" }]);
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      backup.close();
    }
    expect((await fs.readdir(outputDirectory)).sort()).toEqual(["bot.db"]);
  });
});
