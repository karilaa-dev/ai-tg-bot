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
  payload?: {
    kind: MessageKind;
    content: unknown;
    textPlain: string;
  };
}

export interface DurableTurnAttachment {
  fileId: number;
  displayName?: string | null;
  caption?: string | null;
  telegramMessageId?: number | null;
}

export interface AcceptedTurnRun {
  turnRun: TurnRunRow;
  userMessage: MessageRow;
  created: boolean;
  queuedBehind: boolean;
}

interface TurnAcceptanceInput {
  userId: number;
  threadId: number;
  chatId: number;
  messageThreadId: number | null;
  locale: Locale;
  kind: MessageKind;
  content: unknown;
  textPlain: string;
  sources: TelegramTurnSource[];
  attachments?: DurableTurnAttachment[];
}

export class TurnRunsRepo {
  constructor(
    private readonly db: SqlExecutor,
    private readonly search: TextSearch,
  ) {}

  async hasTelegramUpdate(updateId: number): Promise<boolean> {
    return Boolean(await queryOne(this.db, sql`
      select 1 from turn_run_sources where telegram_update_id = ${updateId} limit 1
    `));
  }

  async telegramMessageIds(id: number): Promise<number[]> {
    const rows = await this.db.query<{ telegram_message_id: number }>(sql`
      select distinct telegram_message_id from turn_run_sources
      where turn_run_id = ${id} and telegram_message_id is not null
    `);
    return rows.map((row) => row.telegram_message_id);
  }

