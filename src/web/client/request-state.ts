/** Start, retry and settle UI requests without carrying a previous failure into a new attempt. */
export type RequestState<E = unknown> =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "failed"; error: E };

/** Multiple refreshes during one read need just one follow-up read. */
export class CoalescedRead {
  private phase: "idle" | "reading" | "refresh-requested" = "idle";

  start(queueIfBusy = true): boolean {
    if (this.phase === "idle") {
      this.phase = "reading";
      return true;
    }
    if (queueIfBusy) this.phase = "refresh-requested";
    return false;
  }

  takeRefresh(): boolean {
    if (this.phase !== "refresh-requested") return false;
    this.phase = "reading";
    return true;
  }

  finish(): boolean {
    const refresh = this.phase === "refresh-requested";
    this.phase = "idle";
    return refresh;
  }
}

/** Polls keep their last error visible while retrying. A successful read clears it. */
export type PollState<E = unknown> =
  | { kind: "ready" | "loading" }
  | { kind: "failed" | "retrying"; error: E };

export function startPoll<E>(previous: PollState<E>): PollState<E> {
  return "error" in previous ? { kind: "retrying", error: previous.error } : { kind: "loading" };
}
