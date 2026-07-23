import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig, type AppConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { migrateBoxliteData, promoteLegacyThreadWorkspace } from "../../src/boxlite/migrateData.js";
import { botThreadWorkspace } from "../../src/boxlite/paths.js";

describe("BoxLite data migration", () => {
  let root: string;
  let config: AppConfig;
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-boxlite-migrate-"));
    config = loadTestConfig({
      DB_URL: `sqlite:${path.join(root, "bot.db")}`,
      BASH_WORKSPACE_ROOT: path.join(root, "legacy-bash"),
      AGENT_SHARED_ROOT: path.join(root, "agent"),
      MANAGED_FILE_ROOT: path.join(root, "agent", ".chat-files"),
    });
    db = createDatabase(config);
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("dry-runs, applies, and idempotently preserves legacy workspaces and managed files", async () => {
    const user = await repos.users.ensure({ tgId: 501, firstName: "Migration", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Legacy" });
    const legacyWorkspace = path.join(config.BASH_WORKSPACE_ROOT, `thread-${thread.id}`);
    await fs.mkdir(path.join(legacyWorkspace, "nested"), { recursive: true });
    const legacyNote = path.join(legacyWorkspace, "nested", "note.txt");
    await fs.writeFile(legacyNote, "legacy workspace");
    await fs.chmod(legacyNote, 0o755);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "saved.txt",
      path: path.join(config.BASH_WORKSPACE_ROOT, ".chat-files", "1", "content"),
      size: 12,
      summary: "saved",
      isInline: true,
    });
    const legacyManaged = path.join(config.BASH_WORKSPACE_ROOT, ".chat-files", String(file.id), "content");
    await fs.mkdir(path.dirname(legacyManaged), { recursive: true });
    await fs.writeFile(legacyManaged, "managed file");

    const dryRun = await migrateBoxliteData({ config, db, apply: false });
    expect(dryRun).toMatchObject({ dryRun: true, workspaces: 1, workspaceFilesCopied: 1, managedFilesCopied: 1 });
    await expect(fs.access(botThreadWorkspace(config, user.tg_id, thread.id))).rejects.toThrow();

    const applied = await migrateBoxliteData({ config, db, apply: true });
    expect(applied.conflicts).toBe(0);
    const migratedNote = path.join(botThreadWorkspace(config, user.tg_id, thread.id), "nested", "note.txt");
    await expect(fs.readFile(migratedNote, "utf8")).resolves.toBe("legacy workspace");
    expect((await fs.stat(migratedNote)).mode & 0o777).toBe(0o755);
    const stored = await repos.files.get(file.id);
    expect(stored?.path).toBe(path.join(config.MANAGED_FILE_ROOT, String(file.id), "content"));
    await expect(fs.readFile(stored!.path!, "utf8")).resolves.toBe("managed file");

    const repeated = await migrateBoxliteData({ config, db, apply: true });
    expect(repeated).toMatchObject({ conflicts: 0, workspaceFilesCopied: 0, managedFilesCopied: 0 });
    expect(repeated.identicalFiles).toBeGreaterThan(0);
  });

  it("refuses workspace symlinks instead of following them", async () => {
    const user = await repos.users.ensure({ tgId: 502, firstName: "Unsafe", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Unsafe" });
    const legacyWorkspace = path.join(config.BASH_WORKSPACE_ROOT, `thread-${thread.id}`);
    await fs.mkdir(legacyWorkspace, { recursive: true });
    await fs.writeFile(path.join(root, "outside.txt"), "outside");
    await fs.symlink(path.join(root, "outside.txt"), path.join(legacyWorkspace, "link.txt"));

    const result = await migrateBoxliteData({ config, db, apply: true });
    expect(result.unsafeEntries).toBe(1);
    await expect(fs.access(path.join(botThreadWorkspace(config, user.tg_id, thread.id), "link.txt"))).rejects.toThrow();
  });

  it("reports a declared managed-file path that is missing", async () => {
    const user = await repos.users.ensure({ tgId: 503, firstName: "Missing", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Missing" });
    await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "missing.txt",
      path: path.join(root, "missing-content"),
      size: 10,
      summary: "missing",
      isInline: true,
    });

    const result = await migrateBoxliteData({ config, db, apply: false });

    expect(result.conflicts).toBe(1);
  });

  it("uses a persistent promotion marker after the module is reloaded", async () => {
    const user = await repos.users.ensure({ tgId: 504, firstName: "Marker", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Marker" });
    const legacyWorkspace = path.join(config.BASH_WORKSPACE_ROOT, `thread-${thread.id}`);
    const target = botThreadWorkspace(config, user.tg_id, thread.id);
    await fs.mkdir(legacyWorkspace, { recursive: true });
    await fs.writeFile(path.join(legacyWorkspace, "note.txt"), "legacy");
    await promoteLegacyThreadWorkspace(config, user.tg_id, thread.id);
    await fs.writeFile(path.join(target, "note.txt"), "updated in BoxLite");

    vi.resetModules();
    const reloaded = await import("../../src/boxlite/migrateData.js");
    await reloaded.promoteLegacyThreadWorkspace(config, user.tg_id, thread.id);

    await expect(fs.readFile(path.join(target, "note.txt"), "utf8")).resolves.toBe("updated in BoxLite");
  });
});
