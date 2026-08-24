import { sql } from "drizzle-orm";
import type { TextSearch } from "../search.js";
import { insertReturning, queryOne, valueList, type SqlExecutor } from "../sql.js";
import type {
  Locale,
  MessageKind,
  MessageRow,
  TurnDeliveryStatus,
  TurnRunRow,
  TurnRunStatus,
} from "../types.js";

export interface TelegramTurnSource {
  updateId: number;
  messageId: number | null;
}

export interface AcceptedTurnRun {
  turnRun: TurnRunRow;
  userMessage: MessageRow;
  created: boolean;
  queuedBehind: boolean;
}

export class TurnRunsRepo {
  constructor(
    private readonly db: SqlExecutor,
    private readonly search: TextSearch,
  ) {}

  async accept(input: {
    userId: number;
    threadId: number;
    chatId: number;
    messageThreadId: number | null;
    locale: Locale;
    kind: MessageKind;
    content: unknown;
    textPlain: string;
    sources: TelegramTurnSource[];
  }): Promise<AcceptedTurnRun> {
    const sources = uniqueSources(input.sources);
    if (!sources.length) throw new Error("A durable turn requires at least one Telegram update source.");
    let accepted: AcceptedTurnRun;
    try {
      accepted = await this.db.transaction(async (tx) => {
        const duplicate = await existingForSources(tx, sources.map((source) => source.updateId));
        if (duplicate) {
          const userMessage = await queryOne<MessageRow>(tx, sql`select * from messages where id = ${duplicate.user_message_id}`);
          if (!userMessage) throw new Error(`Turn #${duplicate.id} references a missing user message.`);
          return { turnRun: duplicate, userMessage, created: false, queuedBehind: false };
        }

        const now = Date.now();
        const userMessage = await insertReturning<MessageRow>(tx, sql`
          insert into messages(thread_id, role, kind, content_json, text_plain, thinking, tg_message_id, pi_entry_id, created_at)
          values (${input.threadId}, 'user', ${input.kind}, ${JSON.stringify(input.content)}, ${input.textPlain}, null, null, null, ${now})
          returning *
        `);
        const turnRun = await insertReturning<TurnRunRow>(tx, sql`
          insert into turn_runs(
            user_id, thread_id, user_message_id, chat_id, message_thread_id, locale,
            status, delivery_status, accepted_at, updated_at
          ) values (
            ${input.userId}, ${input.threadId}, ${userMessage.id}, ${input.chatId}, ${input.messageThreadId}, ${input.locale},
            'queued', 'pending', ${now}, ${now}
          ) returning *
        `);
        for (const source of sources) {
          await tx.execute(sql`
            insert into turn_run_sources(turn_run_id, telegram_update_id, telegram_message_id, created_at)
            values (${turnRun.id}, ${source.updateId}, ${source.messageId}, ${now})
          `);
        }
        const earlier = await queryOne<{ present: number }>(tx, sql`
          select 1 as present from turn_runs
          where thread_id = ${input.threadId}
            and id < ${turnRun.id}
            and status in ('queued', 'running', 'awaiting_delivery')
          limit 1
        `);
        return { turnRun, userMessage, created: true, queuedBehind: Boolean(earlier) };
      });
    } catch (error) {
      // A concurrent PostgreSQL transaction can win the unique update-id race
      // after our initial read. Resolve that durable winner instead of surfacing
      // an error that would invite Telegram to retry the update.
      const duplicate = await existingForSources(this.db, sources.map((source) => source.updateId));
      if (!duplicate) throw error;
      const userMessage = await queryOne<MessageRow>(this.db, sql`select * from messages where id = ${duplicate.user_message_id}`);
      if (!userMessage) throw error;
      accepted = { turnRun: duplicate, userMessage, created: false, queuedBehind: false };
    }
    if (accepted.created) {
      await this.search.indexMessage(
        accepted.userMessage.id,
        accepted.userMessage.thread_id,
        accepted.userMessage.text_plain,
      ).catch(() => undefined);
    }
    return accepted;
  }

  get(id: number): Promise<TurnRunRow | undefined> {
    return queryOne<TurnRunRow>(this.db, sql`select * from turn_runs where id = ${id}`);
  }

