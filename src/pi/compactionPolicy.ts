import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";

export const COMPACTION_COOLDOWN_MS = 60_000;
export const MIN_COMPACTION_TOKENS = 8_000;
export const MIN_NEW_COMPACTION_TOKENS = 2_048;

export class CompactionGuardError extends Error {
  constructor(readonly reason: "too_small" | "recent" | "unchanged", readonly retryAt: number | null = null) {
    super(`Compaction unavailable: ${reason}`);
  }
}

export function assertCompactionUseful(session: Pick<AgentSession, "sessionManager" | "settingsManager" | "model">, now = Date.now()): void {
  const branch = session.sessionManager.getBranch();
  const last = branch.findLast(entry => entry.type === "compaction");
  const lastTime = last ? Date.parse(last.timestamp) : 0;
  if (last && lastTime + COMPACTION_COOLDOWN_MS > now) throw new CompactionGuardError("recent", lastTime + COMPACTION_COOLDOWN_MS);
  // The projection includes the current summary and retained/edited messages,
  // rather than old history or token usage captured before compaction.
  const projection = session.sessionManager.buildSessionProjection();
  const tokens = projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const keep = session.settingsManager.getCompactionSettings(session.model).keepRecentTokens;
  if (tokens < Math.max(MIN_COMPACTION_TOKENS, keep + MIN_NEW_COMPACTION_TOKENS)) throw new CompactionGuardError("too_small");
  if (last) {
    const newIds = new Set(branch.slice(branch.indexOf(last) + 1).filter(entry => entry.type === "message").map(entry => entry.id));
    const added = projection.entries.filter(entry => newIds.has(entry.sourceEntry.id))
      .flatMap(entry => entry.messages).reduce((sum, message) => sum + estimateTokens(message), 0);
    if (added < MIN_NEW_COMPACTION_TOKENS) throw new CompactionGuardError("unchanged");
  }
}
