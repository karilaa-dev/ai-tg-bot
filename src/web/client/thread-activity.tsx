import { Clock3, LoaderCircle, CirclePause } from "lucide-react";
import type { WebThreadActivity } from "../types.js";

export function activityLabel(activity: WebThreadActivity): string {
  const labels = { queued: "Waiting to start", generating: "Generating response…", delivering: "Sending response…",
    stopping: "Stopping response…", interrupted: "Response interrupted" };
  const queued = activity.queuedTurns;
  return labels[activity.state] + (queued > 0 && (activity.state !== "queued" || queued > 1) ? ` · ${queued} queued` : "");
}

export function ThreadActivity({ activity, unavailable = false }: { activity?: WebThreadActivity | null; unavailable?: boolean }) {
  const spinning = activity && ["generating", "delivering", "stopping"].includes(activity.state);
  const Icon = unavailable || activity?.state === "interrupted" ? CirclePause : spinning ? LoaderCircle : Clock3;
  return <div className="thread-activity" role="status" aria-live="polite" aria-atomic="true">
    {(activity || unavailable) && <span><Icon size={15} aria-hidden="true" className={spinning && !unavailable ? "activity-spinner" : undefined} />
      {unavailable ? "Status unavailable · Reconnecting…" : activityLabel(activity!)}
    </span>}
  </div>;
}
