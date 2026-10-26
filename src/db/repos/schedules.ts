import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ScheduleError, ScheduleInputSchema, SchedulePatchSchema, MIN_SCHEDULE_INTERVAL_MS,
  type ChatSchedule, type ChatScheduleInput, type ChatSchedulePatch } from "../../scheduling/types.js";
import { createTextSearch } from "../search.js";
import { insertReturning, queryOne, type SqlExecutor } from "../sql.js";
import { lockThreadTransaction } from "../threadLock.js";
import { ThreadsRepo } from "./threads.js";
import { TurnRunsRepo } from "./turnRuns.js";
import { UsersRepo } from "./users.js";

interface ScheduleRow {
  id: string; user_id: number; thread_id: string; title: string; prompt: string;
  interval_minutes: number | null; next_run_at: number; enabled: number;
  last_run_at: number | null; last_turn_id: number | null; created_at: number; updated_at: number;
}

export class SchedulesRepo {
  constructor(private readonly db: SqlExecutor) {}

  async list(userId: number): Promise<ChatSchedule[]> {
    return (await this.db.query<ScheduleRow>(sql`
      select s.* from chat_schedules s join threads t on t.id = s.thread_id
      where s.user_id = ${userId} and t.user_id = ${userId} order by s.created_at desc, s.id
    `)).map(view);
  }

  async create(userId: number, raw: ChatScheduleInput, now = Date.now()): Promise<ChatSchedule> {
    const input = ScheduleInputSchema.parse(raw);
    future(input.nextRunAt, now);
    return this.db.transaction(async tx => {
      await lockThreadTransaction(tx, input.threadId);
      await requireThread(tx, userId, input.threadId);
      if (await queryOne(tx, sql`select id from chat_schedules where thread_id = ${input.threadId}`)) {
        throw new ScheduleError(409, "This chat already has a schedule. Edit it instead.");
      }
      return view(await insertReturning<ScheduleRow>(tx, sql`
        insert into chat_schedules(id, user_id, thread_id, title, prompt, interval_minutes, next_run_at, enabled, created_at, updated_at)
        values (${randomUUID()}, ${userId}, ${input.threadId}, ${input.title}, ${input.prompt}, ${input.intervalMinutes},
          ${input.nextRunAt}, 1, ${now}, ${now}) returning *
      `));
    });
  }

  async update(userId: number, id: string, raw: ChatSchedulePatch, now = Date.now()): Promise<ChatSchedule> {
    const input = SchedulePatchSchema.parse(raw);
    return this.withOwned(userId, id, async (tx, row) => {
      const nextRunAt = input.nextRunAt ?? row.next_run_at;
      if (input.nextRunAt !== undefined || input.enabled === true) future(nextRunAt, now);
      if (input.enabled !== false) await requireThread(tx, userId, row.thread_id);
      return view(await insertReturning<ScheduleRow>(tx, sql`
        update chat_schedules set title = ${input.title ?? row.title}, prompt = ${input.prompt ?? row.prompt},
          interval_minutes = ${input.intervalMinutes === undefined ? row.interval_minutes : input.intervalMinutes},
          next_run_at = ${nextRunAt}, enabled = ${input.enabled === undefined ? row.enabled : Number(input.enabled)},
          updated_at = ${now} where id = ${id} and user_id = ${userId} returning *
      `));
    });
  }

  async delete(userId: number, id: string): Promise<void> {
    await this.withOwned(userId, id, async tx => { await tx.execute(sql`delete from chat_schedules where id = ${id} and user_id = ${userId}`); });
  }