  async accept(input: TurnAcceptanceInput): Promise<AcceptedTurnRun> {
    const sources = uniqueSources(input.sources);
    const attachments = uniqueAttachments(input.attachments ?? []);
    if (!sources.length) throw new Error("A durable turn requires at least one Telegram update source.");
    const observedOwnedUpdateIds = new Set<number>();
    let accepted: AcceptedTurnRun;
    try {
      accepted = await this.db.transaction(async (tx) => {
        await lockThreadTransaction(tx, input.threadId);
        const mappings = await existingSourceMappings(tx, sources.map((source) => source.updateId));
        for (const mapping of mappings) observedOwnedUpdateIds.add(mapping.telegram_update_id);
        const ownedUpdateIds = new Set(mappings.map((mapping) => mapping.telegram_update_id));
        const acceptedSources = sources.filter((source) => !ownedUpdateIds.has(source.updateId));
        if (!acceptedSources.length) {
          const duplicate = await existingTurnForMappings(tx, mappings);
          if (!duplicate) throw new Error("Duplicate Telegram sources have no owning turn.");
          const userMessage = await queryOne<MessageRow>(tx, sql`select * from messages where id = ${duplicate.user_message_id}`);
          if (!userMessage) throw new Error(`Turn #${duplicate.id} references a missing user message.`);
          const duplicateSources = sources.filter((source) => mappings.some((mapping) =>
            mapping.turn_run_id === duplicate.id && mapping.telegram_update_id === source.updateId));
          await attachFilesToAcceptedMessage(
            tx,
            userMessage.id,
            attachmentsForSources(attachments, duplicateSources),
          );
          return { turnRun: duplicate, userMessage, created: false, queuedBehind: false };
        }

        const acceptedPayload = turnPayloadForSources(input, acceptedSources);
        const now = Date.now();
        const userMessage = await insertReturning<MessageRow>(tx, sql`
          insert into messages(thread_id, role, kind, content_json, text_plain, thinking, tg_message_id, pi_entry_id, created_at)
          values (
            ${input.threadId}, 'user', ${acceptedPayload.kind}, ${JSON.stringify(acceptedPayload.content)},
            ${acceptedPayload.textPlain}, null, null, null, ${now}
          )
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
        await tx.execute(sql`insert into turn_activity_sync(turn_run_id) values (${turnRun.id})`);
        await attachFilesToAcceptedMessage(
          tx,
          userMessage.id,
          attachmentsForSources(attachments, acceptedSources),
        );
        for (const source of acceptedSources) {
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
      const mappings = await existingSourceMappings(this.db, sources.map((source) => source.updateId));
      if (!mappings.some((mapping) => !observedOwnedUpdateIds.has(mapping.telegram_update_id))) throw error;
      const ownedUpdateIds = new Set(mappings.map((mapping) => mapping.telegram_update_id));
      const unownedSources = sources.filter((source) => !ownedUpdateIds.has(source.updateId));
      if (unownedSources.length) {
        return this.accept({
          ...input,
          ...turnPayloadForSources(input, unownedSources),
          sources: unownedSources,
        });
      }
      const duplicate = await existingTurnForMappings(this.db, mappings);
      if (!duplicate) throw error;
      const userMessage = await queryOne<MessageRow>(this.db, sql`select * from messages where id = ${duplicate.user_message_id}`);
      if (!userMessage) throw error;
      const duplicateSources = sources.filter((source) => mappings.some((mapping) =>
        mapping.turn_run_id === duplicate.id && mapping.telegram_update_id === source.updateId));
      const duplicateAttachments = attachmentsForSources(attachments, duplicateSources);
      if (duplicateAttachments.length) {
        await this.db.transaction((tx) =>
          attachFilesToAcceptedMessage(tx, userMessage.id, duplicateAttachments));
      }
      accepted = { turnRun: duplicate, userMessage, created: false, queuedBehind: false };
    }
    await this.indexMessageForRun(accepted.turnRun).catch(() => undefined);
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

  claimRunning(
    id: number,
    ownerId = "unowned",
    leaseExpiresAt = Date.now() + 60_000,
    legacyStaleBefore?: number,
  ): Promise<TurnRunRow | undefined> {
    return this.db.transaction(async (tx) => {
      const candidate = await queryOne<{ thread_id: number }>(tx, sql`
        select thread_id from turn_runs where id = ${id} and status = 'queued'
      `);
      if (!candidate) return undefined;
      await lockThreadTransaction(tx, candidate.thread_id);
      const now = Date.now();
      await tx.execute(sql`
        delete from thread_operation_barriers
        where thread_id = ${candidate.thread_id} and lease_expires_at <= ${now}
      `);
      await tx.execute(sql`
        update turn_runs
        set status = 'interrupted', failure_code = 'owner_lease_expired',
            owner_id = null, lease_expires_at = null,
            finished_at = ${now}, updated_at = ${now}
        where thread_id = ${candidate.thread_id}
          and status in ('running', 'awaiting_delivery')
          and (
            (owner_id is not null and lease_expires_at is not null and lease_expires_at <= ${now})
            or (${legacyStaleBefore === undefined ? 0 : 1} = 1 and owner_id is null and updated_at <= ${legacyStaleBefore ?? 0})
          )
      `);
      return queryOne<TurnRunRow>(tx, sql`
        update turn_runs as target
        set status = 'running', started_at = ${now}, updated_at = ${now},
            owner_id = ${ownerId}, lease_expires_at = ${leaseExpiresAt}
        where target.id = ${id}
          and target.status = 'queued'
          and not exists (
            select 1 from thread_operation_barriers barrier
            where barrier.thread_id = target.thread_id
              and barrier.lease_expires_at > ${now}
          )
          and not exists (
            select 1 from turn_runs blocker
            where blocker.thread_id = target.thread_id
              and blocker.id <> target.id
              and (
                blocker.status in ('running', 'awaiting_delivery')
                or (blocker.status = 'queued' and blocker.id < target.id)
              )
          )
        returning *
      `);
    });
  }

  async interruptStaleRunning(input: {
    now?: number;
    legacyStaleBefore?: number;
    threadId?: number;
  } = {}): Promise<number> {
    const now = input.now ?? Date.now();
    const legacyStaleBefore = input.legacyStaleBefore;
    const rows = await this.db.query<{ id: number }>(sql`
      update turn_runs
      set status = 'interrupted', failure_code = 'process_interrupted',
          owner_id = null, lease_expires_at = null,
          finished_at = ${now}, updated_at = ${now}
      where status in ('running', 'awaiting_delivery')
        and (${input.threadId === undefined ? 0 : 1} = 0 or thread_id = ${input.threadId ?? 0})
        and (
          (owner_id is not null and lease_expires_at is not null and lease_expires_at <= ${now})
          or (${legacyStaleBefore === undefined ? 0 : 1} = 1
            and owner_id is null and updated_at <= ${legacyStaleBefore ?? 0})
        )
      returning id
    `);
    return rows.length;
  }

  async renewLease(id: number, ownerId: string, leaseExpiresAt: number): Promise<boolean> {
    const now = Date.now();
    const renewed = await queryOne<{ id: number }>(this.db, sql`
      update turn_runs
      set lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
      where id = ${id}
        and owner_id = ${ownerId}
        and lease_expires_at > ${now}
        and status in ('running', 'awaiting_delivery')
      returning id
    `);
    return Boolean(renewed);
  }

  async hasUnfinished(threadId: number): Promise<boolean> {
    return Boolean(await queryOne<{ present: number }>(this.db, sql`
      select 1 as present from turn_runs
      where thread_id = ${threadId}
        and status in ('queued', 'running', 'awaiting_delivery')
      limit 1
    `));
  }

  async requestCancellation(
    threadId: number,
  ): Promise<Pick<TurnRunRow, "id" | "owner_id" | "status"> | undefined> {
    const now = Date.now();
    return this.db.transaction(async (tx) => {
      await lockThreadTransaction(tx, threadId);
      const running = await queryOne<Pick<TurnRunRow, "id" | "owner_id" | "status">>(tx, sql`
        update turn_runs
        set cancel_requested_at = coalesce(cancel_requested_at, ${now}), updated_at = ${now}
        where thread_id = ${threadId}
          and status = 'running'
        returning id, owner_id, status
      `);
      if (running) return running;
      const delivery = await queryOne<{ present: number }>(tx, sql`
        select 1 as present from turn_runs
        where thread_id = ${threadId} and status = 'awaiting_delivery'
        limit 1
      `);
      if (delivery) return undefined;
      return queryOne<Pick<TurnRunRow, "id" | "owner_id" | "status">>(tx, sql`
        update turn_runs
        set status = 'cancelled', cancel_requested_at = ${now}, failure_code = 'user_cancelled',
            finished_at = ${now}, updated_at = ${now}
        where id = (
          select id from turn_runs
          where thread_id = ${threadId} and status = 'queued'
          order by id asc limit 1
        )
        returning id, owner_id, status
      `);
    });
  }

  async cancellationRequested(id: number, ownerId: string): Promise<boolean> {
    return Boolean(await queryOne<{ present: number }>(this.db, sql`
      select 1 as present from turn_runs
      where id = ${id}
        and owner_id = ${ownerId}
        and status = 'running'
        and cancel_requested_at is not null
      limit 1
    `));
  }

  async tryAcquireThreadBarrier(input: {
    threadId: number;
    ownerId: string;
    operation: "fork" | "compact";
    leaseExpiresAt: number;
  }): Promise<{ snapshotMessageId: number | null } | undefined> {
    return this.db.transaction(async (tx) => {
      await lockThreadTransaction(tx, input.threadId);
      const now = Date.now();
      await tx.execute(sql`
        delete from thread_operation_barriers
        where thread_id = ${input.threadId} and lease_expires_at <= ${now}
      `);
      if (await queryOne<{ present: number }>(tx, sql`
        select 1 as present from turn_runs
        where thread_id = ${input.threadId}
          and status in ('queued', 'running', 'awaiting_delivery')
        limit 1
      `)) return undefined;
      const snapshot = await queryOne<{ id: number }>(tx, sql`
        select id from messages where thread_id = ${input.threadId} order by id desc limit 1
      `);
      const inserted = await queryOne<{ snapshot_message_id: number | null }>(tx, sql`
        insert into thread_operation_barriers(
          thread_id, owner_id, operation, snapshot_message_id,
          lease_expires_at, created_at, updated_at
        ) values (
          ${input.threadId}, ${input.ownerId}, ${input.operation}, ${snapshot?.id ?? null},
          ${input.leaseExpiresAt}, ${now}, ${now}
        )
        on conflict(thread_id) do nothing
        returning snapshot_message_id
      `);
      return inserted ? { snapshotMessageId: inserted.snapshot_message_id } : undefined;
    });
  }

  async releaseThreadBarrier(threadId: number, ownerId: string): Promise<boolean> {
    const released = await queryOne<{ thread_id: number }>(this.db, sql`
      delete from thread_operation_barriers
      where thread_id = ${threadId} and owner_id = ${ownerId}
      returning thread_id
    `);
    return Boolean(released);
  }

  async renewThreadBarrier(threadId: number, ownerId: string, leaseExpiresAt: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await lockThreadTransaction(tx, threadId);
      const now = Date.now();
      const renewed = await queryOne<{ thread_id: number }>(tx, sql`
        update thread_operation_barriers
        set lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
        where thread_id = ${threadId}
          and owner_id = ${ownerId}
          and lease_expires_at > ${now}
        returning thread_id
      `);
      return Boolean(renewed);
    });
  }

  async indexMessageForRun(run: Pick<TurnRunRow, "user_message_id">): Promise<void> {
    const message = await queryOne<MessageRow>(this.db, sql`
      select * from messages where id = ${run.user_message_id}
    `);
    if (!message) throw new Error(`Turn message #${run.user_message_id} is unavailable for indexing.`);
    await this.search.indexMessage(message.id, message.thread_id, message.text_plain);
  }

  async markAwaitingDelivery(id: number, input: {
    resultMessageId?: number | null;
    provider?: string | null;
    model?: string | null;
    usage?: unknown;
  } = {}, ownerId?: string): Promise<boolean> {
    const now = Date.now();
    const transitioned = await queryOne<{ id: number }>(this.db, sql`
      update turn_runs set
        status = 'awaiting_delivery',
        delivery_status = 'pending',
        result_message_id = coalesce(${input.resultMessageId ?? null}, result_message_id),
        provider = coalesce(${input.provider ?? null}, provider),
        model = coalesce(${input.model ?? null}, model),
        usage_json = coalesce(${input.usage === undefined ? null : JSON.stringify(input.usage)}, usage_json),
        failure_code = null,
        finished_at = null,
        updated_at = ${now}
      where id = ${id}
        and status = 'running'
        and cancel_requested_at is null
        and (
          ${ownerId === undefined ? 0 : 1} = 0
          or (owner_id = ${ownerId ?? ""} and lease_expires_at > ${now})
        )
      returning id
    `);
    return Boolean(transitioned);
  }

  markSucceeded(id: number, resultMessageId?: number | null, ownerId?: string): Promise<void> {
    return this.updateLifecycle(id, "succeeded", {
      deliveryStatus: "delivered",
      resultMessageId,
      finished: true,
    }, ownerId);
  }

  markFailed(
    id: number,
    failureCode: string,
    deliveryStatus: TurnDeliveryStatus = "failed",
    ownerId?: string,
  ): Promise<void> {
    return this.updateLifecycle(id, "failed", { deliveryStatus, failureCode, finished: true }, ownerId);
  }

  markCancelled(id: number, ownerId?: string): Promise<void> {
    return this.updateLifecycle(id, "cancelled", { failureCode: "user_cancelled", finished: true }, ownerId);
  }

  private async updateLifecycle(id: number, status: TurnRunStatus, input: {
    deliveryStatus?: TurnDeliveryStatus;
    resultMessageId?: number | null;
    provider?: string | null;
    model?: string | null;
    usage?: unknown;
    failureCode?: string | null;
    finished?: boolean;
  }, ownerId?: string): Promise<void> {
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
        and (
          ${ownerId === undefined ? 0 : 1} = 0
          or (owner_id = ${ownerId ?? ""} and lease_expires_at > ${now})
        )
    `);
  }
}

interface ExistingSourceMapping {
  telegram_update_id: number;
  turn_run_id: number;
}

function existingSourceMappings(db: SqlExecutor, updateIds: number[]): Promise<ExistingSourceMapping[]> {
  if (!updateIds.length) return Promise.resolve([]);
  return db.query<ExistingSourceMapping>(sql`
    select telegram_update_id, turn_run_id from turn_run_sources
    where telegram_update_id in (${valueList(updateIds)})
    order by telegram_update_id asc
  `);
}

function existingTurnForMappings(
  db: SqlExecutor,
  mappings: ExistingSourceMapping[],
): Promise<TurnRunRow | undefined> {
  const turnRunIds = [...new Set(mappings.map((mapping) => mapping.turn_run_id))];
  if (!turnRunIds.length) return Promise.resolve(undefined);
  return queryOne<TurnRunRow>(db, sql`
    select * from turn_runs where id in (${valueList(turnRunIds)}) order by id asc limit 1
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

function uniqueAttachments(attachments: DurableTurnAttachment[]): DurableTurnAttachment[] {
  const byId = new Map<number, DurableTurnAttachment>();
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.fileId) || attachment.fileId <= 0) continue;
    byId.set(attachment.fileId, attachment);
  }
  return [...byId.values()];
}

function attachmentsForSources(
  attachments: DurableTurnAttachment[],
  sources: TelegramTurnSource[],
): DurableTurnAttachment[] {
  const messageIds = new Set(sources.flatMap((source) => source.messageId === null ? [] : [source.messageId]));
  return attachments.filter((attachment) =>
    attachment.telegramMessageId === null
    || attachment.telegramMessageId === undefined
    || messageIds.has(attachment.telegramMessageId));
}

function turnPayloadForSources(
  fallback: Pick<TurnAcceptanceInput, "kind" | "content" | "textPlain">,
  sources: TelegramTurnSource[],
): Pick<TurnAcceptanceInput, "kind" | "content" | "textPlain"> {
  const payloads = sources.map((source) => source.payload);
  if (payloads.some((payload) => !payload)) return fallback;
  const complete = payloads.filter((payload): payload is NonNullable<TelegramTurnSource["payload"]> => Boolean(payload));
  // Preserve source text byte-for-byte when rebuilding an accepted subset.
  // Telegram split-text batching may contain meaningful leading newlines.
  const textPlain = complete.map((payload) => payload.textPlain).filter(Boolean).join("\n\n");
  const kind: MessageKind = complete.some((payload) => payload.kind === "file")
    ? "file"
    : complete.some((payload) => payload.kind === "image")
      ? "image"
      : "text";
  if (kind === "text") return { kind, content: { text: textPlain }, textPlain };

  const records = complete.flatMap((payload) =>
    payload.content && typeof payload.content === "object" && !Array.isArray(payload.content)
      ? [payload.content as Record<string, unknown>]
      : []);
  const captions = [...new Set(records.flatMap((record) =>
    Array.isArray(record.captions)
      ? record.captions.filter((caption): caption is string => typeof caption === "string" && Boolean(caption.trim()))
      : typeof record.caption === "string" && record.caption.trim() ? [record.caption] : []))];
  const files = records.flatMap((record) => Array.isArray(record.files) ? record.files : []);
  return {
    kind,
    textPlain,
    content: { text: textPlain, captions, files },
  };
}

async function attachFilesToAcceptedMessage(
  tx: SqlExecutor,
  messageId: number,
  attachments: DurableTurnAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    const file = await queryOne<{ id: number; name: string }>(tx, sql`
      update files
      set message_id = coalesce(message_id, ${messageId})
      where id = ${attachment.fileId}
      returning id, name
    `);
    if (!file) throw new Error(`File #${attachment.fileId} does not exist for the accepted turn.`);
    await tx.execute(sql`
      insert into message_files(message_id, file_id, display_name, caption, created_at)
      values (
        ${messageId}, ${file.id}, ${attachment.displayName ?? file.name},
        ${attachment.caption ?? null}, ${Date.now()}
      )
      on conflict(message_id, file_id) do update set
        display_name = excluded.display_name,
        caption = excluded.caption
    `);
  }
}

async function lockThreadTransaction(tx: SqlExecutor, threadId: number): Promise<void> {
  if (tx.dialect !== "postgres") return;
  // Acceptance, claims, and operation barriers share this transaction lock,
  // which gives each thread one cross-process linearization point.
  await tx.execute(sql`
    select pg_advisory_xact_lock(938472616, cast(mod(${threadId}, 2147483647) as integer))
  `);
}
