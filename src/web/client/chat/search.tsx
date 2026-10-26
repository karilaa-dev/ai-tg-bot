import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "@cloudflare/kumo/components/command-palette";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Loader } from "@cloudflare/kumo/components/loader";
import { IconSearch } from "@tabler/icons-react";
import type { ChatThread } from "../../chat-types.js";
import { useUiLanguage } from "../i18n.js";
import { chatApi, describeError, isAbort, MAX_SEARCH_LENGTH } from "./api.js";
import { chatFormat, useChatStrings } from "./strings.js";
import { groupLabel, groupThreads } from "./thread-groups.js";
import { ThreadDate, ThreadOrigin } from "./thread-list.js";

const RECENT_LIMIT = 50;
const DEBOUNCE_MS = 250;

/** Server results always remember the query they answer. */
interface Results { query: string; items: ChatThread[]; next: number | null; more: "idle" | "loading" | "failed" }
/** Palette groups; Base UI treats objects with an `items` array as groups. */
interface SearchGroup { key: string; label: string; items: ChatThread[] }
type Entry = SearchGroup | ChatThread;

/** Case-insensitive title matches as inclusive [start, end] ranges. */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = query.trim().toLocaleLowerCase();
  const haystack = text.toLocaleLowerCase();
  // Some case mappings change string length; skip highlighting rather than mark the wrong letters.
  if (!needle || haystack.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) ranges.push([index, index + needle.length - 1]);
  return ranges;
}

