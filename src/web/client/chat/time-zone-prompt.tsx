import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { IconCheck, IconClock, IconX } from "@tabler/icons-react";
import { useUiLanguage } from "../i18n.js";
import { usePreferences } from "./preferences.js";
import { useChatStrings } from "./strings.js";
import { deviceZone, useMinute, utc, zoneOffset, zoneTime } from "./time-zones.js";

const dismissedKey = (userId: number) => `chat-zone-prompt-dismissed:${userId}`;
const wasDismissed = (userId: number) => { try { return localStorage.getItem(dismissedKey(userId)) === "1"; } catch { return false; } };
const rememberDismissed = (userId: number) => { try { localStorage.setItem(dismissedKey(userId), "1"); } catch { /* Storage can be disabled. */ } };

type Phase = { kind: "ask" } | { kind: "saving" } | { kind: "failed" } | { kind: "saved"; zone: string } | { kind: "closed" };

/** Asks a user without any time zone to use this device's one. "Not now" is remembered on this device. */
export function TimeZonePrompt({ userId, onChoose }: { userId: number; onChoose: () => void }) {
  const { state, update } = usePreferences();
  const [device] = useState(deviceZone);
  const [dismissed, setDismissed] = useState(() => wasDismissed(userId));
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (phase.kind !== "saved") return;
    const timer = setTimeout(() => setPhase({ kind: "closed" }), 6_000);
    return () => clearTimeout(timer);
  }, [phase]);

  // An offset saved in Telegram counts as set; Settings offers to name it.
  const unset = state.kind === "ready" && state.settings.timeZone === null && state.settings.timezoneOffsetMinutes === null;
  const asking = (phase.kind === "ask" || phase.kind === "failed") && unset && !dismissed;
  if (!device || (!asking && phase.kind !== "saving" && phase.kind !== "saved")) return null;

  const accept = async () => {
    setPhase({ kind: "saving" });
    try {
      await update({ timeZone: device });
      if (mounted.current) setPhase({ kind: "saved", zone: device });
    } catch {
      if (mounted.current) setPhase({ kind: "failed" });
    }
  };
  const close = () => {
    if (phase.kind === "saved") { setPhase({ kind: "closed" }); return; }
    rememberDismissed(userId);
    setDismissed(true);
  };
  return <ZoneCard zone={device} phase={phase} onAccept={() => void accept()} onChoose={onChoose} onClose={close} />;
}

/** The visible card; it owns the clock so nothing ticks while the question is hidden. */
function ZoneCard({ zone, phase, onAccept, onChoose, onClose }: { zone: string; phase: Phase; onAccept: () => void; onChoose: () => void; onClose: () => void }) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const now = useMinute();
  const saving = phase.kind === "saving";
  const saved = phase.kind === "saved" ? phase.zone : null;
  return <section className="chat-notice" aria-label={t.zonePromptTitle}>
    <span className="chat-notice-icon" aria-hidden="true">{saved ? <IconCheck size={18} /> : <IconClock size={18} />}</span>
    <div className="chat-notice-copy">
      {saved ? <p className="chat-notice-title">{t.zoneSet(saved)}</p> : <>
        <h2 className="chat-notice-title">{t.zonePromptTitle}</h2>
        <p className="chat-notice-text">{t.zonePromptBody(zoneTime(zone, language, now), zone, utc(zoneOffset(zone, now) ?? 0))}</p>
        {phase.kind === "failed" && <p className="chat-error-text" role="alert">{t.saveFailed}</p>}
      </>}
    </div>
    <Button className="chat-notice-close" variant="ghost" shape="square" aria-label={saved ? t.dismiss : t.notNow}
      disabled={saving} onClick={onClose}><IconX size={16} aria-hidden="true" /></Button>
    {!saved && <div className="chat-notice-actions">
      <Button variant="primary" loading={saving} onClick={onAccept}>{t.useZone(zone)}</Button>
      <Button variant="secondary" disabled={saving} onClick={onChoose}>{t.otherZone}</Button>
    </div>}
    {/* Only the confirmation is announced; the question's clock changes every minute. */}
    <span className="sr-only" role="status">{saved ? t.zoneSet(saved) : ""}</span>
  </section>;
}
