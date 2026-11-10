import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { threadReadStatesQuery, type ThreadReadState } from "../../src/db/repos/threadReads.js";
import { valueList, type SqlExecutor } from "../../src/db/sql.js";
import type { ThreadRow } from "../../src/db/types.js";
import { asRecord } from "../../src/util/records.js";

/**
 * The read-state query as it behaved before it was restricted to the unacknowledged range. It materialized every
 * visible message. It is kept here only as an oracle: the optimized query must return exactly its states.
 */
async function legacyStates(db: SqlExecutor, userId: number, threadIds: string[]): Promise<Map<string, ThreadReadState>> {
  const whitespace = " \t\n\r\v\f";
  const text = db.dialect === "sqlite" ? sql`trim(m.text_plain, ${whitespace})` : sql`btrim(m.text_plain, ${whitespace})`;
  const rows = await db.query<{
    id: string; origin: "web" | "telegram"; readMessageId: number | null; lastMessageId: number | null; unread: number;
    pendingId: number | null; priorMessageId: number | null; turnId: number | null; lease: number | null;
    content: string | null; hasText: number | null; hasFiles: number | null;
  }>(sql`
    with recursive visible_threads(root_id, source_id, max_message_id, depth) as (
      select id, id, cast(null as bigint), 0 from threads
      where user_id = ${userId} and id in (${valueList(threadIds)})
      union all
      select v.root_id, parent.id,
        case when v.max_message_id is null or child.fork_point_message_id < v.max_message_id
          then child.fork_point_message_id else v.max_message_id end, v.depth + 1
      from visible_threads v join threads child on child.id = v.source_id
      join threads parent on parent.id = child.parent_thread_id and parent.user_id = ${userId}
      where child.fork_point_message_id is not null and v.depth < 999
    ), visible_messages as (
      select v.root_id, m.id, m.role, r.id as turn_id, r.lease_expires_at as lease,
        case when r.id is not null then m.content_json end as content,
        case when ${text} <> '' then 1 else 0 end as has_text,
        case when exists (select 1 from files f where f.message_id = m.id) or exists (
          select 1 from message_files mf join files f on f.id = mf.file_id where mf.message_id = m.id
        ) then 1 else 0 end as has_files
      from visible_threads v join messages m on m.thread_id = v.source_id
      left join turn_runs r on r.thread_id = m.thread_id and r.user_id = ${userId}
        and r.status in ('running', 'awaiting_delivery') and m.role = 'assistant'
        and m.id > r.user_message_id and m.content_json like ${'%"attachmentDeliveryTurnId"%'}
      where v.max_message_id is null or m.id <= v.max_message_id
    ), summaries as (
      select t.id, t.origin, r.message_id as read_message_id, max(m.id) as last_message_id,
        max(case when m.role = 'assistant' and m.turn_id is null
          and m.id > coalesce(r.message_id, 0) and (m.has_text = 1 or m.has_files = 1)
          then 1 else 0 end) as unread
      from threads t left join thread_reads r on r.thread_id = t.id and r.user_id = ${userId}
      left join visible_messages m on m.root_id = t.id
      where t.user_id = ${userId} and t.id in (${valueList(threadIds)})
      group by t.id, t.origin, r.message_id
    )
    select s.id, s.origin, s.read_message_id as "readMessageId", s.last_message_id as "lastMessageId", s.unread,
      p.id as "pendingId", p.turn_id as "turnId", p.lease, p.content,
      p.has_text as "hasText", p.has_files as "hasFiles",
      (select max(previous.id) from visible_messages previous
        where previous.root_id = s.id and previous.id < p.id) as "priorMessageId"
    from summaries s left join visible_messages p on p.root_id = s.id and p.turn_id is not null
  `);
  const result = new Map<string, ThreadReadState>();
  const now = Date.now();
  for (const row of rows) {
    const state = result.get(row.id) ?? {
      readMessageId: row.readMessageId, lastMessageId: row.lastMessageId, unread: Boolean(row.unread),
    };
    let pending = false;
    if (row.content !== null) {
      try { pending = asRecord(JSON.parse(row.content))?.attachmentDeliveryTurnId === row.turnId; }
      catch { /* Malformed historical metadata does not hide saved content. */ }
    }
    if (pending) {
      const limit = row.priorMessageId ?? 0;
      state.lastMessageId = Math.min(state.lastMessageId ?? 0, limit) || null;
    }
    if (row.pendingId !== null && row.pendingId > (state.readMessageId ?? 0)) {
      const hidden = pending && row.lease !== null && row.lease > now;
      state.unread ||= Boolean(row.hasText || (!hidden && row.hasFiles));
    }
    if (row.origin !== "web") state.unread = false;
    result.set(row.id, state);
  }
  return result;
}

