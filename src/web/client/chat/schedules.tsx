import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { IconAlertCircle, IconBrandTelegram, IconCalendarClock, IconDots, IconMessage, IconPencil, IconPlayerPause, IconPlayerPlay, IconRefresh, IconTrash } from "@tabler/icons-react";
import type { ChatSchedule, ChatThread } from "../../chat-types.js";
import { useUiLanguage } from "../i18n.js";
import { chatApi, ChatApiError, describeError, type ChatSchedulePatch } from "./api.js";
import { PageHeader, PageTitle } from "./shell-parts.js";
import { chatFormat, useChatStrings, type ChatStrings } from "./strings.js";

/** Repeating schedules support intervals from one hour through one year. */
export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 525_600;
const MAX_TITLE = 120;
const MAX_PROMPT = 4_000;

/** Shared by the sidebar, chat header and schedule page; polls slowly because the assistant can add schedules too. */
export function useSchedules() {
  const [items, setItems] = useState<ChatSchedule[]>([]);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await chatApi.schedules(controller.signal);
        if (controller.signal.aborted) return;
        setItems(result.items); setError(null); setStatus("ready");
      } catch (err) {
        if (!controller.signal.aborted) { setError(err ?? new Error()); setStatus("ready"); }
      } finally { busy = false; }
    };
    const loop = async () => {
      await load();
      if (!controller.signal.aborted) timer = setTimeout(() => void loop(), 30_000);
    };
    void loop();
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [revision]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  /** Shows a saved or deleted schedule at once; the next poll confirms it. */
  const put = useCallback((schedule: ChatSchedule) => setItems(list => [...list.filter(item => item.id !== schedule.id && item.threadId !== schedule.threadId), schedule]), []);
  const drop = useCallback((scheduleId: string) => setItems(list => list.filter(item => item.id !== scheduleId)), []);
  const byThread = useMemo(() => new Map(items.map(item => [item.threadId, item])), [items]);
  return { items, byThread, status, error, refresh, put, drop };
}
export type Schedules = ReturnType<typeof useSchedules>;

type Repeat = "once" | "hourly" | "daily" | "weekly" | "custom";
const presets: Record<Exclude<Repeat, "custom">, number | null> = { once: null, hourly: 60, daily: 1_440, weekly: 10_080 };
const repeatFor = (minutes: number | null): Repeat => (Object.entries(presets) as [Exclude<Repeat, "custom">, number | null][]).find(([, value]) => value === minutes)?.[0] ?? "custom";

const pad = (value: number) => String(value).padStart(2, "0");
/** `datetime-local` values are local wall-clock time without a zone. */
export function toLocalInput(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fromLocalInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}
/** The next whole hour that is at least ten minutes away. */
const defaultFirstRun = (now = Date.now()) => {
  const date = new Date(now + 10 * 60_000);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date.getTime();
};
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } };

interface Form { title: string; prompt: string; when: string; repeat: Repeat; hours: string; enabled: boolean }
type Problems = Partial<Record<"title" | "prompt" | "when" | "hours", string>>;

function initialForm(schedule: ChatSchedule | null, threadTitle: string): Form {
  if (!schedule) return { title: threadTitle.slice(0, MAX_TITLE), prompt: "", when: toLocalInput(defaultFirstRun()), repeat: "daily", hours: "24", enabled: true };
  const repeat = repeatFor(schedule.intervalMinutes);
  return { title: schedule.title, prompt: schedule.prompt, when: toLocalInput(schedule.nextRunAt), repeat,
    hours: schedule.intervalMinutes === null ? "24" : String(schedule.intervalMinutes / 60), enabled: schedule.enabled };
}