  private async withOwned<T>(userId: number, id: string, action: (tx: SqlExecutor, row: ScheduleRow) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      const candidate = await queryOne<ScheduleRow>(tx, sql`select * from chat_schedules where id = ${id} and user_id = ${userId}`);
      if (!candidate) throw new ScheduleError(404, "Schedule not found.");
      await lockThreadTransaction(tx, candidate.thread_id);
      const row = await queryOne<ScheduleRow>(tx, sql`select * from chat_schedules where id = ${id} and user_id = ${userId}`);
      if (!row) throw new ScheduleError(404, "Schedule not found.");
      return action(tx, row);
    });
  }

  due(now: number): Promise<{ id: string; user_id: number }[]> {
    return this.db.query(sql`select s.id, s.user_id from chat_schedules s join threads t on t.id = s.thread_id
      where s.enabled = 1 and s.next_run_at <= ${now} and t.archived = 0
      and not exists (select 1 from turn_runs r where r.thread_id = s.thread_id
        and (r.status in ('queued', 'running', 'awaiting_delivery')
          or (r.schedule_id is not null and coalesce(r.started_at, r.accepted_at) > ${now - MIN_SCHEDULE_INTERVAL_MS})))
      order by s.next_run_at, s.id limit 100`);
  }

  /** The durable turn and schedule advance commit together, before a worker is woken. */
  async enqueue(userId: number, id: string, now = Date.now()): Promise<{ threadId: string; turnId: number } | null> {
    try {
      return await this.withOwned(userId, id, async (tx, row) => {
        if (!row.enabled || row.next_run_at > now) return null;
        const thread = await new ThreadsRepo(tx).get(row.thread_id);
        const user = await new UsersRepo(tx).get(userId);
        if (!thread || thread.user_id !== userId || thread.archived || !user) return null;
        const busy = await queryOne(tx, sql`select id from turn_runs where thread_id = ${thread.id}
          and (status in ('queued', 'running', 'awaiting_delivery')
            or (schedule_id is not null and coalesce(started_at, accepted_at) > ${now - MIN_SCHEDULE_INTERVAL_MS})) limit 1`);
        if (busy) return null;
        const text = `[Scheduled check: ${row.title}]\nRun the following saved task now. This is an existing schedule occurrence; do not create or change schedules unless the saved task explicitly requests it.\n\n${row.prompt}`;
        const turns = new TurnRunsRepo(tx, createTextSearch(tx, tx.dialect));
        const accepted = await turns.accept({
          userId, threadId: thread.id, chatId: userId, messageThreadId: thread.topic_id, locale: user.lang,
          kind: "text", textPlain: text, content: { text, scheduledTaskId: id, scheduledFor: row.next_run_at },
          sources: [], webRequestId: `schedule_${id}_${row.next_run_at}`,
          scheduled: { id, origin: thread.origin },
        });
        const interval = row.interval_minutes === null ? null : row.interval_minutes * 60_000;
        const next = interval === null ? row.next_run_at : Math.max(now + MIN_SCHEDULE_INTERVAL_MS,
          row.next_run_at + (Math.floor((now - row.next_run_at) / interval) + 1) * interval);
        await tx.execute(sql`update chat_schedules set enabled = ${interval === null ? 0 : 1}, next_run_at = ${next},
          last_run_at = ${now}, last_turn_id = ${accepted.turnRun.id}, updated_at = ${now} where id = ${id}`);
        return { threadId: thread.id, turnId: accepted.turnRun.id };
      });
    } catch (error) {
      if (error instanceof ScheduleError && error.status === 404) return null;
      throw error;
    }
  }
}

function future(time: number, now: number) {
  if (time <= now) throw new ScheduleError(400, "Choose a future time for the next run.");
}
async function requireThread(tx: SqlExecutor, userId: number, id: string) {
  const thread = await new ThreadsRepo(tx).get(id);
  if (!thread || thread.user_id !== userId) throw new ScheduleError(404, "Conversation not found.");
  if (thread.archived) throw new ScheduleError(409, "Fork this archived conversation to schedule it.");
}
function view(row: ScheduleRow): ChatSchedule {
  return { id: row.id, threadId: row.thread_id, title: row.title, prompt: row.prompt, intervalMinutes: row.interval_minutes,
    nextRunAt: row.next_run_at, enabled: Boolean(row.enabled), lastRunAt: row.last_run_at, lastTurnId: row.last_turn_id,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
