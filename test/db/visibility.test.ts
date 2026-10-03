import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { threadVisibilityScope } from "../../src/memory/retrieval.js";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.TEST_POSTGRES_URL)(`${dialect} visibility`, () => {
    it("projects IDs across forks, reused files, queued messages, and unattached inbound sources", async () => {
      const schema = `visibility_${randomUUID().replaceAll("-", "")}`;
      const admin = dialect === "postgres" ? createDatabase(loadTestConfig({ DB_URL: process.env.TEST_POSTGRES_URL! })) : undefined;
      const url = admin ? new URL(process.env.TEST_POSTGRES_URL!) : undefined;
      if (admin && url) {
        await admin.db.execute(sql.raw(`create schema ${schema}`));
        url.searchParams.set("options", `-c search_path=${schema}`);
      }
      const db = createDatabase(loadTestConfig(url ? { DB_URL: url.toString() } : {}));
      try {
        await db.initialize();
        const repos = createRepos(db.db, db.search);
        const user = await repos.users.ensure({ tgId: 777, firstName: "Scope" });
        const parent = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Parent" });
        const message = (threadId: number, text: string) => repos.messages.insert({ threadId, role: "user", content: { text }, textPlain: text });
        const beforeFork = await message(parent.id, "before fork empty __empty__");
        const child = await repos.threads.create({ userId: user.tg_id, topicId: 1, title: "Child", parentThreadId: parent.id, forkPointMessageId: beforeFork.id });
        const afterFork = await message(parent.id, "after fork");
        const accepted = await message(child.id, "accepted");
        const queued = await message(child.id, "queued");
        const other = await repos.threads.create({ userId: user.tg_id, topicId: 2, title: "Other" });
        const otherMessage = await message(other.id, "other");
        const file = (threadId: number, messageId?: number) => repos.files.insertFile({
          userId: user.tg_id, threadId, messageId, type: "txt", name: "notes.txt", size: 5, contentMd: "notes", isInline: true,
        });
        const visible = await file(parent.id, beforeFork.id);
        await repos.files.insertChunk({ fileId: visible.id, idx: 0, content: "empty __empty__" });
        await repos.files.attachToMessage(beforeFork.id, visible.id, {});
        await file(parent.id, afterFork.id);
        await file(parent.id);
        await file(child.id, queued.id);
        const reused = await file(other.id, otherMessage.id);
        await repos.files.attachToMessage(accepted.id, reused.id, { displayName: "accepted-name.txt" });
        await repos.files.attachToMessage(queued.id, reused.id, { displayName: "queued-name.txt" });
        const reusedPending = await file(other.id);
        await repos.files.attachToMessage(accepted.id, reusedPending.id, {});
        const reusedAfterFork = await file(other.id);
        await repos.files.attachToMessage(afterFork.id, reusedAfterFork.id, {});
        const reusedQueued = await file(other.id);
        await repos.files.attachToMessage(queued.id, reusedQueued.id, {});
        const localQueued = await file(child.id);
        await repos.files.attachToMessage(queued.id, localQueued.id, {});
        const outgoing = await file(child.id);
        const inbound = await file(child.id);
        await repos.files.rememberSource(inbound.id, { transport: "telegram", connectionKey: "test", remoteKey: "inbound", locator: {} });

        const scope = await threadVisibilityScope(repos, child, accepted.id);
        expect(scope.messageIds).toEqual([beforeFork.id, accepted.id]);
        expect(scope.fileIds).toEqual([visible.id, reused.id, reusedPending.id, outgoing.id]);
        expect((await repos.files.get(reused.id, scope.messageScopes))?.name).toBe("accepted-name.txt");
        expect((await repos.files.get(reusedPending.id, scope.messageScopes))?.name).toBe(`attachment-${reusedPending.id}.txt`);
        expect((await repos.messages.listForThreadChain([parent, child], accepted.id)).map((row) => row.id)).toEqual(scope.messageIds);
        expect((await repos.messages.listForThreadChain([parent, child])).map((row) => row.id)).toEqual([beforeFork.id, accepted.id, queued.id]);
        const currentScope = await threadVisibilityScope(repos, child);
        expect(currentScope.fileIds).toContain(inbound.id);
        expect(currentScope.fileIds).toContain(reusedQueued.id);
        expect(currentScope.fileIds).toContain(localQueued.id);
        expect(currentScope.fileIds).not.toContain(reusedAfterFork.id);
        expect((await repos.files.get(reused.id, currentScope.messageScopes))?.name).toBe("queued-name.txt");
        expect((await threadVisibilityScope(repos, child, 0)).messageIds).toEqual([]);
        expect(await repos.messages.listIdsForScopes([])).toEqual([]);
        expect(await repos.files.listVisibleIds([], false)).toEqual([]);

        // Forking again inside inherited history also bounds earlier ancestors.
        const branch = await repos.threads.create({ userId: user.tg_id, topicId: 3, title: "Branch", parentThreadId: parent.id, forkPointMessageId: afterFork.id });
        const nested = await repos.threads.create({ userId: user.tg_id, topicId: 4, title: "Nested", parentThreadId: branch.id, forkPointMessageId: beforeFork.id });
        const nestedMessage = await message(nested.id, "nested reply");
        const nestedScope = await threadVisibilityScope(repos, nested);
        expect(nestedScope.messageIds).toEqual([beforeFork.id, nestedMessage.id]);
        expect(nestedScope.fileIds).toEqual([visible.id]);
        expect((await repos.messages.listForThreadChain([parent, branch, nested])).map(row => row.id)).toEqual(nestedScope.messageIds);
        expect(await db.search.searchMessages(nestedScope.threadIds, "after", 10, nestedScope.messageScopes)).toEqual([]);
        expect((await db.search.searchMessages(nestedScope.threadIds, "before missingterm", 10, nestedScope.messageScopes)).map(hit => hit.id))
          .toEqual([beforeFork.id]);
        expect(await db.search.searchMessages(nestedScope.threadIds, " \t\n ", 10, nestedScope.messageScopes)).toEqual([]);
        expect(await db.search.searchChunks(nestedScope.fileIds, " \t\n ", 10)).toEqual([]);
        const emptyFork = await repos.threads.create({ userId: user.tg_id, topicId: 5, title: "Empty", parentThreadId: parent.id });
        expect((await threadVisibilityScope(repos, emptyFork)).messageIds).toEqual([]);
      } finally {
        await db.destroy();
        if (admin) {
          await admin.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
          await admin.destroy();
        }
      }
    });
  });
}
