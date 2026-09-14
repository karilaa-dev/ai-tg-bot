import { sql } from "drizzle-orm";
import { valueList, type SqlExecutor } from "../db/sql.js";
import type { InferenceUsageCall } from "../pi/usage.js";
import { estimateCallCost, usagePricing, type PricingCatalog, type UsagePricing } from "./usage-pricing.js";
import type { WebMessageUsage, WebModelUsage, WebUsageReport, WebUsageTotals } from "./types.js";

export interface UsageScope { userId?: number; threadId?: number; days?: number }
interface UsageRow {
  rowId: number; id: number; userId: number; title: string; archived: number;
  messageId: number | null; provider: string | null; model: string | null; usage: string | null; timestamp: number;
}
const tokenKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function parseUsage(row: Pick<UsageRow, "usage" | "provider" | "model">) {
  let value: Record<string, unknown> | undefined;
  try { value = record(JSON.parse(row.usage ?? "null")); } catch { return null; }
  if (!value || !tokenKeys.every(key => validCount(value[key]))) return null;
  const totals = value as unknown as InferenceUsageCall;
  const rawCalls = value.calls;
  if (Array.isArray(rawCalls) && rawCalls.length && rawCalls.every(raw => {
    const call = record(raw);
    return call && typeof call.provider === "string" && typeof call.model === "string"
      && tokenKeys.every(key => validCount(call[key]))
      && (call.aggregate === undefined || typeof call.aggregate === "boolean")
      && (call.reasoningTokens === undefined || validCount(call.reasoningTokens) && call.reasoningTokens <= Number(call.outputTokens))
      && (call.cacheWrite1hTokens === undefined || validCount(call.cacheWrite1hTokens) && call.cacheWrite1hTokens <= Number(call.cacheWriteTokens));
  })) {
    const calls = rawCalls as InferenceUsageCall[];
    if (tokenKeys.every(key => calls.reduce((sum, call) => sum + call[key], 0) === totals[key])) return { calls, perCall: true };
  }
  return { calls: [{
    provider: row.provider ?? "unknown", model: row.model ?? "Unknown model",
    inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens,
  }], perCall: false };
}

export function emptyUsage(): WebUsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    reasoningTokens: null, cacheReadRatio: null, recordedTurns: 0, missingUsageTurns: 0, unpricedTurns: 0, estimatedCostUsd: null };
}

function addUsage(target: WebUsageTotals, source: WebUsageTotals) {
  for (const key of [...tokenKeys, "recordedTurns", "missingUsageTurns", "unpricedTurns"] as const) target[key] += source[key];
  if (source.reasoningTokens !== null) target.reasoningTokens = (target.reasoningTokens ?? 0) + source.reasoningTokens;
  if (source.estimatedCostUsd !== null) target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + source.estimatedCostUsd;
  target.totalTokens = tokenKeys.reduce((sum, key) => sum + target[key], 0);
  const prompt = target.inputTokens + target.cacheReadTokens + target.cacheWriteTokens;
  target.cacheReadRatio = prompt ? target.cacheReadTokens / prompt : null;
}

export function summarizeUsage(row: Pick<UsageRow, "usage" | "provider" | "model">, catalog: PricingCatalog): WebMessageUsage {
  const parsed = parseUsage(row);
  const totals: WebMessageUsage = { ...emptyUsage(), models: [], modelCalls: parsed?.perCall && !parsed.calls.some(call => call.aggregate) ? parsed.calls.length : null };
  if (!parsed) { totals.missingUsageTurns = 1; return totals; }
  const models = new Map<string, WebModelUsage>();
  for (const call of parsed.calls) {
    const cost = estimateCallCost(call, catalog, parsed.perCall && !call.aggregate);
    const sample: WebUsageTotals = { ...emptyUsage(), ...Object.fromEntries(tokenKeys.map(key => [key, call[key]])),
      reasoningTokens: call.reasoningTokens ?? null, estimatedCostUsd: cost };
    addUsage(totals, sample);
    if (cost === null) totals.unpricedTurns = 1;
    const key = JSON.stringify([call.provider, call.model]);
    const model = models.get(key) ?? { ...emptyUsage(), provider: call.provider, model: call.model };
    addUsage(model, sample);
    model.recordedTurns = 1;
    if (cost === null) model.unpricedTurns = 1;
    models.set(key, model);
  }
  totals.recordedTurns = 1;
  totals.models = [...models.values()];
  return totals;
}

