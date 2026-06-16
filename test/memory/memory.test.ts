import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { compactThread } from "../../src/memory/compactor.js";
import { buildContext } from "../../src/memory/contextBuilder.js";
import { clearRetrievalVectorCacheForTests, hybridSearch, threadChainScope } from "../../src/memory/retrieval.js";

describe("memory subsystem", () => {
  let db: AppDatabase;
  let repos: Repos;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    clearRetrievalVectorCacheForTests();
    await db.destroy();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("compacts old messages into L0 summaries and searchable rolling memory", async () => {
    const user = await repos.users.ensure({ tgId: 1, firstName: "A", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    for (let i = 0; i < 14; i += 1) {
      await repos.messages.insert({
        threadId: thread.id,
        role: i % 2 ? "assistant" : "user",
        content: { text: `Message ${i} about project-plan-${i}` },
        textPlain: `Message ${i} about project-plan-${i}`,
      });
    }

    const result = await compactThread(repos, thread, {
      recentWindowMessages: 2,
      embedder: { embed: async (texts) => texts.map((text) => new Float32Array([text.length, 2])) },
    });

    expect(result.count).toBe(12);
    const updated = await repos.threads.get(thread.id);
    expect(updated?.compacted_upto_message_id).toBeGreaterThan(0);
    expect(updated?.meta_summary).toContain("project-plan-0");
    const summaries = await repos.summaries.listForThreads([thread.id], 0);
    expect(summaries.length).toBeGreaterThan(0);
    const embeddings = await repos.embeddings.list("summary", summaries.map((summary) => summary.id));
    expect(embeddings).toHaveLength(summaries.length);
    const fts = await db.search.searchSummaries([thread.id], "project-plan-0", 5);
    expect(fts[0]?.id).toBe(summaries[0]?.id);
  }, 60_000);

  it("uses an injected summarizer for segment and rolling memory summaries", async () => {
    const user = await repos.users.ensure({ tgId: 11, firstName: "Summarizer", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    for (let i = 0; i < 12; i += 1) {
      await repos.messages.insert({
        threadId: thread.id,
        role: i % 2 ? "assistant" : "user",
        content: { text: `Raw message ${i}` },
        textPlain: `Raw message ${i}`,
      });
    }
    const segmentRanges: string[] = [];

    const result = await compactThread(repos, thread, {
      recentWindowMessages: 1,
      summarizer: {
        summarizeSegment: async ({ messages }) => {
          segmentRanges.push(`${messages[0]?.id}-${messages.at(-1)?.id}`);
          return `LLM segment ${messages[0]?.id}-${messages.at(-1)?.id}`;
        },
        mergeMeta: async ({ summaries }) => `LLM merged memory: ${summaries.join(" | ")}`,
      },
    });

    expect(segmentRanges).toHaveLength(1);
    expect(result.summary).toContain("LLM merged memory");
    const summaries = await repos.summaries.listForThreads([thread.id], 0);
    expect(summaries[0]?.content).toContain("LLM segment");
    const updated = await repos.threads.get(thread.id);
    expect(updated?.meta_summary).toBe(result.summary);
  });

  it("builds context from persisted messages without duplicating the latest user turn", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 2, firstName: "B", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "Remember this once." },
      textPlain: "Remember this once.",
    });

    const ctx = await buildContext({
      config,
      repos,
      search: db.search,
      user,
      thread,
      newUserText: "Remember this once.",
    });

    expect(ctx.messages.filter((message) => message.content === "Remember this once.")).toHaveLength(1);
  });

  it("attaches image bytes for uncompacted image messages in model context", async () => {
    const config = loadTestConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "whiteboard.jpg");
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
    const user = await repos.users.ensure({ tgId: 21, firstName: "Image", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: "[image #1: whiteboard]" },
      textPlain: "[image: whiteboard]",
    });
    await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "image",
      name: "whiteboard.jpg",
      path: imagePath,
      size: 4,
      summary: "[image: whiteboard]",
      isInline: true,
    });

    const ctx = await buildContext({
      config,
      repos,
      search: db.search,
      user,
      thread,
      newUserText: "what is in the image?",
    });

    const imageMessage = ctx.messages.find((ctxMessage) => Array.isArray(ctxMessage.content));
    expect(imageMessage?.role).toBe("user");
    const parts = imageMessage?.content as Array<{ type: string; image?: Buffer; mediaType?: string }> | undefined;
    expect(parts?.some((part) => part.type === "image" && Buffer.isBuffer(part.image) && part.mediaType === "image/jpeg")).toBe(true);
    expect(ctx.tokensEst).toBeGreaterThan(1100);
  });

  it("creates short image descriptions only when compacting", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "sketch.jpg");
    const imageBytes = Buffer.from([7, 8, 9, 10]);
    await fs.writeFile(imagePath, imageBytes);
    const user = await repos.users.ensure({ tgId: 211, firstName: "CompactionImage", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      name: "sketch.jpg",
      path: imagePath,
      size: imageBytes.length,
      summary: null,
      isInline: true,
    });
    const imageMessage = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: `[image #${file.id}: sketch.jpg]` },
      textPlain: `[image #${file.id}: sketch.jpg]`,
    });
    await repos.files.setMessageId(file.id, imageMessage.id);
    for (let i = 0; i < 10; i += 1) {
      await repos.messages.insert({
        threadId: thread.id,
        role: i % 2 ? "assistant" : "user",
        content: { text: `Compaction filler ${i}` },
        textPlain: `Compaction filler ${i}`,
      });
    }
    const seenNames: string[] = [];

    const result = await compactThread(repos, thread, {
      recentWindowMessages: 1,
      imageCaptioner: {
        caption: async ({ bytes, name }) => {
          seenNames.push(name);
          expect(bytes).toEqual(imageBytes);
          return "a short compaction-only sketch description";
        },
      },
    });

    expect(result.count).toBe(10);
    expect(seenNames).toEqual(["sketch.jpg"]);
    await expect(repos.files.get(file.id)).resolves.toMatchObject({
      summary: "a short compaction-only sketch description",
    });
    const summaries = await repos.summaries.listForThreads([thread.id], 0);
    expect(summaries.map((summary) => summary.content).join("\n")).toContain("[image #");
    expect(summaries.map((summary) => summary.content).join("\n")).toContain("a short compaction-only sketch description");
  });

  it("caps parent context at the fork point while keeping fork-local messages", async () => {
    const user = await repos.users.ensure({ tgId: 22, firstName: "Fork", lang: "en" });
    const parent = await repos.threads.activeForUserTopic(user.tg_id, null);
    await repos.messages.insert({
      threadId: parent.id,
      role: "user",
      content: { text: "parent before fork" },
      textPlain: "parent before fork",
    });
    const forkPoint = await repos.messages.insert({
      threadId: parent.id,
      role: "assistant",
      content: { text: "parent at fork" },
      textPlain: "parent at fork",
    });
    const fork = await repos.threads.create({
      userId: user.tg_id,
      topicId: 42,
      title: "Fork",
      parentThreadId: parent.id,
      forkPointMessageId: forkPoint.id,
    });
    await repos.messages.insert({
      threadId: parent.id,
      role: "assistant",
      content: { text: "parent after fork should be hidden" },
      textPlain: "parent after fork should be hidden",
    });
    await repos.messages.insert({
      threadId: fork.id,
      role: "user",
      content: { text: "fork-local message" },
      textPlain: "fork-local message",
    });

    const rows = await repos.messages.listForThreadChain(await repos.threads.chain(fork));

    expect(rows.map((row) => row.text_plain)).toEqual(["parent before fork", "parent at fork", "fork-local message"]);
  });

  it("keeps retrieval scoped to the fork boundary", async () => {
    const user = await repos.users.ensure({ tgId: 23, firstName: "ForkSearch", lang: "en" });
    const parent = await repos.threads.activeForUserTopic(user.tg_id, null);
    const before = await repos.messages.insert({
      threadId: parent.id,
      role: "user",
      content: { text: "visible shared fork detail" },
      textPlain: "visible shared fork detail",
    });
    const fork = await repos.threads.create({
      userId: user.tg_id,
      topicId: 43,
      title: "Fork Search",
      parentThreadId: parent.id,
      forkPointMessageId: before.id,
    });
    const after = await repos.messages.insert({
      threadId: parent.id,
      role: "assistant",
      content: { text: "leaky parent after fork detail" },
      textPlain: "leaky parent after fork detail",
    });
    const local = await repos.messages.insert({
      threadId: fork.id,
      role: "user",
      content: { text: "visible fork-local detail" },
      textPlain: "visible fork-local detail",
    });

    const scope = await threadChainScope(repos, fork);
    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: scope.threadIds,
      messageIds: scope.messageIds,
      summaryIds: scope.summaryIds,
      query: "visible leaky",
      k: 10,
    });

    expect(scope.messageIds).toEqual([before.id, local.id]);
    expect(hits.some((hit) => hit.kind === "message" && hit.ref_id === before.id)).toBe(true);
    expect(hits.some((hit) => hit.kind === "message" && hit.ref_id === local.id)).toBe(true);
    expect(hits.some((hit) => hit.kind === "message" && hit.ref_id === after.id)).toBe(false);
  });

  it("keeps compacted original messages searchable and loadable by tool scope", async () => {
    const user = await repos.users.ensure({ tgId: 25, firstName: "CompactScope", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    let compactedMessageId = 0;
    for (let i = 0; i < 14; i += 1) {
      const message = await repos.messages.insert({
        threadId: thread.id,
        role: i % 2 ? "assistant" : "user",
        content: { text: `archive searchable sentinel ${i}` },
        textPlain: `archive searchable sentinel ${i}`,
      });
      if (i === 0) compactedMessageId = message.id;
    }
    const result = await compactThread(repos, thread, { recentWindowMessages: 2 });
    expect(result.count).toBe(12);
    const compacted = (await repos.threads.get(thread.id))!;

    const contextRows = await repos.messages.listForThreadChain(await repos.threads.chain(compacted));
    const scope = await threadChainScope(repos, compacted);
    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: scope.threadIds,
      messageIds: scope.messageIds,
      summaryIds: scope.summaryIds,
      query: "archive searchable sentinel 0",
      k: 5,
    });

    expect(contextRows.some((row) => row.id === compactedMessageId)).toBe(false);
    expect(scope.messageIds).toContain(compactedMessageId);
    expect(hits.some((hit) => hit.kind === "message" && hit.ref_id === compactedMessageId)).toBe(true);
  });

  it("keeps files scoped to the fork boundary through their owning messages", async () => {
    const user = await repos.users.ensure({ tgId: 24, firstName: "ForkFiles", lang: "en" });
    const parent = await repos.threads.activeForUserTopic(user.tg_id, null);
    const before = await repos.messages.insert({
      threadId: parent.id,
      role: "user",
      kind: "file",
      content: { text: "pre-fork file" },
      textPlain: "pre-fork file",
    });
    const preForkFile = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: parent.id,
      messageId: before.id,
      type: "txt",
      name: "before.txt",
      path: "data/files/before.txt",
      size: 1,
      isInline: true,
    });
    const fork = await repos.threads.create({
      userId: user.tg_id,
      topicId: 44,
      title: "Fork Files",
      parentThreadId: parent.id,
      forkPointMessageId: before.id,
    });
    const after = await repos.messages.insert({
      threadId: parent.id,
      role: "user",
      kind: "file",
      content: { text: "post-fork file" },
      textPlain: "post-fork file",
    });
    const postForkFile = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: parent.id,
      messageId: after.id,
      type: "txt",
      name: "after.txt",
      path: "data/files/after.txt",
      size: 1,
      isInline: true,
    });

    const scope = await threadChainScope(repos, fork);

    expect(scope.fileIds).toContain(preForkFile.id);
    expect(scope.fileIds).not.toContain(postForkFile.id);
    const ctx = await buildContext({
      config: loadTestConfig(),
      repos,
      search: db.search,
      user,
      thread: fork,
      newUserText: "what files are available?",
    });
    expect(ctx.system).toContain("before.txt");
    expect(ctx.system).not.toContain("after.txt");
  });

  it("merges stored vector hits with FTS retrieval", async () => {
    const user = await repos.users.ensure({ tgId: 3, firstName: "C", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const a = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "alpha topic" },
      textPlain: "alpha topic",
    });
    const b = await repos.messages.insert({
      threadId: thread.id,
      role: "assistant",
      content: { text: "beta topic" },
      textPlain: "beta topic",
    });
    await repos.embeddings.upsert("message", a.id, new Float32Array([1, 0]));
    await repos.embeddings.upsert("message", b.id, new Float32Array([0, 1]));

    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      query: "semantic only",
      k: 3,
      embedder: { embed: async () => [new Float32Array([0, 1])] },
    });

    expect(hits[0]).toMatchObject({ kind: "message", ref_id: b.id });
  });

  it("caches decoded retrieval vectors across repeated searches", async () => {
    const user = await repos.users.ensure({ tgId: 31, firstName: "Cache", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "cached vector target" },
      textPlain: "cached vector target",
    });
    await repos.embeddings.upsert("message", message.id, new Float32Array([1, 0]));
    let vectorLoads = 0;
    const originalList = repos.embeddings.list.bind(repos.embeddings);
    repos.embeddings.list = async (kind, refIds) => {
      vectorLoads += kind === "message" && refIds.includes(message.id) ? 1 : 0;
      return originalList(kind, refIds);
    };
    const search = () => hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      query: "semantic cache probe",
      k: 3,
      embedder: { embed: async () => [new Float32Array([1, 0])] },
    });

    expect((await search())[0]).toMatchObject({ kind: "message", ref_id: message.id });
    expect((await search())[0]).toMatchObject({ kind: "message", ref_id: message.id });
    expect(vectorLoads).toBe(1);
  });
});