  listForThread(threadId: number): Promise<TurnRunRow[]> {
    return this.db.query<TurnRunRow>(sql`select * from turn_runs where thread_id = ${threadId} order by id asc`);
  }

  nextQueued(threadId: number): Promise<TurnRunRow | undefined> {
    return queryOne<TurnRunRow>(this.db, sql`
      select * from turn_runs where thread_id = ${threadId} and status = 'queued' order by id asc limit 1
    `);
  }

  async queuedThreadIds(): Promise<number[]> {
    const rows = await this.db.query<{ thread_id: number }>(sql`
      select distinct thread_id from turn_runs where status = 'queued' order by thread_id asc
    `);
    return rows.map((row) => row.thread_id);
  }

  claimRunning(id: number): Promise<TurnRunRow | undefined> {
    const now = Date.now();
    return queryOne<TurnRunRow>(this.db, sql`
      update turn_runs set status = 'running', started_at = ${now}, updated_at = ${now}
      where id = ${id} and status = 'queued'
      returning *
    `);
  }

  async interruptStaleRunning(): Promise<number> {
    const now = Date.now();
    const rows = await this.db.query<{ id: number }>(sql`
      update turn_runs
      set status = 'interrupted', failure_code = 'process_interrupted', finished_at = ${now}, updated_at = ${now}
      where status in ('running', 'awaiting_delivery')
      returning id
    `);
    return rows.length;
  }

  markAwaitingDelivery(id: number, input: {
    resultMessageId?: number | null;
    provider?: string | null;
    model?: string | null;
    usage?: unknown;
  } = {}): Promise<void> {
    return this.updateLifecycle(id, "awaiting_delivery", {
      deliveryStatus: "pending",
      resultMessageId: input.resultMessageId,
      provider: input.provider,
      model: input.model,
      usage: input.usage,
    });
  }

  markSucceeded(id: number, resultMessageId?: number | null): Promise<void> {
    return this.updateLifecycle(id, "succeeded", {
      deliveryStatus: "delivered",
      resultMessageId,
      finished: true,
    });
  }

  markFailed(id: number, failureCode: string, deliveryStatus: TurnDeliveryStatus = "failed"): Promise<void> {
    return this.updateLifecycle(id, "failed", { deliveryStatus, failureCode, finished: true });
  }

  markCancelled(id: number): Promise<void> {
    return this.updateLifecycle(id, "cancelled", { failureCode: "user_cancelled", finished: true });
  }

  private async updateLifecycle(id: number, status: TurnRunStatus, input: {
    deliveryStatus?: TurnDeliveryStatus;
    resultMessageId?: number | null;
    provider?: string | null;
    model?: string | null;
    usage?: unknown;
    failureCode?: string | null;
    finished?: boolean;
  }): Promise<void> {
    const now = Date.now();
    await this.db.execute(sql`
      update turn_runs set
        status = ${status},
        delivery_status = coalesce(${input.deliveryStatus ?? null}, delivery_status),
        result_message_id = coalesce(${input.resultMessageId ?? null}, result_message_id),
        provider = coalesce(${input.provider ?? null}, provider),
        model = coalesce(${input.model ?? null}, model),
        usage_json = coalesce(${input.usage === undefined ? null : JSON.stringify(input.usage)}, usage_json),
        failure_code = ${input.failureCode ?? null},
        finished_at = ${input.finished ? now : null},
        updated_at = ${now}
      where id = ${id}
    `);
  }
}

async function existingForSources(db: SqlExecutor, updateIds: number[]): Promise<TurnRunRow | undefined> {
  if (!updateIds.length) return undefined;
  return queryOne<TurnRunRow>(db, sql`
    select tr.* from turn_run_sources trs
    join turn_runs tr on tr.id = trs.turn_run_id
    where trs.telegram_update_id in (${valueList(updateIds)})
    order by tr.id asc limit 1
  `);
}

function uniqueSources(sources: TelegramTurnSource[]): TelegramTurnSource[] {
  const byId = new Map<number, TelegramTurnSource>();
  for (const source of sources) {
    if (!Number.isSafeInteger(source.updateId) || source.updateId < 0) continue;
    byId.set(source.updateId, source);
  }
  return [...byId.values()];
}
