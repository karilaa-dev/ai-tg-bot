import { sql } from "drizzle-orm";

/** A thread has at most one active turn. Queued turns join it in the unfinished set. */
const active = ["running", "awaiting_delivery"] as const;
const unfinished = ["queued", ...active] as const;
type Unfinished = typeof unfinished[number];
export type TurnRunStatus = Unfinished | "succeeded" | "failed" | "cancelled" | "interrupted";

export function isUnfinishedTurn(status: TurnRunStatus): status is Unfinished {
  return unfinished.some(candidate => candidate === status);
}

// Literal lists let SQLite and PostgreSQL match the partial unique index on active turns.
// Keep these private inputs restricted to the compile-time status vocabulary.
function literals(statuses: readonly TurnRunStatus[]) {
  return sql.join(statuses.map(status => sql.raw(`'${status}'`)), sql`, `);
}

export const activeTurnStatuses = literals(active);
export const unfinishedTurnStatuses = literals(unfinished);
const cancellableTurnStatuses = literals(["queued", "running"]);

/** Legal sources for a terminal write. An already terminal row keeps its first outcome. */
export const finishTurnFrom = {
  succeeded: activeTurnStatuses,
  failed: unfinishedTurnStatuses,
  cancelled: cancellableTurnStatuses,
};
