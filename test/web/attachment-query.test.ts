import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { ConversationRepository, attachmentRowsQuery } from "../../src/web/repository.js";

describe.each(["sqlite", ...(process.env.TEST_POSTGRES_URL ? ["postgres"] : [])])("history attachment lookup (%s)", dialect => {
  let database: AppDatabase;
  let admin: AppDatabase | undefined;
  let schema: string;
  let repos: Repos;
  let repository: ConversationRepository;

  beforeEach(async () => {
    let dbUrl = "sqlite::memory:";
    if (dialect === "postgres") {
      schema = `attachment_query_${randomUUID().replaceAll("-", "")}`;
      admin = createDatabase({ DB_URL: process.env.TEST_POSTGRES_URL! });
      await admin.db.execute(sql.raw(`create schema ${schema}`));
      const url = new URL(process.env.TEST_POSTGRES_URL!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      dbUrl = url.toString();
    }
    database = createDatabase({ DB_URL: dbUrl });
    await database.initialize();
    repos = createRepos(database.db, database.search);
    repository = new ConversationRepository(database.db, repos, 99);
  });
  afterEach(async () => {
    await database.destroy();
    if (admin) { await admin.db.execute(sql.raw(`drop schema ${schema} cascade`)); await admin.destroy(); admin = undefined; }
  });

  async function thread(userId = 1, title = "General") {
    await repos.users.ensure({ tgId: userId, firstName: `Person ${userId}` });
    return repos.threads.create({ userId, title, topicId: null });
  }
  const message = (threadId: string, text = "Hello") =>
    repos.messages.insert({ threadId, role: "user", content: { text }, textPlain: text });
  async function file(threadId: string, messageId: number | null, name = "notes.txt", type: "txt" | "image" = "txt", summary: string | null = null, userId = 1) {
    return repos.files.insertFile({ userId, threadId, messageId, type, name, size: 5, mimeType: type === "image" ? "image/png" : "text/plain", summary, isInline: true });
  }
  const attachments = async (threadId: string, before?: number, after?: number) =>
    (await repository.history(threadId, before, after)).messages.map(m => m.attachments);

  it("returns direct and link-only attachments in creation order", async () => {
    const owner = await thread(1, "Owner");
    const source = await message(owner.id);
    const direct = await file(owner.id, source.id, "owner-direct.txt");
    const other = await thread(2, "Recipient");
    const linked = await message(other.id);
    await repos.files.attachToMessage(linked.id, direct.id, { displayName: "recipient-name.txt", caption: "Recipient caption" });
    const lonely = await message(other.id, "No files");
    await database.db.execute(sql`update files set created_at = 5 where id = ${direct.id}`);

    expect(await attachments(owner.id)).toMatchObject([[{ id: direct.id, name: "owner-direct.txt", caption: null }]]);
    expect(await attachments(other.id)).toMatchObject([
      [{ id: direct.id, name: "recipient-name.txt", caption: "Recipient caption" }],
      [],
    ]);
    expect((await repository.history(other.id)).messages.map(m => m.id)).toEqual([linked.id, lonely.id]);
  });

  it("returns a file once when it is both directly owned and linked to the same message", async () => {
    const t = await thread();
    const m = await message(t.id);
    const f = await file(t.id, m.id, "original.txt");
    await repos.files.attachToMessage(m.id, f.id, { displayName: "renamed.txt", caption: "Caption" });
    const result = (await attachments(t.id))[0]!;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: f.id, name: "renamed.txt", caption: "Caption" });
  });

  it("returns one entry per selected message when messages refer to the same file", async () => {
    const owner = await thread(1, "Owner");
    const original = await message(owner.id);
    const shared = await file(owner.id, original.id, "owner-private.txt");
    const other = await thread(2, "Recipient");
    const first = await message(other.id);
    const second = await message(other.id);
    const third = await message(other.id);
    await repos.files.attachToMessage(first.id, shared.id, { displayName: "first.txt", caption: "First" });
    await repos.files.attachToMessage(second.id, shared.id, { displayName: "second.txt" });
    await repos.files.attachToMessage(third.id, shared.id);
    const history = await attachments(other.id);
    expect(history).toMatchObject([
      [{ id: shared.id, name: "first.txt", caption: "First" }],
      [{ id: shared.id, name: "second.txt", caption: null }],
      [{ id: shared.id, name: `attachment-${shared.id}.txt`, caption: null }],
    ]);
    expect(history.every(list => list.length === 1)).toBe(true);
    expect(JSON.stringify(history)).not.toContain("owner-private");
  });

  it("hides owner names and image descriptions that are outside the viewing scope", async () => {
    const parent = await thread();
    const first = await message(parent.id);
    const visible = await file(parent.id, first.id, "visible.png", "image", "Visible description");
    const later = await message(parent.id);
    const hidden = await file(parent.id, later.id, "after-fork.png", "image", "Description after the fork");
    const child = await repos.threads.create({ userId: 1, topicId: 1, title: "Child", parentThreadId: parent.id, forkPointMessageId: first.id });
    const grandchild = await repos.threads.create({ userId: 1, topicId: 2, title: "Grandchild", parentThreadId: child.id, forkPointMessageId: first.id });
    const mine = await message(grandchild.id);
    await repos.files.attachToMessage(mine.id, visible.id);
    await repos.files.attachToMessage(mine.id, hidden.id, { caption: "Mine" });
    await database.db.execute(sql`update files set created_at = case when id = ${visible.id} then 1 else 2 end`);

    const result = (await repository.history(grandchild.id)).messages;
    expect(result.map(m => m.id)).toEqual([first.id, mine.id]);
    expect(result[0]!.attachments).toMatchObject([{ id: visible.id, name: "visible.png", description: "Visible description" }]);
    expect(result[1]!.attachments).toMatchObject([
      { id: visible.id, name: "visible.png", description: "Visible description" },
      { id: hidden.id, name: `attachment-${hidden.id}.png`, caption: "Mine", description: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("after-fork");
    expect(JSON.stringify(result)).not.toContain("after the fork");
  });

  it("does not attach files to unselected messages or other users' histories", async () => {
    const owner = await thread(1, "Owner");
    const mine = await message(owner.id);
    const theirs = await thread(2, "Theirs");
    const foreign = await message(theirs.id);
    const unrelated = await file(theirs.id, foreign.id, "foreign.txt", "txt", null, 2);
    await repos.files.attachToMessage(foreign.id, unrelated.id);
    expect(await attachments(owner.id)).toEqual([[]]);
    expect((await repository.history(owner.id)).messages.map(m => m.id)).toEqual([mine.id]);
    expect(await attachments(theirs.id)).toMatchObject([[{ id: unrelated.id, name: "foreign.txt" }]]);
  });

  it("pages attachments by the selected messages only", async () => {
    const t = await thread();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await message(t.id, `m${i}`);
      ids.push(m.id);
      await file(t.id, m.id, `file-${i}.txt`);
    }
    expect(await attachments(t.id, ids[2])).toMatchObject([[{ name: "file-0.txt" }], [{ name: "file-1.txt" }]]);
    expect(await attachments(t.id, undefined, ids[2])).toMatchObject([[{ name: "file-2.txt" }]]);
  });

  it("returns no attachments for plain and empty histories", async () => {
    const t = await thread();
    expect((await repository.history(t.id)).messages).toEqual([]);
    await message(t.id);
    expect(await attachments(t.id)).toEqual([[]]);
  });

  it("does not run the generated query for an empty selection", async () => {
    expect(attachmentRowsQuery([], [])).toBeNull();
  });

  if (dialect === "sqlite") {
    it("looks files up by selected message instead of scanning every file", async () => {
      const owner = await thread(1, "Owner");
      const m = await message(owner.id);
      const target = await file(owner.id, m.id, "target.txt");
      const other = await thread(2, "Other");
      const linked = await message(other.id);
      await repos.files.attachToMessage(linked.id, target.id, { displayName: "linked.txt" });
      // Thousands of unrelated files belonging to other users and messages.
      await database.db.execute(sql`
        with recursive n(i) as (select 1 union all select i + 1 from n where i < 4000)
        insert into files(id, user_id, thread_id, message_id, requires_message, type, mime_type, extraction_status, name, size, is_inline, created_at)
        select 'bulk-' || i, 2, ${other.id}, null, 0, 'txt', 'text/plain', 'ready', 'bulk.txt', 1, 1, i from n
      `);
      const query = attachmentRowsQuery([m.id, linked.id], [{ threadId: owner.id }]);
      expect(query).not.toBeNull();
      const plan = await database.db.query<{ detail: string }>(sql`explain query plan ${query!}`);
      const details = plan.map(row => row.detail);
      expect(details).toContainEqual(expect.stringMatching(/^SEARCH direct USING INDEX files_message_id_idx \(message_id=\?\)/));
      expect(details).toContainEqual(expect.stringMatching(/^SEARCH link USING COVERING INDEX sqlite_autoindex_message_files_1 \(message_id=\?\)/));
      // The only scan allowed is the small candidate set; no table is read in full.
      expect(details.filter(detail => /^SCAN /.test(detail) && detail !== "SCAN c")).toEqual([]);
      // The plan describes the same query that returns the right rows.
      expect(await attachments(other.id)).toMatchObject([[{ id: target.id, name: "linked.txt" }], ]);
    });
  }

});