for (const dialect of ["sqlite", "postgres"] as const) {
describe.skipIf(dialect === "postgres" && !process.env.TEST_POSTGRES_URL)(`${dialect} read-state query semantics`, () => {
  let db: AppDatabase;
  let repos: Repos;
  let admin: AppDatabase | undefined;
  let schema: string;
  beforeEach(async () => {
    schema = `thread_read_query_${randomUUID().replaceAll("-", "")}`;
    admin = dialect === "postgres" ? createDatabase(loadTestConfig({ DB_URL: process.env.TEST_POSTGRES_URL! })) : undefined;
    const url = admin ? new URL(process.env.TEST_POSTGRES_URL!) : undefined;
    if (admin && url) {
      await admin.db.execute(sql.raw(`create schema ${schema}`));
      url.searchParams.set("options", `-c search_path=${schema}`);
    }
    db = createDatabase(loadTestConfig({ DB_URL: url?.toString() ?? "sqlite::memory:" }));
    await db.initialize();
    repos = createRepos(db.db, db.search);
    await repos.users.ensure({ tgId: 42 });
    await repos.users.ensure({ tgId: 84 });
  });
  afterEach(async () => {
    await db?.destroy();
    if (admin) {
      await admin.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await admin.destroy();
    }
  });

  let topic = 0;
  const thread = (parent?: ThreadRow, forkPoint?: number, userId = 42) => repos.threads.create({
    origin: "web", userId, title: `Thread ${++topic}`, topicId: ++topic,
    ...(parent ? { parentThreadId: parent.id, forkPointMessageId: forkPoint } : {}),
  });
  const assistant = (threadId: string, text: string, content: object = { text }) =>
    repos.messages.insert({ threadId, role: "assistant", textPlain: text, content });
  const read = (threadId: string, messageId: number | null) => messageId === null ? Promise.resolve() : db.db.execute(sql`
    insert into thread_reads(user_id, thread_id, message_id) values (42, ${threadId}, ${messageId})
    on conflict(user_id, thread_id) do update set message_id = excluded.message_id`);
  const states = async (...ids: string[]) => repos.threadReads.states(42, ids);
  /** The optimized states must always equal what the full-history query reported. */
  async function expectLegacyParity(...ids: string[]) {
    const actual = await states(...ids);
    expect(actual).toEqual(await legacyStates(db.db, 42, ids));
    return actual;
  }
  async function activeRun(threadId: string, lease = Date.now() + 60_000, status = "awaiting_delivery") {
    const accepted = await repos.turnRuns.accept({ userId: 42, threadId, chatId: 42, messageThreadId: null,
      locale: "en", kind: "text", textPlain: "Generate", content: {}, sources: [{ updateId: ++topic + 10_000, messageId: topic }] });
    await db.db.execute(sql`update turn_runs set status = ${status}, lease_expires_at = ${lease} where id = ${accepted.turnRun.id}`);
    return accepted;
  }

  it("reports a completely read long history as read, with its last message", async () => {
    const root = await thread();
    let last = 0;
    for (let index = 0; index < 150; index++) last = (await assistant(root.id, `Answer ${index}`)).id;
    expect(await expectLegacyParity(root.id)).toEqual(new Map([[root.id, { unread: true, lastMessageId: last, readMessageId: null }]]));
    await read(root.id, last);
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: false, lastMessageId: last, readMessageId: last });
    const next = await assistant(root.id, "Fresh answer");
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: true, lastMessageId: next.id, readMessageId: last });
  });

  it("applies each root's own cursor across nested forks with different cutoffs", async () => {
    const parent = await thread();
    const p1 = await assistant(parent.id, "Parent 1");
    const p2 = await assistant(parent.id, "Parent 2");
    const p3 = await assistant(parent.id, "Parent 3");
    const child = await thread(parent, p2.id);
    const c1 = await assistant(child.id, "Child 1");
    const grandchild = await thread(child, c1.id);
    const g1 = await assistant(grandchild.id, "Grandchild 1");
    const earlyFork = await thread(grandchild, g1.id);
    const sibling = await thread(parent, p1.id);
    await read(child.id, p2.id);
    await read(grandchild.id, p2.id);
    await read(earlyFork.id, g1.id);
    const all = await expectLegacyParity(parent.id, child.id, grandchild.id, earlyFork.id, sibling.id);
    expect(all.get(parent.id)).toEqual({ unread: true, lastMessageId: p3.id, readMessageId: null });
    // The cutoff drops Parent 3; Child 1 is unread past the cursor.
    expect(all.get(child.id)).toEqual({ unread: true, lastMessageId: c1.id, readMessageId: p2.id });
    // The grandchild sees up to its own message: Parent 2 is read, Grandchild 1 is not.
    expect(all.get(grandchild.id)).toEqual({ unread: true, lastMessageId: g1.id, readMessageId: p2.id });
    expect(all.get(earlyFork.id)).toEqual({ unread: false, lastMessageId: g1.id, readMessageId: g1.id });
    expect(all.get(sibling.id)).toEqual({ unread: true, lastMessageId: p1.id, readMessageId: null });
    // The same answer whether asked for together or alone.
    for (const id of [parent.id, child.id, grandchild.id, earlyFork.id, sibling.id]) expect((await expectLegacyParity(id)).get(id)).toEqual(all.get(id));
  });

  it("counts only assistant text or saved files past the cursor, including whitespace, user and system rows", async () => {
    const root = await thread();
    await repos.messages.insert({ threadId: root.id, role: "user", content: {}, textPlain: "User text" });
    await repos.messages.insert({ threadId: root.id, role: "system", content: {}, textPlain: "System text" });
    const blank = await assistant(root.id, " \t\r\n\u000b\f ");
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: false, lastMessageId: blank.id, readMessageId: null });
    const linked = await assistant(root.id, "");
    const other = await thread();
    const owned = await repos.files.insertFile({ userId: 42, threadId: other.id, type: "other", name: "a.zip", size: 1, isInline: false });
    await repos.files.attachToMessage(linked.id, owned.id);
    expect((await expectLegacyParity(root.id)).get(root.id)).toMatchObject({ unread: true, lastMessageId: linked.id });
    await read(root.id, linked.id);
    const direct = await assistant(root.id, "");
    expect((await expectLegacyParity(root.id)).get(root.id)).toMatchObject({ unread: false, lastMessageId: direct.id });
    await repos.files.insertFile({ userId: 42, threadId: root.id, messageId: direct.id, type: "image", name: "b.png", size: 1, isInline: false });
    expect((await expectLegacyParity(root.id)).get(root.id)).toMatchObject({ unread: true });
    const user = await repos.messages.insert({ threadId: root.id, role: "user", content: {}, textPlain: "Later user" });
    await read(root.id, direct.id);
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: false, lastMessageId: user.id, readMessageId: direct.id });
  });

  it("keeps the read fence at the preceding message for live, expired, multiple and mismatched pending deliveries", async () => {
    const root = await thread();
    const before = await assistant(root.id, "Before delivery");
    const run = await activeRun(root.id, Date.now() + 60_000);
    const first = await assistant(root.id, "", { attachmentDeliveryTurnId: run.turnRun.id });
    const between = await repos.messages.insert({ threadId: root.id, role: "user", content: {}, textPlain: "Between" });
    const second = await assistant(root.id, "Visible text", { attachmentDeliveryTurnId: run.turnRun.id });
    const mismatched = await assistant(root.id, "", { attachmentDeliveryTurnId: run.turnRun.id + 999 });
    const file = await repos.files.insertFile({ userId: 42, threadId: root.id, messageId: first.id, type: "other", name: "c.zip", size: 1, isInline: false });
    await repos.files.insertFile({ userId: 42, threadId: root.id, messageId: mismatched.id, type: "other", name: "d.zip", size: 1, isInline: false });
    void file; void between;
    // Live lease: the fence is the message before the first pending row; text of the second still counts as unread.
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: true, lastMessageId: run.userMessage.id, readMessageId: null });
    // Lease expiry reveals the files but does not move the fence.
    await db.db.execute(sql`update turn_runs set lease_expires_at = 0 where id = ${run.turnRun.id}`);
    const expired = (await expectLegacyParity(root.id)).get(root.id)!;
    expect(expired).toMatchObject({ unread: true, lastMessageId: run.userMessage.id });
    expect(run.userMessage.id).toBeGreaterThan(before.id);
    await read(root.id, run.userMessage.id);
    expect((await expectLegacyParity(root.id)).get(root.id)).toMatchObject({ unread: true, readMessageId: run.userMessage.id });
    // Terminal runs release the fence.
    await db.db.execute(sql`update turn_runs set status = 'succeeded' where id = ${run.turnRun.id}`);
    expect((await expectLegacyParity(root.id)).get(root.id)).toMatchObject({ unread: true, lastMessageId: mismatched.id });
    await read(root.id, mismatched.id);
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: false, lastMessageId: mismatched.id, readMessageId: mismatched.id });
    expect(second.id).toBeLessThan(mismatched.id);
  });

  it("treats malformed delivery metadata as visible content", async () => {
    const root = await thread();
    const run = await activeRun(root.id);
    const malformed = await assistant(root.id, "", { text: "" });
    await db.db.execute(sql`update messages set content_json = '{"attachmentDeliveryTurnId": ' where id = ${malformed.id}`);
    const textual = await assistant(root.id, "", { attachmentDeliveryTurnId: String(run.turnRun.id) });
    await repos.files.insertFile({ userId: 42, threadId: root.id, messageId: textual.id, type: "other", name: "e.zip", size: 1, isInline: false });
    await expectLegacyParity(root.id);
    expect((await states(root.id)).get(root.id)).toMatchObject({ unread: true });
  });

  it("fences pending deliveries inherited through a fork, and only up to its cutoff", async () => {
    const parent = await thread();
    const base = await assistant(parent.id, "Base");
    const run = await activeRun(parent.id);
    const pending = await assistant(parent.id, "", { attachmentDeliveryTurnId: run.turnRun.id });
    await repos.files.insertFile({ userId: 42, threadId: parent.id, messageId: pending.id, type: "other", name: "f.zip", size: 1, isInline: false });
    const child = await thread(parent, pending.id);
    const early = await thread(parent, base.id);
    const own = await assistant(child.id, "Child answer");
    const result = await expectLegacyParity(parent.id, child.id, early.id);
    expect(result.get(early.id)).toMatchObject({ lastMessageId: base.id });
    expect(result.get(child.id)).toMatchObject({ unread: true });
    expect(own.id).toBeGreaterThan(pending.id);
  });

  it("keeps telegram-origin chats read and ignores other users' threads, over several roots at once", async () => {
    const web = await thread();
    const telegram = await thread();
    await db.db.execute(sql`update threads set origin = 'telegram' where id = ${telegram.id}`);
    const foreign = await thread(undefined, undefined, 84);
    const a = await assistant(web.id, "Web answer");
    await assistant(telegram.id, "Telegram answer");
    await assistant(foreign.id, "Foreign answer");
    const result = await expectLegacyParity(web.id, telegram.id, foreign.id);
    expect(result.get(web.id)).toEqual({ unread: true, lastMessageId: a.id, readMessageId: null });
    expect(result.get(telegram.id)?.unread).toBe(false);
    expect(result.has(foreign.id)).toBe(false);
    expect((await states())).toEqual(new Map());
  });

  it.skipIf(dialect !== "sqlite")("never reads acknowledged history: unread and pending work start at the cursor", async () => {
    const root = await thread();
    const child = await thread(root, undefined);
    // A long, fully acknowledged history of replies with text and attachments.
    await db.db.execute(sql`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 5000)
      insert into messages(thread_id, role, kind, content_json, text_plain, created_at)
      select ${root.id}, case when i % 3 = 0 then 'user' else 'assistant' end, 'text', '{}', 'Reply ' || i, i from n`);
    const last = Number((await db.db.query<{ id: number }>(sql`select max(id) as id from messages`))[0]!.id);
    await read(root.id, last);
    const plan = (await db.db.query<{ detail: string }>(sql`explain query plan ${threadReadStatesQuery("sqlite", 42, [root.id, child.id])}`))
      .map(row => row.detail);
    // Only the small ancestry relation is scanned; every table is reached through an index.
    expect(plan.filter(detail => /^SCAN /.test(detail) && !/^SCAN (v|visible_threads)$/.test(detail))).toEqual([]);
    // Unread and pending candidates are index ranges bounded below by the saved cursor (or the active turn) and above
    // by the fork cutoff, so acknowledged text and file predicates are never evaluated.
    const ranges = plan.filter(detail => /^SEARCH m USING INDEX messages_thread_id_idx \(thread_id=\? AND id>\? AND id<\?\)$/.test(detail));
    expect(ranges).toHaveLength(2);
    // The newest visible message is a single bounded maximum per thread, not an aggregate over messages.
    expect(plan.filter(detail => /^SEARCH (m|x) USING COVERING INDEX messages_thread_id_idx \(thread_id=\? AND id<\?\)$/.test(detail)).length).toBeGreaterThanOrEqual(2);
    expect(plan.some(detail => /\bm\b.*messages_thread_id_idx \(thread_id=\?\)$/.test(detail))).toBe(false);

    // The bound moves with the cursor: new replies and pending deliveries past it still count.
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: false, lastMessageId: last, readMessageId: last });
    const run = await activeRun(root.id);
    const pending = await assistant(root.id, "", { attachmentDeliveryTurnId: run.turnRun.id });
    await repos.files.insertFile({ userId: 42, threadId: root.id, messageId: pending.id, type: "other", name: "g.zip", size: 1, isInline: false });
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: false, lastMessageId: run.userMessage.id, readMessageId: last });
    await db.db.execute(sql`update turn_runs set status = 'succeeded' where id = ${run.turnRun.id}`);
    expect((await expectLegacyParity(root.id)).get(root.id)).toEqual({ unread: true, lastMessageId: pending.id, readMessageId: last });
  });

  it("matches the full-history query across generated histories, forks, deliveries and cursors", async () => {
    // Deterministic pseudo-random scenarios keep failures reproducible.
    let seed = 20_261_110;
    const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)]!;
    for (let scenario = 0; scenario < 12; scenario++) {
      const threads: ThreadRow[] = [await thread()];
      const messageIds = new Map<string, number[]>([[threads[0]!.id, []]]);
      const runs: Array<{ id: number; thread: ThreadRow }> = [];
      const steps = 25 + Math.floor(random() * 25);
      for (let step = 0; step < steps; step++) {
        const target = pick(threads);
        const roll = random();
        if (roll < 0.12 && threads.length < 6) {
          const visible = messageIds.get(target.id)!;
          if (visible.length) {
            const child = await thread(target, pick(visible));
            threads.push(child);
            messageIds.set(child.id, []);
          }
        } else if (roll < 0.2 && !runs.some(run => run.thread.id === target.id)) {
          const run = await activeRun(target.id, pick([Date.now() + 60_000, 0]), pick(["running", "awaiting_delivery"]));
          runs.push({ id: run.turnRun.id, thread: target });
          messageIds.get(target.id)!.push(run.userMessage.id);
        } else {
          const kind = pick(["text", "blank", "empty", "user", "system", "pending", "pending", "mismatched", "malformed"]);
          const active = runs.find(run => run.thread.id === target.id);
          const row = await repos.messages.insert({
            threadId: target.id, role: kind === "user" ? "user" : kind === "system" ? "system" : "assistant",
            textPlain: kind === "blank" ? " \n\t" : kind === "empty" || kind === "pending" || kind === "mismatched" ? "" : `Message ${step}`,
            content: kind === "pending" && active ? { attachmentDeliveryTurnId: active.id }
              : kind === "mismatched" ? { attachmentDeliveryTurnId: 1_000_000 + step } : {},
          });
          messageIds.get(target.id)!.push(row.id);
          if (kind === "malformed") await db.db.execute(sql`update messages set content_json = '{"attachmentDeliveryTurnId":' where id = ${row.id}`);
          if (random() < 0.3 && kind !== "user" && kind !== "system") {
            const file = await repos.files.insertFile({ userId: 42, threadId: target.id, messageId: random() < 0.5 ? row.id : null,
              type: "other", name: `file-${step}.bin`, size: 1, isInline: false });
            await repos.files.attachToMessage(row.id, file.id);
          }
        }
        if (random() < 0.25) {
          const own = messageIds.get(target.id)!;
          if (own.length) await read(target.id, pick(own));
        }
      }
      const ids = threads.map(candidate => candidate.id);
      const together = await states(...ids);
      expect(together, `scenario ${scenario}`).toEqual(await legacyStates(db.db, 42, ids));
      for (const id of ids) expect((await states(id)).get(id), `scenario ${scenario} alone`).toEqual((await legacyStates(db.db, 42, [id])).get(id));
    }
  });
});
}