/** Creates the conversation's schedule, or edits the one it already has. */
export function ScheduleDialog({ open, onOpenChange, thread, schedule, schedules, resume = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: Pick<ChatThread, "id" | "title"> | null;
  schedule: ChatSchedule | null;
  schedules: Schedules;
  /** Opened from Resume because the saved time has passed: the switch starts on and a new time is required. */
  resume?: boolean;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const id = useId();
  const [form, setForm] = useState<Form>(() => initialForm(schedule, thread?.title ?? ""));
  const [problems, setProblems] = useState<Problems>({});
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [failure, setFailure] = useState<{ kind: "save" | "delete"; error: unknown } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const zone = useMemo(deviceZone, []);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Each opening starts from the saved schedule, so a cancelled edit leaves nothing behind.
  useEffect(() => {
    if (!open) return;
    const next = initialForm(schedule, thread?.title ?? "");
    setForm(resume ? { ...next, enabled: true } : next);
    setProblems({}); setFailure(null); setBusy(null); setConfirmDelete(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm(current => ({ ...current, [key]: value }));
    setProblems(current => key in current ? { ...current, [key]: undefined } : current);
  };
  const interval = (): number | null | undefined => {
    if (form.repeat !== "custom") return presets[form.repeat];
    const hours = Number(form.hours);
    const minutes = Math.round(hours * 60);
    return Number.isFinite(hours) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES
      && Math.abs(hours * 60 - minutes) < 1e-7 ? minutes : undefined;
  };

  const save = async () => {
    if (!thread || busy) return;
    const found: Problems = {};
    const title = form.title.trim();
    const prompt = form.prompt.trim();
    if (!title) found.title = t.scheduleNeedsName;
    if (!prompt) found.prompt = t.scheduleNeedsPrompt;
    const when = fromLocalInput(form.when);
    const minutes = interval();
    if (minutes === undefined) found.hours = t.scheduleNeedsHours;
    // An unchanged time may be overdue by seconds while it runs; only new times and resumed schedules must lie ahead.
    const timeChanged = !schedule || when !== fromLocalInput(toLocalInput(schedule.nextRunAt));
    const resuming = Boolean(schedule && !schedule.enabled && form.enabled);
    if (when === null) found.when = t.scheduleNeedsTime;
    else if ((timeChanged || resuming) && when <= Date.now()) found.when = t.scheduleNeedsFuture;
    setProblems(found);
    if (Object.keys(found).length || when === null || minutes === undefined) return;
    setBusy("save"); setFailure(null);
    try {
      let saved: ChatSchedule;
      if (!schedule) saved = await chatApi.createSchedule({ threadId: thread.id, title, prompt, intervalMinutes: minutes, nextRunAt: when });
      else {
        const patch: ChatSchedulePatch = {};
        if (title !== schedule.title) patch.title = title;
        if (prompt !== schedule.prompt) patch.prompt = prompt;
        if (minutes !== schedule.intervalMinutes) patch.intervalMinutes = minutes;
        if (timeChanged) patch.nextRunAt = when;
        if (form.enabled !== schedule.enabled) patch.enabled = form.enabled;
        saved = Object.keys(patch).length ? await chatApi.updateSchedule(schedule.id, patch) : schedule;
      }
      if (!mounted.current) return;
      schedules.put(saved); schedules.refresh();
      onOpenChange(false);
    } catch (error) {
      if (mounted.current) setFailure({ kind: "save", error: error ?? new Error() });
    } finally { if (mounted.current) setBusy(null); }
  };
  const remove = async () => {
    if (!schedule || busy) return;
    setBusy("delete"); setFailure(null);
    try {
      await deleteSchedule(schedule.id);
      if (!mounted.current) return;
      schedules.drop(schedule.id); schedules.refresh();
      onOpenChange(false);
    } catch (error) {
      if (mounted.current) setFailure({ kind: "delete", error: error ?? new Error() });
    } finally { if (mounted.current) setBusy(null); }
  };

  const repeatItems = [
    { value: "once", label: t.repeatOnce }, { value: "hourly", label: t.repeatHourly }, { value: "daily", label: t.repeatDaily },
    { value: "weekly", label: t.repeatWeekly }, { value: "custom", label: t.repeatCustom },
  ] satisfies { value: Repeat; label: string }[];
  const failureText = failure ? describeError(failure.error, failure.kind === "save" ? t.scheduleSaveFailed : t.scheduleDeleteFailed, language) : "";

  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <Dialog size="lg" className="chat-dialog chat-schedule-dialog">
      {confirmDelete && schedule ? <>
        <Dialog.Title>{t.scheduleDeleteTitle}</Dialog.Title>
        <Dialog.Description>{t.scheduleDeleteDescription(schedule.title)}</Dialog.Description>
        {failureText && <p className="chat-error-text" role="alert">{failureText}</p>}
        <div className="chat-dialog-actions">
          <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>{t.cancel}</Button>
          <Button variant="destructive" icon={<IconTrash size={16} aria-hidden="true" />} loading={busy === "delete"} onClick={() => void remove()}>{t.scheduleDelete}</Button>
        </div>
      </> : <>
        <Dialog.Title>{schedule ? t.editScheduleTitle : t.newScheduleTitle}</Dialog.Title>
        <Dialog.Description>{t.scheduleDialogDescription}</Dialog.Description>
        <form className="chat-schedule-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
          <Input label={t.scheduleName} value={form.title} maxLength={MAX_TITLE} required autoComplete="off" error={problems.title}
            onChange={event => set("title", event.target.value)} />
          <InputArea label={t.schedulePrompt} value={form.prompt} maxLength={MAX_PROMPT} rows={4} required placeholder={t.schedulePromptPlaceholder} error={problems.prompt}
            onChange={event => set("prompt", event.target.value)} />
          <div className="chat-schedule-when">
            <Input type="datetime-local" label={schedule ? t.scheduleNextRun : t.scheduleFirstRun} value={form.when} min={toLocalInput(Date.now())} required error={problems.when}
              description={zone ? t.scheduleZone(zone) : undefined} onChange={event => set("when", event.target.value)} />
            <Select<Repeat> label={t.scheduleRepeat} items={repeatItems} value={form.repeat} onValueChange={value => { if (value) set("repeat", value); }} />
          </div>
          {form.repeat === "custom" && <Input type="number" inputMode="decimal" min={1} max={MAX_INTERVAL_MINUTES / 60} step="any" label={t.repeatHours}
            description={t.repeatHoursDescription} value={form.hours} error={problems.hours} onChange={event => set("hours", event.target.value)} />}
          {schedule && <div className="chat-schedule-active">
            <div className="chat-setting-copy"><span className="chat-setting-label" id={`${id}-active`}>{t.scheduleActive}</span><p className="chat-muted">{t.scheduleActiveDescription}</p></div>
            <Switch aria-labelledby={`${id}-active`} checked={form.enabled} onCheckedChange={checked => set("enabled", checked)} />
          </div>}
          {failureText && <p className="chat-error-text" role="alert">{failureText}</p>}
          <div className="chat-dialog-actions chat-schedule-actions">
            {schedule && <Button type="button" variant="ghost" className="chat-schedule-delete" icon={<IconTrash size={16} aria-hidden="true" />} disabled={busy !== null}
              onClick={() => { setFailure(null); setConfirmDelete(true); }}>{t.scheduleDelete}</Button>}
            <Dialog.Close render={<Button type="button" variant="secondary" disabled={busy !== null}>{t.cancel}</Button>} />
            <Button type="submit" variant="primary" icon={<IconCalendarClock size={16} aria-hidden="true" />} loading={busy === "save"}>{schedule ? t.scheduleSave : t.scheduleCreate}</Button>
          </div>
        </form>
      </>}
    </Dialog>
  </Dialog.Root>;
}

/** A schedule that another tab or the assistant already removed counts as deleted. */
async function deleteSchedule(scheduleId: string) {
  try { await chatApi.deleteSchedule(scheduleId); }
  catch (error) { if (!(error instanceof ChatApiError && error.status === 404)) throw error; }
}

export function scheduleState(schedule: ChatSchedule, t: ChatStrings, format: ReturnType<typeof chatFormat>, now: number): string {
  if (!schedule.enabled) return schedule.intervalMinutes === null && schedule.lastRunAt !== null ? t.scheduleDone : t.schedulePaused;
  return schedule.nextRunAt <= now ? t.scheduleOverdue : t.scheduleNext(format.when(schedule.nextRunAt, now));
}

export function SchedulesView({ schedules, threads, onOpenThread }: {
  schedules: Schedules;
  threads: ChatThread[];
  onOpenThread: (threadId: string) => void;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const format = useMemo(() => chatFormat(language), [language]);
  const [editing, setEditing] = useState<{ open: boolean; schedule: ChatSchedule | null; resume: boolean }>({ open: false, schedule: null, resume: false });
  const [deleting, setDeleting] = useState<{ open: boolean; schedule: ChatSchedule | null }>({ open: false, schedule: null });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<{ error: unknown; fallback: string } | null>(null);
  const titles = useMemo(() => new Map(threads.map(thread => [thread.id, thread])), [threads]);
  const now = Date.now();
  const sorted = [...schedules.items].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt - b.nextRunAt);

  const toggle = async (schedule: ChatSchedule, enabled: boolean) => {
    // A paused schedule whose time has passed needs a new one; the dialog asks for it.
    if (enabled && schedule.nextRunAt <= Date.now()) { setEditing({ open: true, schedule, resume: true }); return; }
    setBusy(current => new Set(current).add(schedule.id)); setFailure(null);
    try {
      const saved = await chatApi.updateSchedule(schedule.id, { enabled });
      schedules.put(saved); schedules.refresh();
    } catch (error) { setFailure({ error: error ?? new Error(), fallback: t.scheduleSaveFailed }); }
    finally { setBusy(current => { const next = new Set(current); next.delete(schedule.id); return next; }); }
  };

  const editingThread = editing.schedule ? titles.get(editing.schedule.threadId) ?? { id: editing.schedule.threadId, title: editing.schedule.title } : null;
  return <div className="chat-view">
    <PageHeader />
    <div className="chat-page-scroll"><div className="chat-page">
      <PageTitle title={t.schedules} description={t.schedulesDescription} />
      {failure && <Banner variant="error" icon={<IconAlertCircle aria-hidden="true" />} description={describeError(failure.error, failure.fallback, language)}
        action={<Button size="sm" variant="ghost" onClick={() => setFailure(null)}>{t.dismiss}</Button>} />}
      {schedules.error !== null && <Banner variant="error" icon={<IconAlertCircle aria-hidden="true" />} description={describeError(schedules.error, t.schedulesFailed, language)}
        action={<Button size="sm" icon={<IconRefresh size={16} aria-hidden="true" />} onClick={schedules.refresh}>{t.tryAgain}</Button>} />}
      {schedules.status === "loading" && <LayerCard className="chat-settings-card" aria-busy="true">{[0, 1, 2].map(row => <div key={row} className="chat-setting"><SkeletonLine minWidth={30} maxWidth={60} /></div>)}</LayerCard>}
      {schedules.status === "ready" && schedules.error === null && !sorted.length && <div className="chat-empty-state chat-schedule-empty">
        <IconCalendarClock size={28} aria-hidden="true" className="chat-muted" />
        <h2>{t.schedulesEmptyTitle}</h2><p className="chat-muted">{t.schedulesEmpty}</p>
      </div>}
      {sorted.length > 0 && <LayerCard className="chat-settings-card">
        <ul className="chat-schedule-list">{sorted.map(schedule => {
          const thread = titles.get(schedule.threadId);
          const chatTitle = thread?.title ?? schedule.title;
          return <li key={schedule.id} className="chat-schedule-row" data-enabled={schedule.enabled}>
            <div className="chat-schedule-copy">
              <span className="chat-setting-label chat-schedule-title">{schedule.title}</span>
              <p className="chat-schedule-prompt">{schedule.prompt}</p>
              <p className="chat-schedule-meta">
                <span>{t.scheduleRepeatLabel(schedule.intervalMinutes)}</span>
                <span className={schedule.enabled ? undefined : "chat-schedule-paused"}>{scheduleState(schedule, t, format, now)}</span>
                <span>{schedule.lastRunAt === null ? t.scheduleNeverRan : t.scheduleLast(format.when(schedule.lastRunAt, now))}</span>
              </p>
              <a className="chat-schedule-chat" href={`/?thread=${schedule.threadId}`} aria-label={t.scheduleOpenChatNamed(chatTitle)}
                onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onOpenThread(schedule.threadId); }}>
                {thread?.origin === "telegram" ? <IconBrandTelegram size={14} aria-hidden="true" /> : <IconMessage size={14} aria-hidden="true" />}<span>{chatTitle}</span>
              </a>
            </div>
            <div className="chat-schedule-controls">
              <Switch aria-label={t.scheduleToggle(schedule.title)} checked={schedule.enabled} transitioning={busy.has(schedule.id)} disabled={busy.has(schedule.id)}
                onCheckedChange={checked => void toggle(schedule, checked)} />
              <DropdownMenu>
                <DropdownMenu.Trigger render={<Button variant="ghost" shape="square" size="sm" aria-label={t.scheduleActions(schedule.title)}><IconDots size={18} aria-hidden="true" /></Button>} />
                <DropdownMenu.Content align="end" sideOffset={6}>
                  <DropdownMenu.Item icon={<IconPencil size={16} aria-hidden="true" />} onClick={() => setEditing({ open: true, schedule, resume: false })}>{t.editSchedule}</DropdownMenu.Item>
                  <DropdownMenu.Item icon={schedule.enabled ? <IconPlayerPause size={16} aria-hidden="true" /> : <IconPlayerPlay size={16} aria-hidden="true" />}
                    disabled={busy.has(schedule.id)} onClick={() => void toggle(schedule, !schedule.enabled)}>{schedule.enabled ? t.schedulePause : t.scheduleResume}</DropdownMenu.Item>
                  <DropdownMenu.Item icon={<IconMessage size={16} aria-hidden="true" />} onClick={() => onOpenThread(schedule.threadId)}>{t.scheduleOpenChat}</DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item variant="danger" icon={<IconTrash size={16} aria-hidden="true" />} onClick={() => setDeleting({ open: true, schedule })}>{t.scheduleDelete}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
            </div>
          </li>;
        })}</ul>
      </LayerCard>}
    </div></div>
    <ScheduleDialog open={editing.open} onOpenChange={open => setEditing(current => ({ ...current, open }))} thread={editingThread} schedule={editing.schedule}
      schedules={schedules} resume={editing.resume} />
    <DeleteScheduleDialog open={deleting.open} onOpenChange={open => setDeleting(current => ({ ...current, open }))} schedule={deleting.schedule} schedules={schedules} />
  </div>;
}

function DeleteScheduleDialog({ open, onOpenChange, schedule, schedules }: {
  open: boolean; onOpenChange: (open: boolean) => void; schedule: ChatSchedule | null; schedules: Schedules;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (open) { setBusy(false); setError(null); } }, [open]);
  const remove = async () => {
    if (!schedule || busy) return;
    setBusy(true); setError(null);
    try {
      await deleteSchedule(schedule.id);
      schedules.drop(schedule.id); schedules.refresh();
      onOpenChange(false);
    } catch (err) { setError(err ?? new Error()); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <Dialog size="lg" className="chat-dialog">
      <Dialog.Title>{t.scheduleDeleteTitle}</Dialog.Title>
      <Dialog.Description>{t.scheduleDeleteDescription(schedule?.title ?? "")}</Dialog.Description>
      {error !== null && <p className="chat-error-text" role="alert">{describeError(error, t.scheduleDeleteFailed, language)}</p>}
      <div className="chat-dialog-actions">
        <Dialog.Close render={<Button variant="secondary" disabled={busy}>{t.cancel}</Button>} />
        <Button variant="destructive" icon={<IconTrash size={16} aria-hidden="true" />} loading={busy} onClick={() => void remove()}>{t.scheduleDelete}</Button>
      </div>
    </Dialog>
  </Dialog.Root>;
}
