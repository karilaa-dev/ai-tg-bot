import { useEffect, useState } from "react";
import { IconAlertCircle, IconCheck, IconFold } from "@tabler/icons-react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { compactionDescription, compactionDuration, compactionTime, type CompactionAction } from "../../../application/compactionAction.js";
import type { UiLanguage } from "../i18n.js";

export function CompactionStatus({ action, messageId, language }: { action: CompactionAction; messageId: number; language: UiLanguage }) {
  const [now, setNow] = useState(Date.now);
  const active = action.status === "queued" || action.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const description = compactionDescription(action, language);
  const rejected = action.status === "failed" && ["too_small", "recent", "unchanged"].includes(action.reason);
  return <div className="chat-thread-action" data-message-id={messageId} data-state={action.status} role="note">
    <div className="chat-thread-action-heading">
      <span className="chat-thread-action-title" role="status">
        {active ? <Loader size={15} /> : action.status === "succeeded" ? <IconCheck size={16} aria-hidden="true" />
          : rejected ? <IconFold size={16} aria-hidden="true" /> : <IconAlertCircle size={16} aria-hidden="true" />}
        {description.title}
      </span>
      <span className="chat-thread-action-time" aria-label={language === "ru" ? "Длительность" : "Elapsed time"}>
        {compactionTime(compactionDuration(action, now))}
      </span>
    </div>
    {description.detail && <p>{description.detail}</p>}
  </div>;
}
