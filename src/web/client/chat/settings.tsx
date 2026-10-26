import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { IconAlertCircle, IconCheck, IconRefresh } from "@tabler/icons-react";
import type { ChatSettings, ChatSettingsPatch } from "../../chat-types.js";
import { useUiLanguage } from "../i18n.js";
import { describeError } from "./api.js";
import { usePreferences } from "./preferences.js";
import { PageHeader, PageTitle } from "./shell-parts.js";
import { useChatStrings } from "./strings.js";
import { deviceZone, useMinute, utc, zoneNames, zoneOffset, zoneSearchText, zoneTime } from "./time-zones.js";

// Each language is named in itself so it can be found from either interface.
const languages = [{ value: "en", label: "English" }, { value: "ru", label: "Русский" }] satisfies { value: ChatSettings["language"]; label: string }[];
type SaveResult = { kind: "idle" } | { kind: "saved" } | { kind: "failed"; error: unknown };

export function ChatSettingsView({ onOpenMemories }: { onOpenMemories: () => void }) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const { state, reload, update } = usePreferences();
  const [inFlight, setInFlight] = useState<Partial<Record<keyof ChatSettings, number>>>({});
  const [result, setResult] = useState<SaveResult>({ kind: "idle" });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [device] = useState(deviceZone);
  const zones = useMemo(zoneNames, []);
  const now = useMinute();

  // Changes save one at a time in order; a failure restores only the value that failed.
  const change = async <K extends keyof ChatSettingsPatch>(key: K, value: ChatSettingsPatch[K]) => {
    const patch: ChatSettingsPatch = {};
    patch[key] = value;
    setInFlight(current => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
    setResult({ kind: "idle" });
    try {
      await update(patch);
      if (mounted.current) setResult(current => current.kind === "failed" ? current : { kind: "saved" });
    } catch (error) {
      if (mounted.current) setResult({ kind: "failed", error: error ?? new Error() });
    } finally {
      if (mounted.current) setInFlight(current => ({ ...current, [key]: Math.max(0, (current[key] ?? 1) - 1) }));
    }
  };
  const saving = (key: keyof ChatSettingsPatch) => (inFlight[key] ?? 0) > 0;
  const anySaving = Object.values(inFlight).some(count => count > 0);
  const settings = state.kind === "ready" ? state.settings : null;
  const zone = settings?.timeZone ?? null;
  // An offset saved in Telegram has no zone name; it is shown until the user picks one.
  const telegramOffset = zone === null ? settings?.timezoneOffsetMinutes ?? null : null;
  const zoneStatus = zone ? ` ${t.zoneNow(zoneTime(zone, language, now), utc(zoneOffset(zone, now) ?? 0))}` : "";

  return <div className="chat-view">
    <PageHeader actions={<span className="chat-save-state" role="status" aria-live="polite">{anySaving ? <><Loader size={14} /> {t.saving}</> : result.kind === "saved" ? <><IconCheck size={14} aria-hidden="true" /> {t.saved}</> : ""}</span>} />
    <div className="chat-page-scroll"><div className="chat-page">
      <PageTitle title={t.settings} description={t.settingsDescription} />
      {result.kind === "failed" && <Banner variant="error" icon={<IconAlertCircle aria-hidden="true" />} description={describeError(result.error, t.saveFailed, language)} />}
      {state.kind === "failed" && <Banner variant="error" icon={<IconAlertCircle aria-hidden="true" />} title={t.settingsUnavailable} description={describeError(state.error, t.settingsFailed, language)}
        action={<Button size="sm" icon={<IconRefresh size={16} aria-hidden="true" />} onClick={reload}>{t.tryAgain}</Button>} />}
      {state.kind === "loading" && <LayerCard className="chat-settings-card" aria-busy="true">{[0, 1, 2, 3].map(row => <div key={row} className="chat-setting"><SkeletonLine minWidth={30} maxWidth={55} /></div>)}</LayerCard>}
      {settings && <>
        <section className="chat-settings-section" aria-labelledby="settings-replies">
          <h2 id="settings-replies">{t.replies}</h2>
          <LayerCard className="chat-settings-card">
            <div className="chat-setting">
              <div className="chat-setting-copy"><span className="chat-setting-label" id="setting-language">{t.language}</span><p className="chat-muted">{t.languageDescription}</p></div>
              <Select<ChatSettings["language"]> aria-labelledby="setting-language" className="chat-setting-control" items={languages} value={settings.language}
                disabled={saving("language")} onValueChange={value => { if (value && value !== settings.language) void change("language", value); }} />
            </div>
            <div className="chat-setting">
              <div className="chat-setting-copy"><span className="chat-setting-label" id="setting-zone">{t.timeZone}</span>
                <p className="chat-muted">{telegramOffset !== null ? t.zoneFromTelegram(utc(telegramOffset)) : `${t.timeZoneDescription}${zoneStatus}`}</p>
                {device && zone !== device && <Button className="chat-setting-inline" variant="ghost" size="sm" disabled={saving("timeZone")} onClick={() => void change("timeZone", device)}>{t.useZone(device)}</Button>}
              </div>
              <ZonePicker zones={zones} value={zone} disabled={saving("timeZone")} labelledBy="setting-zone"
                onChange={next => { if (next !== zone) void change("timeZone", next); }} />
            </div>
            <div className="chat-setting">
              <div className="chat-setting-copy"><span className="chat-setting-label" id="setting-streaming">{t.streamReplies}</span><p className="chat-muted">{t.streamDescription}</p></div>
              <Switch aria-labelledby="setting-streaming" checked={settings.streaming} transitioning={saving("streaming")} onCheckedChange={checked => void change("streaming", checked)} />
            </div>
          </LayerCard>
        </section>
        <section className="chat-settings-section" aria-labelledby="settings-memory">
          <h2 id="settings-memory">{t.memory}</h2>
          <LayerCard className="chat-settings-card">
            <div className="chat-setting">
              <div className="chat-setting-copy"><span className="chat-setting-label" id="setting-memory">{t.rememberMe}</span>
                <p className="chat-muted">{t.rememberDescription}</p></div>
              <Switch aria-labelledby="setting-memory" checked={settings.memoryEnabled} transitioning={saving("memoryEnabled")} onCheckedChange={checked => void change("memoryEnabled", checked)} />
            </div>
            <div className="chat-setting">
              <div className="chat-setting-copy"><span className="chat-setting-label">{t.savedNotes}</span><p className="chat-muted">{t.savedNotesDescription}</p></div>
              <Button variant="secondary" onClick={onOpenMemories}>{t.viewMemories}</Button>
            </div>
          </LayerCard>
        </section>
      </>}
    </div></div>
  </div>;
}

