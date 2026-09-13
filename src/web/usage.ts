import { sql } from "drizzle-orm";
import { valueList, type SqlExecutor } from "../db/sql.js";
import type { InferenceUsageCall } from "../pi/usage.js";
import { estimateCallCost, usagePricing, type PricingCatalog, type UsagePricing } from "./usage-pricing.js";
import type { WebMessageUsage, WebModelUsage, WebUsageReport, WebUsageTotals } from "./types.js";

export interface UsageScope { userId?: number; threadId?: number; days?: number }
interface UsageRow {
  id: number; userId: number; title: string; archived: number;
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

  async report(scope: UsageScope, now = Date.now()): Promise<WebUsageReport> {
    const today = Math.floor(now / 86_400_000) * 86_400_000;
    const since = scope.days ? today - (scope.days - 1) * 86_400_000 : null;
    const rows = await this.db.query<UsageRow>(sql`
      select * from (
        select t.id, t.user_id as "userId", t.title, t.archived, r.result_message_id as "messageId",
          r.provider, r.model, r.usage_json as usage, coalesce(r.finished_at, r.started_at, r.accepted_at) as timestamp
        from threads t join turn_runs r on r.thread_id = t.id and r.user_id = t.user_id where r.status <> 'queued'
        union all
        select t.id, t.user_id as "userId", t.title, t.archived, m.id as "messageId",
          null as provider, null as model, null as usage, m.created_at as timestamp
        from threads t join messages m on m.thread_id = t.id where m.role = 'assistant'
          and not exists (select 1 from turn_runs r where r.result_message_id = m.id)
      ) usage_rows
      where ${this.botUserId === undefined ? sql`true` : sql`"userId" <> ${this.botUserId}`}
        ${scope.userId === undefined ? sql`` : sql`and "userId" = ${scope.userId}`}
        ${scope.threadId === undefined ? sql`` : sql`and id = ${scope.threadId}`}
        ${since === null ? sql`` : sql`and timestamp >= ${since}`}
        and timestamp <= ${now}
      order by timestamp asc
    `);
    const pricing = rows.some(row => parseUsage(row)) ? await this.pricing.load()
      : { catalog: {}, source: "LiteLLM" as const, fetchedAt: null, stale: true };
    const totals = emptyUsage();
    const days = new Map<string, WebUsageReport["daily"][number]>();
    const threads = new Map<number, WebUsageReport["threads"][number]>();
    const models: WebModelUsage[] = [];
    // Include quiet days so the graph's spacing represents elapsed time.
    const start = since ?? (rows[0] ? Math.floor(rows[0].timestamp / 86_400_000) * 86_400_000 : today);
    // An all-time thread graph spans its activity, not the idle months after it.
    const end = scope.threadId !== undefined && since === null && rows.length
      ? Math.floor(rows.at(-1)!.timestamp / 86_400_000) * 86_400_000 : today;
    for (let day = start; day <= end; day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      days.set(date, { ...emptyUsage(), date });
    }
    for (const row of rows) {
      const summary = summarizeUsage(row, pricing.catalog);
      addUsage(totals, summary);
      const date = new Date(row.timestamp).toISOString().slice(0, 10);
      addUsage(days.get(date)!, summary);
      const thread = threads.get(row.id) ?? { ...emptyUsage(), id: row.id, userId: row.userId, title: row.title, archived: Boolean(row.archived) };
      addUsage(thread, summary);
      threads.set(row.id, thread);
      models.push(...summary.models);
    }
    // A quiet period is zero; a period with untracked/unpriced work is unknown.
    for (const bucket of [totals, ...days.values()]) {
      if (!bucket.recordedTurns && !bucket.missingUsageTurns) bucket.estimatedCostUsd = 0;
    }
    return { totals, daily: [...days.values()], models: mergeModels(models),
      threads: [...threads.values()].sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0) || b.totalTokens - a.totalTokens || b.id - a.id),
      pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, stale: pricing.stale }, since, until: now };
  }
}

function mergeModels(items: WebModelUsage[]): WebModelUsage[] {
  const models = new Map<string, WebModelUsage>();
  for (const item of items) {
    const key = JSON.stringify([item.provider, item.model]);
    const total = models.get(key) ?? { ...emptyUsage(), provider: item.provider, model: item.model };
    addUsage(total, item);
    models.set(key, total);
  }
  return [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
