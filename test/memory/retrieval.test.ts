import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { clearRetrievalVectorCacheForTests, hybridSearch, threadChainScope } from "../../src/memory/retrieval.js";

describe("Pi retrieval tools backend", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    db = createDatabase(loadTestConfig());
    await db.initialize();
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

  it("uses FTS for message-only search", async () => {
    const user = await repos.users.ensure({ tgId: 302, firstName: "Vector" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "meaning probe available" },
      textPlain: "meaning probe available",
    });
    const hits = await hybridSearch({
      search: db.search,
      repos,
      threadIds: [thread.id],
      fileIds: [],
      query: "meaning probe",
      k: 3,
    });

    expect(hits[0]).toMatchObject({ kind: "message", ref_id: message.id });
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
      size: 1,
      contentMd: "v",
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
      size: 1,
      contentMd: "h",
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

  it("hides later queued messages and their attachments behind the active message boundary", async () => {
    const user = await repos.users.ensure({ tgId: 304, firstName: "FIFO" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const activeFile = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "active.txt",
      size: 6,
      contentMd: "active",
      isInline: true,
    });
    const queuedFile = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "queued.txt",
      size: 6,
      contentMd: "queued",
      isInline: true,
    });
    const active = await repos.turnRuns.accept({
      userId: user.tg_id,
      threadId: thread.id,
      chatId: user.tg_id,
      messageThreadId: null,
      locale: "en",
      kind: "file",
      content: { text: "active" },
      textPlain: "active",
      sources: [{ updateId: 3041, messageId: 1 }],
      attachments: [{ fileId: activeFile.id }],
    });
    const queued = await repos.turnRuns.accept({
      userId: user.tg_id,
      threadId: thread.id,
      chatId: user.tg_id,
      messageThreadId: null,
      locale: "en",
      kind: "file",
      content: { text: "queued" },
      textPlain: "queued",
      sources: [{ updateId: 3042, messageId: 2 }],
      attachments: [{ fileId: queuedFile.id }],
    });

    const scope = await threadChainScope(repos, thread, active.userMessage.id);
    expect(scope.messageIds).toContain(active.userMessage.id);
    expect(scope.messageIds).not.toContain(queued.userMessage.id);
    expect(scope.fileIds).toContain(activeFile.id);
    expect(scope.fileIds).not.toContain(queuedFile.id);
  });
});
