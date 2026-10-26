import { z } from "zod";

const base = z.object({ kind: z.literal("compaction"), requestedAt: z.number(), updatedAt: z.number() });
export const CompactionActionSchema = z.discriminatedUnion("status", [
  base.extend({ status: z.literal("queued") }),
  base.extend({ status: z.literal("running"), startedAt: z.number() }),
  base.extend({ status: z.literal("succeeded"), startedAt: z.number(), finishedAt: z.number(), messagesCompacted: z.number().int().nonnegative() }),
  base.extend({ status: z.literal("failed"), startedAt: z.number().nullable(), finishedAt: z.number(),
    reason: z.enum(["too_small", "recent", "unchanged", "failed", "interrupted"]), retryAt: z.number().nullable() }),
]);
export type CompactionAction = z.infer<typeof CompactionActionSchema>;
export const COMPACTION_ACTION_STALE_MS = 90_000;

export function savedCompactionAction(content: string, now = Date.now()): CompactionAction | undefined {
  try {
    const parsed = z.object({ action: CompactionActionSchema }).safeParse(JSON.parse(content));
    if (!parsed.success) return undefined;
    const action = parsed.data.action;
    if ((action.status === "queued" || action.status === "running") && now - action.updatedAt > COMPACTION_ACTION_STALE_MS) {
      return { ...action, status: "failed", startedAt: action.status === "running" ? action.startedAt : null,
        finishedAt: action.updatedAt, reason: "interrupted", retryAt: null };
    }
    return action;
  } catch { return undefined; }
}

export function compactionDescription(action: CompactionAction, language: "en" | "ru") {
  const ru = language === "ru";
  if (action.status === "queued") return { title: ru ? "Ожидание сжатия контекста" : "Waiting to compact context", detail: ru ? "Начнётся после текущего ответа." : "Starts when the current reply finishes." };
  if (action.status === "running") return { title: ru ? "Сжатие контекста…" : "Compacting context…", detail: "" };
  if (action.status === "succeeded") return { title: ru ? "Контекст сжат" : "Context compacted", detail: ru ? "История сообщений сохранена." : "Your message history is unchanged." };
  const reasons = {
    too_small: ru ? "Доступный контекст ещё слишком мал. Продолжайте общение." : "The available context is still too small. Keep chatting first.",
    recent: ru ? "Контекст только что сжат. Подождите минуту и продолжите общение." : "Context was just compacted. Wait a minute and continue chatting first.",
    unchanged: ru ? "После прошлого сжатия пока недостаточно новой информации." : "There is not enough new context since the last compaction.",
    failed: ru ? "Не удалось сжать контекст. Попробуйте ещё раз; история сообщений сохранена." : "Could not compact context. Try again; your message history is safe.",
    interrupted: ru ? "Сжатие прервано. Попробуйте ещё раз." : "Compaction was interrupted. Try again.",
  };
  return { title: action.reason === "too_small" || action.reason === "recent" || action.reason === "unchanged"
    ? ru ? "Сжатие пока не нужно" : "Compaction not needed yet"
    : ru ? "Контекст не сжат" : "Context not compacted", detail: reasons[action.reason] };
}

export function compactionDuration(action: CompactionAction, now = Date.now()): number {
  const start = action.status === "queued" ? action.requestedAt : action.startedAt ?? action.requestedAt;
  const end = action.status === "failed" || action.status === "succeeded" ? action.finishedAt : now;
  return Math.max(0, end - start);
}

export function compactionTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
