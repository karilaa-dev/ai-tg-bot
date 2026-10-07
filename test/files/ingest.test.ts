import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { classifyFile, ingestFileBytes, refreshExtractedFileBytes, type FileIngestProgress } from "../../src/files/ingest.js";
import { createReadFileSectionTool } from "../../src/ai/tools/readFileSection.js";
import { createSearchInFileTool } from "../../src/ai/tools/searchInFile.js";

describe("file ingestion", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("classifies text/csv as csv before generic text", () => {
    expect(classifyFile("airtravel.csv", "text/csv")).toBe("csv");
    expect(classifyFile("download", "text/csv")).toBe("csv");
    expect(classifyFile("notes.txt", "text/plain")).toBe("txt");
  });

  it("persists attachment metadata without a host filesystem snapshot", async () => {
    const user = await repos.users.ensure({ tgId: 220, firstName: "Image", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const result = await ingestFileBytes({
      config: loadTestConfig(),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "telegram.png",
      mime: "image/png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      imageSummary: "a transient Telegram image",
    });

    expect(result.type).toBe("image");
    const stored = await repos.files.get(result.fileId);
    expect(stored).toMatchObject({
      mime_type: "image/png",
    });
    expect(await repos.files.listSources(result.fileId)).toEqual([]);
  });

  it("ingests csv files with trailing blank lines", async () => {
    const user = await repos.users.ensure({ tgId: 221, firstName: "Csv", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config: loadTestConfig(),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "airtravel.csv",
      mime: "text/csv",
      bytes: Buffer.from('"Month","1958"\n"JAN",340\n\n'),
    });

    expect(result.inline).toBe(true);
    expect(result.type).toBe("csv");
    expect(result.card).toContain("[[chat-file:");
    expect(result.card).toContain('"JAN"');
    const file = await repos.files.get(result.fileId);
    expect(file?.content_md).toContain("1 rows");

    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: result.card },
      textPlain: result.card,
    });
    await repos.files.setMessageId(result.fileId, message.id);
    await expect(db.search.searchMessages([thread.id], "JAN", 10)).resolves.toEqual([
      expect.objectContaining({ id: message.id }),
    ]);
  });

  it("indexes CSV headers and record ranges consistently when creating and refreshing files", async () => {
    const config = loadTestConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 229, firstName: "Csv", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const initial = await ingestFileBytes({
      config, repo: repos.files, userId: user.tg_id, threadId: thread.id,
      name: "records.csv", bytes: Buffer.from('id,note\n1,"two\nlines"\n2,last\n\n'),
    });
    expect(await repos.files.chunks(initial.fileId)).toMatchObject([{
      heading_path: "rows 1-2", content: 'id,note\n1,"two\nlines"\n2,last',
    }]);
    await refreshExtractedFileBytes({
      config, repo: repos.files, file: (await repos.files.get(initial.fileId))!,
      bytes: Buffer.from("id,note\n3,changed\n"),
    });
    expect(await repos.files.chunks(initial.fileId)).toMatchObject([{
      heading_path: "rows 1-1", content: "id,note\n3,changed",
    }]);
  });

  it.each(["ingest", "refresh"])("keeps a wide header-only CSV searchable and readable after %s", async (operation) => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 230, firstName: "Csv" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const header = [...Array.from({ length: 1800 }, (_, i) => `column_${i}`), "needlecolumn"].join(",");
    const result = await ingestFileBytes({
      config, repo: repos.files, userId: user.tg_id, threadId: thread.id,
      name: "headers.csv", bytes: Buffer.from(header + (operation === "refresh" ? "\nobsolete" : "\n\n")),
    });
    if (operation === "refresh") {
      await refreshExtractedFileBytes({
        config, repo: repos.files, file: (await repos.files.get(result.fileId))!, bytes: Buffer.from(header + "\n\n"),
      });
    }
    const message = await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "CSV" });
    await repos.files.setMessageId(result.fileId, message.id);
    const stored = (await repos.files.get(result.fileId))!;
    expect(stored).toMatchObject({ is_inline: 0, content_md: null });
    expect(stored.summary).not.toContain("needlecolumn");
    const input = { config, db, repos, user, thread };
    expect(await createSearchInFileTool(input).execute({ file_id: result.fileId, query: "needlecolumn", limit: 8 }))
      .toMatchObject({ results: [{ file_id: result.fileId, chunk_index: 0 }] });
    expect(await createReadFileSectionTool(input).execute({ file_id: result.fileId, chunk_index: 0, count: 1 }))
      .toMatchObject({ content: `# chunk 0 - header\n${header}` });
    expect(await db.search.searchChunks([result.fileId], "obsolete", 8)).toEqual([]);
  });

  it("indexes text with an outline and progress, then replaces its searchable content on refresh", async () => {
    const config = loadTestConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 225, firstName: "Refresh", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const progress: FileIngestProgress[] = [];
    const initial = await ingestFileBytes({
      config,
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "changing.txt",
      mime: "text/plain",
      bytes: Buffer.from("# Old\n\n" + "old indexed phrase ".repeat(300)),
      onStage: (stage) => { progress.push(stage); },
    });
    const file = (await repos.files.get(initial.fileId))!;
    const oldChunks = await repos.files.chunks(file.id);
    expect(initial.inline).toBe(false);
    expect(JSON.parse(file.outline_json!)).toEqual(oldChunks.map((chunk) => ({
      chunk_index: chunk.idx, heading_path: chunk.heading_path,
    })));
    expect(progress.at(-1)).toEqual({ stage: "indexing", completed: oldChunks.length, total: oldChunks.length });
    expect(progress.every((entry) => entry.stage === "extracting" || entry.stage === "indexing")).toBe(true);
    expect(await db.search.searchChunks([file.id], "old", 8)).toEqual(expect.arrayContaining([
      expect.objectContaining({ snippet: expect.stringContaining("old") }),
    ]));

    const refreshed = await refreshExtractedFileBytes({
      config,
      repo: repos.files,
      file,
      bytes: Buffer.from("# New\n\n" + "new indexed phrase ".repeat(300)),
      mime: "text/plain",
    });
    const newChunks = await repos.files.chunks(file.id);

    expect(refreshed.extraction_status).toBe("ready");
    expect(refreshed.content_sha256).not.toBe(file.content_sha256);
    expect(newChunks.map((chunk) => chunk.id)).not.toEqual(oldChunks.map((chunk) => chunk.id));
    expect(newChunks.map((chunk) => chunk.content).join("\n")).toContain("new indexed phrase");
    expect(await db.search.searchChunks([file.id], "new", 8)).toEqual(expect.arrayContaining([
      expect.objectContaining({ snippet: expect.stringContaining("new") }),
    ]));
    expect(await db.search.searchChunks([file.id], "old", 8)).toEqual([]);
  });

  it.each([
    ["pdf", "short-note.pdf", "application/pdf"],
    ["docx", "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ] as const)("registers %s documents as source-only without host extraction", async (type, name, mime) => {
    const user = await repos.users.ensure({ tgId: 332, firstName: "SandboxDoc", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config: loadTestConfig({ FILE_INLINE_TOKENS: 1 }),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name,
      mime,
      bytes: Buffer.from("opaque document bytes"),
    });

    expect(result.type).toBe(type);
    expect(result.inline).toBe(false);
    expect(result.card).toContain("materialize_chat_files");
    const file = await repos.files.get(result.fileId);
    expect(file).toMatchObject({ extraction_status: "source_only", content_md: null, is_inline: 0 });
    const chunks = await repos.files.chunks(result.fileId);
    expect(chunks).toEqual([]);
  });
});
