import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { clearRetrievalVectorCacheForTests, hybridSearch, threadChainScope } from "../../src/memory/retrieval.js";

describe("Pi retrieval tools backend", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    db = createDatabase(loadTestConfig());
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    clearRetrievalVectorCacheForTests();
    await db.destroy();
  });

  it("merges message and file-chunk lexical hits", async () => {
    const user = await repos.users.ensure({ tgId: 301, firstName: "Lexical" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "orchid release checklist" },
      textPlain: "orchid release checklist",
    });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "txt",
      name: "notes.txt",
      path: "/tmp/notes.txt",
      size: 10,
      isInline: false,
    });
    const chunk = await repos.files.insertChunk({ fileId: file.id, idx: 0, content: "orchid deployment detail" });
    const scope = await threadChainScope(repos, thread);

    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: scope.threadIds,
      messageIds: scope.messageIds,
      fileIds: scope.fileIds,
      query: "orchid",
      k: 10,
    });

    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", ref_id: message.id }),
      expect.objectContaining({ kind: "chunk", ref_id: chunk.id }),
    ]));
  });

  it("uses FTS for message-only search without invoking the embedder", async () => {
    const user = await repos.users.ensure({ tgId: 302, firstName: "Vector" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "meaning probe available" },
      textPlain: "meaning probe available",
    });
    const embed = vi.fn(async () => [new Float32Array([0, 1])]);

    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      fileIds: [],
      query: "meaning probe",
      k: 3,
      embedder: { model: "test-embed", embed },
      embeddingModel: "test-embed",
    });

    expect(hits[0]).toMatchObject({ kind: "message", ref_id: message.id });
    expect(embed).not.toHaveBeenCalled();
  });

  it("finds semantic file-chunk hits when current-model vectors exist", async () => {
    const user = await repos.users.ensure({ tgId: 304, firstName: "ChunkVector" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "attached notes" },
      textPlain: "attached notes",
    });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "txt",
      name: "notes.txt",
      path: "/tmp/notes.txt",
      size: 10,
      isInline: false,
    });
    const first = await repos.files.insertChunk({ fileId: file.id, idx: 0, content: "unrelated lexical text" });
    const semantic = await repos.files.insertChunk({ fileId: file.id, idx: 1, content: "different wording" });
    await repos.embeddings.upsert("chunk", first.id, new Float32Array([1, 0]), "test-embed");
    await repos.embeddings.upsert("chunk", semantic.id, new Float32Array([0, 1]), "test-embed");
    const embed = vi.fn(async () => [new Float32Array([0, 1])]);

    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      fileIds: [file.id],
      query: "meaning probe",
      k: 3,
      embedder: { model: "test-embed", embed },
      embeddingModel: "test-embed",
    });

    expect(hits[0]).toMatchObject({ kind: "chunk", ref_id: semantic.id });
    expect(embed).toHaveBeenCalledOnce();
  });

  it("skips query embedding when only old-model chunk vectors exist", async () => {
    const user = await repos.users.ensure({ tgId: 305, firstName: "OldVector" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "old.txt",
      path: "/tmp/old.txt",
      size: 10,
      isInline: false,
    });
    const chunk = await repos.files.insertChunk({ fileId: file.id, idx: 0, content: "orchid deployment detail" });
    await repos.embeddings.upsert("chunk", chunk.id, new Float32Array([0, 1]), "old-embed");
    const embed = vi.fn(async () => [new Float32Array([0, 1])]);

    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      fileIds: [file.id],
      query: "orchid",
      k: 3,
      embedder: { model: "new-embed", embed },
      embeddingModel: "new-embed",
    });

    expect(hits[0]).toMatchObject({ kind: "chunk", ref_id: chunk.id });
    expect(embed).not.toHaveBeenCalled();
  });

  it("returns lexical results when query embedding fails", async () => {
    const user = await repos.users.ensure({ tgId: 306, firstName: "Fallback" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "orchid release checklist" },
      textPlain: "orchid release checklist",
    });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "txt",
      name: "fallback.txt",
      path: "/tmp/fallback.txt",
      size: 10,
      isInline: false,
    });
    const chunk = await repos.files.insertChunk({ fileId: file.id, idx: 0, content: "orchid deployment detail" });
    await repos.embeddings.upsert("chunk", chunk.id, new Float32Array([0, 1]), "test-embed");

    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      fileIds: [file.id],
      query: "orchid",
      k: 3,
      embedder: { model: "test-embed", embed: async () => { throw new Error("provider unavailable"); } },
      embeddingModel: "test-embed",
    });

    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", ref_id: message.id }),
      expect.objectContaining({ kind: "chunk", ref_id: chunk.id }),
    ]));
  });

  it("keeps message and file retrieval inside a fork boundary", async () => {
    const user = await repos.users.ensure({ tgId: 303, firstName: "Fork" });
    const parent = await repos.threads.activeForUserTopic(user.tg_id, null);
    const before = await repos.messages.insert({
      threadId: parent.id,
      role: "user",
      content: { text: "visible pre-fork sentinel" },
      textPlain: "visible pre-fork sentinel",
    });
    const visibleFile = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: parent.id,
      messageId: before.id,
      type: "txt",
      name: "visible.txt",
      path: "/tmp/visible.txt",
      size: 1,
      isInline: true,
    });
    const fork = await repos.threads.create({
      userId: user.tg_id,
      topicId: 303,
      title: "Fork",
      parentThreadId: parent.id,
      forkPointMessageId: before.id,
    });
    const after = await repos.messages.insert({
      threadId: parent.id,
      role: "assistant",
      content: { text: "hidden post-fork sentinel" },
      textPlain: "hidden post-fork sentinel",
    });
    const hiddenFile = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: parent.id,
      messageId: after.id,
      type: "txt",
      name: "hidden.txt",
      path: "/tmp/hidden.txt",
      size: 1,
      isInline: true,
    });
    const local = await repos.messages.insert({
      threadId: fork.id,
      role: "user",
      content: { text: "visible fork-local sentinel" },
      textPlain: "visible fork-local sentinel",
    });

    const scope = await threadChainScope(repos, fork);
    expect(scope.messageIds).toEqual([before.id, local.id]);
    expect(scope.fileIds).toContain(visibleFile.id);
    expect(scope.fileIds).not.toContain(hiddenFile.id);
    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: scope.threadIds,
      messageIds: scope.messageIds,
      fileIds: scope.fileIds,
      query: "sentinel",
      k: 10,
    });
    expect(hits.some((hit) => hit.kind === "message" && hit.ref_id === after.id)).toBe(false);
  });
});
