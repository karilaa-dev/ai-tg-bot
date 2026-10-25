import { IconClock, IconLoader2, IconPlayerPause } from "@tabler/icons-react";
import type { WebThreadActivity } from "../types.js";
import { sharedStrings, useSharedStrings, type UiLanguage } from "./i18n.js";

export function activityLabel(activity: WebThreadActivity, language: UiLanguage = "en"): string {
  const t = sharedStrings(language);
  const queued = activity.queuedTurns;
  return t.activity[activity.state] + (queued > 0 && (activity.state !== "queued" || queued > 1) ? ` · ${t.queuedTurns(queued)}` : "");
}

export function ThreadActivity({ activity, unavailable = false }: { activity?: WebThreadActivity | null; unavailable?: boolean }) {
  const t = useSharedStrings();
  const spinning = activity && ["generating", "delivering", "stopping"].includes(activity.state);
  const Icon = unavailable || activity?.state === "interrupted" ? IconPlayerPause : spinning ? IconLoader2 : IconClock;
  return <div className="thread-activity" role="status" aria-live="polite" aria-atomic="true">
    {(activity || unavailable) && <span><Icon size={15} aria-hidden="true" className={spinning && !unavailable ? "activity-spinner" : undefined} />
      {unavailable ? t.statusUnavailable : activityLabel(activity!, "en")}
    </span>}
  </div>;
}