const offsetLabels = new Map<string, string>();
const offsetLabel = (zone: string) => {
  let label = offsetLabels.get(zone);
  if (label === undefined) { const offset = zoneOffset(zone); label = offset === null ? "" : utc(offset); offsetLabels.set(zone, label); }
  return label;
};

/** A searchable list of IANA zones; spaces match underscores and slashes, so "los angeles" finds America/Los_Angeles. */
function ZonePicker({ zones, value, disabled, labelledBy, onChange }: {
  zones: string[]; value: string | null; disabled: boolean; labelledBy: string; onChange: (zone: string | null) => void;
}) {
  const t = useChatStrings();
  return <Combobox<string> items={zones} value={value} disabled={disabled} onValueChange={next => onChange(next ?? null)}
    filter={(zone, query) => zoneSearchText(zone).includes(zoneSearchText(query.trim()))}>
    <Combobox.TriggerInput className="chat-setting-control chat-zone-input" aria-labelledby={labelledBy}
      placeholder={t.zoneSearch} clearLabel={t.clearZone} showOptionsLabel={t.showZones} />
    <Combobox.Content className="chat-zone-popup">
      <Combobox.Empty>{t.zoneNoMatch}</Combobox.Empty>
      <Combobox.List>{(zone: string) => <Combobox.Item key={zone} value={zone} className="chat-zone-item">
        <span className="chat-zone-name">{zone}</span><span className="chat-zone-offset">{offsetLabel(zone)}</span>
      </Combobox.Item>}</Combobox.List>
    </Combobox.Content>
  </Combobox>;
}