export class UsageRepository {
  constructor(private readonly db: SqlExecutor, private readonly botUserId?: number, private readonly pricing: UsagePricing = usagePricing) {}

  async messages(messageIds: number[]): Promise<Map<number, WebMessageUsage>> {
    const result = new Map<number, WebMessageUsage>();
    if (!messageIds.length) return result;
    const rows = await this.db.query<UsageRow>(sql`
      select r.result_message_id as "messageId", r.provider, r.model, r.usage_json as usage
      from turn_runs r join messages m on m.id = r.result_message_id and m.thread_id = r.thread_id
      join threads t on t.id = r.thread_id and t.user_id = r.user_id
      where r.result_message_id in (${valueList(messageIds)})
        and ${this.botUserId === undefined ? sql`true` : sql`t.user_id <> ${this.botUserId}`}
    `);
    const catalog = rows.some(row => parseUsage(row)) ? (await this.pricing.load()).catalog : {};
    for (const row of rows) {
      if (row.messageId === null) continue;
      const sample = summarizeUsage(row, catalog);
      const previous = result.get(row.messageId);
      if (previous) {
        addUsage(previous, sample);
        previous.models = mergeModels([...previous.models, ...sample.models]);
        previous.modelCalls = previous.modelCalls === null || sample.modelCalls === null ? null : previous.modelCalls + sample.modelCalls;
      } else result.set(row.messageId, sample);
    }
    return result;
  }

  async report(scope: UsageScope, now = Date.now(), signal?: AbortSignal): Promise<WebUsageReport> {
    // Load external data before opening a snapshot, especially because SQLite
    // serializes transactions with other work on its shared connection.
    signal?.throwIfAborted();
    const pricing = await this.pricing.load();
    signal?.throwIfAborted();
    return this.db.transaction(async tx => {
      signal?.throwIfAborted();
      if (tx.dialect === "postgres") await tx.execute(sql`set transaction isolation level repeatable read read only`);
      return this.reportSnapshot(tx, scope, now, pricing, signal);
    });
  }

