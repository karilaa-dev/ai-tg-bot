import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button as KumoButton } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { IconArrowLeft, IconArrowRight, IconBrain, IconCheck, IconLoader2, IconRefresh, IconTrash } from "@tabler/icons-react";
import { userLabel, type WebMemories } from "../types.js";
import { Button } from "./components/ui/button.js";
import { useSharedStrings } from "./i18n.js";

const PAGE_SIZE = 50;
type SavedMemory = WebMemories["items"][number];
const plainError = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
/** Errors stay raw so the dialog follows a language change while it is open. */
type Removal = { open: boolean; memory: SavedMemory | null; busy: boolean; error: unknown };

/**
 * `load` is scoped by the caller: admins read any person's notes, chat users only their own.
 * Only the chat passes `onDelete`, bound to the signed-in person's notes. With `page`, the
 * title opens the content column and the header keeps only navigation and refresh.
 */
export function Memories({ load, back, subtitle, leading, page = false, onDelete, describeError = plainError }: {
  load: (offset: number, signal: AbortSignal) => Promise<WebMemories>;
  back?: () => void;
  subtitle?: string;
  leading?: ReactNode;
  page?: boolean;
  onDelete?: (memoryId: number) => Promise<void>;
  describeError?: (error: unknown, fallback: string) => string;
}) {
  const t = useSharedStrings();
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<WebMemories | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [removal, setRemoval] = useState<Removal>({ open: false, memory: null, busy: false, error: null });
  const [deleted, setDeleted] = useState(false);
  // Callers pass inline loaders; key the component to change scope instead of refetching on every render.
  const loader = useRef(load);
  loader.current = load;
  // A refetch after deleting keeps the list on screen instead of flashing the loading state.
  const quiet = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const silent = quiet.current;
    quiet.current = false;
    if (!silent) setLoading(true);
    setError(null);
    void loader.current(offset, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(err => { if (!controller.signal.aborted) setError(err ?? new Error()); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, revision]);
  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(false), 4_000);
    return () => clearTimeout(timer);
  }, [deleted]);

  const remove = async () => {
    const memory = removal.memory;
    if (!onDelete || !memory || removal.busy) return;
    setRemoval(current => ({ ...current, busy: true, error: null }));
    try {
      await onDelete(memory.id);
      if (!mounted.current) return;
      setRemoval(current => ({ ...current, open: false, busy: false }));
      setDeleted(true);
      const lastOnPage = data?.items.length === 1 && offset > 0;
      setData(current => current && { ...current, total: Math.max(0, current.total - 1), items: current.items.filter(item => item.id !== memory.id) });
      // Later notes move up a row, so the page is read again; an emptied page steps back.
      if (lastOnPage) setOffset(value => Math.max(0, value - PAGE_SIZE));
      else { quiet.current = true; setRevision(value => value + 1); }
    } catch (err) {
      if (mounted.current) setRemoval(current => ({ ...current, busy: false, error: err ?? new Error() }));
    }
  };

  return <>
    <header className="pane-header memory-header">
      {leading}{back && <Button variant="ghost" size="icon-sm" aria-label={t.backToConversations} onClick={back}><IconArrowLeft aria-hidden="true" /></Button>}
      {page ? <span className="memory-header-spacer" /> : <div><h2>{t.memories}</h2><p>{subtitle ?? (data ? userLabel(data.user) : t.loading)}</p></div>}
      <Button variant={page ? "ghost" : "outline"} size="sm" disabled={loading} onClick={() => setRevision(value => value + 1)}><IconRefresh aria-hidden="true" /> {t.refresh}</Button>
    </header>
    <div className="pane-scroll memory-content" aria-busy={loading}>
      {page && <div className="memory-title"><h1>{t.memories}</h1>{subtitle && <p>{subtitle}</p>}</div>}
      {error !== null && <div className="failure" role="alert">{describeError(error, t.memoriesFailed)}<Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>{t.retry}</Button></div>}
      {loading ? <div className="loading inline-loading" role="status"><IconLoader2 className="activity-spinner" size={16} aria-hidden="true" /> {t.loadingMemories}</div> : error === null && data && <>
        <div className="memory-toolbar">
          <p className="memory-status">{t.savedNotes(data.total)}</p>
          <Badge className="settings-badge" variant={data.enabled ? "success" : "neutral"} appearance="dot">{data.enabled ? t.memoryOn : t.memoryOff}</Badge>
          <span className="memory-notice" role="status" aria-live="polite">{deleted && <><IconCheck size={14} aria-hidden="true" />{t.memoryDeleted}</>}</span>
          <span className="memory-sort">{t.oldestFirst}</span>
        </div>
        {!data.enabled && <p className="memory-disabled">{t.memoryDisabled}</p>}
        {data.items.length ? <ol className="memory-list" aria-label={t.savedMemories}>{data.items.map(memory => <li key={memory.id}>
          <p>{memory.text}</p>
          <div className="memory-meta"><span>{t.note(memory.id)} · {memory.date}</span>
            {onDelete && <Button className="memory-delete" variant="ghost" size="icon-sm" aria-label={t.deleteNote(memory.id)} title={t.deleteNote(memory.id)}
              onClick={() => setRemoval({ open: true, memory, busy: false, error: null })}><IconTrash aria-hidden="true" /></Button>}</div>
        </li>)}</ol> : <div className="notice"><IconBrain aria-hidden="true" /><h3>{data.total ? t.noNotesOnPage : t.noMemories}</h3><p>{data.total ? t.earlierPage : t.noMemoriesHint}</p></div>}
        {(offset > 0 || data.nextOffset !== null) && <nav className="memory-pagination" aria-label={t.memoryPages}>
          <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}><IconArrowLeft aria-hidden="true" /> {t.previous}</Button>
          <span>{t.page(Math.floor(offset / PAGE_SIZE) + 1, Math.max(1, Math.ceil(data.total / PAGE_SIZE)))}</span>
          <Button variant="outline" disabled={data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) setOffset(data.nextOffset); }}>{t.next} <IconArrowRight aria-hidden="true" /></Button>
        </nav>}
      </>}
    </div>
    {onDelete && <Dialog.Root open={removal.open} onOpenChange={open => { if (!removal.busy) setRemoval(current => ({ ...current, open })); }}>
      <Dialog size="lg" className="chat-dialog">
        <Dialog.Title>{t.deleteMemoryTitle}</Dialog.Title>
        <Dialog.Description>{t.deleteMemoryDescription}</Dialog.Description>
        {removal.memory && <blockquote className="chat-dialog-quote memory-dialog-quote">{removal.memory.text}</blockquote>}
        {removal.error !== null && <p className="chat-error-text" role="alert">{describeError(removal.error, t.memoryDeleteFailed)}</p>}
        <div className="chat-dialog-actions">
          <Dialog.Close render={<KumoButton variant="secondary" disabled={removal.busy}>{t.cancel}</KumoButton>} />
          <KumoButton variant="destructive" icon={<IconTrash size={16} aria-hidden="true" />} loading={removal.busy} onClick={() => void remove()}>{t.delete}</KumoButton>
        </div>
      </Dialog>
    </Dialog.Root>}
  </>;
}