export function ChatSearch({ open, onOpenChange, recent, onOpen }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recent: ChatThread[];
  onOpen: (thread: ChatThread) => void;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const format = useMemo(() => chatFormat(language), [language]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [failure, setFailure] = useState<{ query: string; error: unknown } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const moreController = useRef<AbortController | null>(null);

  // Each opening starts fresh; closing keeps the list steady during the exit animation.
  useEffect(() => { if (open) { setQuery(""); setSearch(""); setResults(null); setFailure(null); } }, [open]);
  const typed = query.trim();
  useEffect(() => {
    if (typed === search) return;
    const timer = setTimeout(() => setSearch(typed), typed ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [typed, search]);

  useEffect(() => {
    moreController.current?.abort();
    if (!open || !search) { setResults(null); setFailure(null); return; }
    const controller = new AbortController();
    chatApi.threads(0, controller.signal, search)
      .then(page => { if (!controller.signal.aborted) { setResults({ query: search, items: page.items, next: page.nextOffset, more: "idle" }); setFailure(null); } })
      .catch(error => { if (!controller.signal.aborted && !isAbort(error)) setFailure({ query: search, error }); });
    return () => controller.abort();
  }, [open, search]);

  // The list on screen answers `shownQuery`; until it answers what was typed, nothing in it can be chosen.
  const failed = failure !== null && failure.query === typed;
  const shown = typed ? results : null;
  const shownQuery = shown?.query ?? "";
  const pending = !failed && typed !== shownQuery;
  const threads = shown ? shown.items : recent.slice(0, RECENT_LIMIT);

  const loadMore = () => {
    if (pending || !results || results.next === null || results.more === "loading") return;
    const { query: current, next } = results;
    const controller = new AbortController();
    moreController.current?.abort();
    moreController.current = controller;
    setResults({ ...results, more: "loading" });
    chatApi.threads(next, controller.signal, current)
      .then(page => {
        if (controller.signal.aborted) return;
        setResults(previous => previous?.query === current ? {
          ...previous, more: "idle", next: page.nextOffset,
          items: [...new Map([...previous.items, ...page.items].map(thread => [thread.id, thread])).values()],
        } : previous);
      })
      .catch(error => {
        if (controller.signal.aborted || isAbort(error)) return;
        setResults(previous => previous?.query === current ? { ...previous, more: "failed" } : previous);
      });
  };
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => () => moreController.current?.abort(), []);
  const canLoadMore = !pending && shown !== null && shown.next !== null && shown.more === "idle";
  useEffect(() => {
    const target = sentinel.current;
    if (!open || !canLoadMore || !target) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMoreRef.current(); }, { root: list.current, rootMargin: "120px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, canLoadMore]);

  const now = Date.now();
  const groups: SearchGroup[] = failed ? [] : groupThreads(threads, now).map(group => ({ key: group.key, label: groupLabel(group.group, t, format, now), items: group.threads }));
  const choose = (thread: ChatThread, newTab = false) => {
    // A stale list (still typing, or results on their way) must not open an unrelated chat.
    if (pending || !threads.some(item => item.id === thread.id)) return;
    if (newTab) { window.open(`/?thread=${thread.id}`, "_blank", "noopener"); return; }
    onOpenChange(false);
    onOpen(thread);
  };

  return <CommandPalette.Root<Entry, ChatThread>
    open={open}
    onOpenChange={onOpenChange}
    items={groups}
    value={query}
    // Choosing an item writes its title into the input; the palette is closing by then.
    onValueChange={value => { if (open) setQuery(value.slice(0, MAX_SEARCH_LENGTH)); }}
    itemToStringValue={entry => "items" in entry ? entry.label : entry.title}
    getSelectableItems={entries => pending ? [] : entries.flatMap(entry => "items" in entry ? entry.items : [entry])}
    onSelect={(thread, { newTab }) => choose(thread, newTab)}
  >
    <Dialog.Title className="sr-only">{t.searchChats}</Dialog.Title>
    <CommandPalette.Input className="chat-search-input" placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder} maxLength={MAX_SEARCH_LENGTH}
      leading={<IconSearch size={16} className="text-kumo-subtle" aria-hidden="true" />}
      trailing={pending ? <span className="chat-search-pending" role="status"><Loader size={14} /><span className="sr-only">{t.searching}</span></span> : undefined}
      // Enter during the debounce searches at once instead of choosing from the old list.
      onKeyDown={event => { if (event.key === "Enter" && typed !== search) setSearch(typed); }}
      autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" />
    <CommandPalette.List ref={list} className="chat-search-list">
      {failed ? <p className="chat-search-status chat-error-text" role="alert">{describeError(failure.error, t.searchFailed, language)}</p> : <>
        <CommandPalette.Results>
          {(group: SearchGroup) => <CommandPalette.Group key={group.key} items={group.items}>
            <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
            <CommandPalette.Items>
              {(thread: ChatThread) => <CommandPalette.Item key={thread.id} value={thread} disabled={pending} onClick={event => choose(thread, event.metaKey || event.ctrlKey)} className="chat-search-item">
                <ThreadOrigin thread={thread} />
                <CommandPalette.HighlightedText className="chat-search-title" text={thread.title} highlights={matchRanges(thread.title, shownQuery)} />
                <ThreadDate thread={thread} format={format} now={now} />
                <span className="sr-only">{t.threadExtras({ origin: thread.origin, fork: thread.parentThreadId !== null, archived: thread.archived,
                  working: thread.activity !== null && thread.activity.state !== "interrupted", unread: thread.unread })}</span>
              </CommandPalette.Item>}
            </CommandPalette.Items>
          </CommandPalette.Group>}
        </CommandPalette.Results>
        <CommandPalette.Empty>{pending ? t.searching : shown ? t.searchNoResults(shown.query) : t.searchNoRecent}</CommandPalette.Empty>
        {!pending && shown && shown.next !== null && <div ref={sentinel} className="chat-search-more" role="status">
          {shown.more === "failed" ? <button type="button" className="chat-search-retry" onClick={() => loadMore()}>{t.searchFailed} {t.retry}</button>
            : <><Loader size={14} /><span>{t.searchMore}</span></>}
        </div>}
      </>}
    </CommandPalette.List>
    <CommandPalette.Footer>
      <span className="chat-search-hints">
        <span><kbd>↑</kbd><kbd>↓</kbd>{t.searchNavigate}</span>
        <span><kbd>↵</kbd>{t.searchOpen}</span>
        <span><kbd>Esc</kbd>{t.searchClose}</span>
      </span>
    </CommandPalette.Footer>
  </CommandPalette.Root>;
}