  private async reportSnapshot(db: SqlExecutor, scope: UsageScope, now: number,
    pricing: Awaited<ReturnType<UsagePricing["load"]>>, signal?: AbortSignal): Promise<WebUsageReport> {
    const today = Math.floor(now / 86_400_000) * 86_400_000;
    const since = scope.days ? today - (scope.days - 1) * 86_400_000 : null;
    const totals = emptyUsage();
    const days = new Map<string, WebUsageReport["daily"][number]>();
    const threads = new Map<number, WebUsageReport["threads"][number]>();
    const models = new Map<string, WebModelUsage>();
    let firstDay = today, lastDay = scope.threadId !== undefined && since === null ? -Infinity : today;
    // Page each source by its primary key. Never retain historical usage JSON or
    // one model summary per turn after it has been folded into the totals.
    for (const source of ["turns", "messages"] as const) {
      let cursor = 0;
      while (true) {
        signal?.throwIfAborted();
        const selection = source === "turns" ? sql`
          select r.id as "rowId", t.id, t.user_id as "userId", t.title, t.archived,
            r.result_message_id as "messageId", r.provider, r.model, r.usage_json as usage,
            coalesce(r.finished_at, r.started_at, r.accepted_at) as timestamp
          from turn_runs r join threads t on r.thread_id = t.id and r.user_id = t.user_id
          where r.id > ${cursor} and r.status <> 'queued'
        ` : sql`
          select m.id as "rowId", t.id, t.user_id as "userId", t.title, t.archived,
            m.id as "messageId", null as provider, null as model, null as usage, m.created_at as timestamp
          from messages m join threads t on m.thread_id = t.id
          where m.id > ${cursor} and m.role = 'assistant'
            and not exists (select 1 from turn_runs r where r.result_message_id = m.id)
        `;
        const rows = await db.query<UsageRow>(sql`
          select * from (${selection}) usage_rows
          where ${this.botUserId === undefined ? sql`true` : sql`"userId" <> ${this.botUserId}`}
            ${scope.userId === undefined ? sql`` : sql`and "userId" = ${scope.userId}`}
            ${scope.threadId === undefined ? sql`` : sql`and id = ${scope.threadId}`}
            ${since === null ? sql`` : sql`and timestamp >= ${since}`}
            and timestamp <= ${now}
          order by "rowId" asc limit 500
        `);
        signal?.throwIfAborted();
        for (const row of rows) {
          const summary = summarizeUsage(row, pricing.catalog);
          addUsage(totals, summary);
          const day = Math.floor(row.timestamp / 86_400_000) * 86_400_000;
          firstDay = Math.min(firstDay, day);
          const previousLastDay = lastDay;
          lastDay = Math.max(lastDay, day);
          // All-time totals remain complete; the daily graph covers at most a year.
          const earliest = new Date(lastDay - 364 * 86_400_000).toISOString().slice(0, 10);
          if (lastDay !== previousLastDay) {
            for (const date of days.keys()) if (date < earliest) days.delete(date);
          }
          const date = new Date(day).toISOString().slice(0, 10);
          if (date >= earliest) {
            const bucket = days.get(date) ?? { ...emptyUsage(), date };
            addUsage(bucket, summary);
            days.set(date, bucket);
          }
          const thread = threads.get(row.id) ?? { ...emptyUsage(), id: row.id, userId: row.userId, title: row.title, archived: Boolean(row.archived) };
          addUsage(thread, summary);
          threads.set(row.id, thread);
          for (const model of summary.models) mergeModel(models, model);
        }
        // Yield to socket events between pages. SQLite queries can otherwise
        // remain in the microtask queue and delay observing a disconnected client.
        if (signal) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          signal.throwIfAborted();
        }
        if (rows.length < 500) break;
        cursor = rows.at(-1)!.rowId;
      }
    }
    const end = Number.isFinite(lastDay) ? lastDay : today;
    const start = Math.max(since ?? firstDay, end - 364 * 86_400_000);
    // Include quiet days so the graph's spacing represents elapsed time.
    for (let day = start; day <= end; day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      if (!days.has(date)) days.set(date, { ...emptyUsage(), date });
    }
    // A quiet period is zero; a period with untracked/unpriced work is unknown.
    for (const bucket of [totals, ...days.values()]) {
      if (!bucket.recordedTurns && !bucket.missingUsageTurns) bucket.estimatedCostUsd = 0;
    }
    return { totals, daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), dailyTruncated: start > (since ?? firstDay),
      models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      threads: [...threads.values()].sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0) || b.totalTokens - a.totalTokens || b.id - a.id),
      pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, stale: pricing.stale }, since, until: now };
  }
}

function mergeModels(items: WebModelUsage[]): WebModelUsage[] {
  const models = new Map<string, WebModelUsage>();
  for (const item of items) mergeModel(models, item);
  return [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function mergeModel(models: Map<string, WebModelUsage>, item: WebModelUsage) {
  const key = JSON.stringify([item.provider, item.model]);
  const total = models.get(key) ?? { ...emptyUsage(), provider: item.provider, model: item.model };
  addUsage(total, item);
  models.set(key, total);
}
