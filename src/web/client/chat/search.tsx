import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CommandPalette } from "@cloudflare/kumo/components/command-palette";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { IconArrowLeft, IconBrandTelegram, IconCheck, IconChevronDown, IconEye, IconFile, IconLayoutGrid, IconMessage, IconSearch, IconX } from "@tabler/icons-react";
import type { ChatHistory, ChatThread } from "../../chat-types.js";
import { useUiLanguage } from "../i18n.js";
import { RichText } from "../rich-text.js";
import { chatApi, describeError, isAbort, MAX_SEARCH_LENGTH } from "./api.js";
import { chatFormat, useChatStrings } from "./strings.js";
import { isUnread, ThreadDate } from "./thread-list.js";

const RECENT_LIMIT = 50;
const DEBOUNCE_MS = 250;
const PREVIEW_DELAY_MS = 120;
const SNIPPET_LEAD = 36;

type Origin = "all" | ChatThread["origin"];
/** Server results always remember the query they answer. */
interface Results { query: string; items: ChatThread[]; next: number | null; more: "idle" | "loading" | "failed" }
type Preview = { status: "loading" } | { status: "ready"; history: ChatHistory } | { status: "failed"; error: unknown };

const isWorking = (thread: ChatThread) => thread.activity !== null && thread.activity.state !== "interrupted";
const previewKey = (thread: ChatThread) => `${thread.id}:${thread.searchMatch?.messageId ?? "recent"}`;

/** The words to mark: the whole query, and each word of two or more letters in it. */
export function searchTerms(query: string): string[] {
  const phrase = query.trim().toLocaleLowerCase();
  if (!phrase) return [];
  const words = phrase.split(/\s+/).filter(word => word.length > 1);
  return [...new Set([phrase, ...words])];
}

/** Case-insensitive matches of the query and its words as inclusive [start, end] ranges. */
export function matchRanges(text: string, query: string): [number, number][] {
  const haystack = text.toLocaleLowerCase();
  // Some case mappings change string length; skip highlighting rather than mark the wrong letters.
  if (haystack.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (const needle of searchTerms(query)) {
    for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) ranges.push([index, index + needle.length - 1]);
  }
  return ranges;
}

/** One line of the matching message, starting a little before the first match so it stays visible. */
export function matchSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLocaleLowerCase();
  const first = Math.min(...searchTerms(query).map(term => lower.indexOf(term)).filter(index => index >= 0));
  if (!Number.isFinite(first) || first <= SNIPPET_LEAD) return flat;
  // Start at a word boundary so the snippet does not open mid-word.
  const space = flat.lastIndexOf(" ", first - SNIPPET_LEAD);
  return `…${flat.slice(space >= 0 ? space + 1 : first - SNIPPET_LEAD)}`;
}

const narrowQuery = "(max-width: 767px)";
const subscribeNarrow = (notify: () => void) => { const media = matchMedia(narrowQuery); media.addEventListener("change", notify); return () => media.removeEventListener("change", notify); };
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(narrowQuery).matches, () => false);

export function ChatSearch({ open, onOpenChange, recent, onOpen }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recent: ChatThread[];
  onOpen: (thread: ChatThread) => void;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const format = useMemo(() => chatFormat(language), [language]);
  const headingId = useId();
  const inputId = useId();
  const narrow = useNarrow();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<Origin>("all");
  const [results, setResults] = useState<Results | null>(null);
  const [failure, setFailure] = useState<{ query: string; error: unknown } | null>(null);
  const [highlighted, setHighlighted] = useState<ChatThread | null>(null);
  /** On narrow screens the preview replaces the list; `previewing` makes taps preview instead of open. */
  const [previewing, setPreviewing] = useState(false);
  const [paneOpen, setPaneOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const moreController = useRef<AbortController | null>(null);
  const previews = useRef(new Map<string, Preview>());

  // Each opening starts fresh; closing keeps the list steady during the exit animation.
  useEffect(() => {
    if (!open) return;
    setQuery(""); setSearch(""); setResults(null); setFailure(null); setOrigin("all");
    setHighlighted(null); setPreviewing(false); setPaneOpen(false); previews.current.clear();
  }, [open]);
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
  const source = shown ? shown.items : recent.slice(0, RECENT_LIMIT);
  const threads = failed ? [] : origin === "all" ? source : source.filter(thread => thread.origin === origin);

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
    // A filter can leave the first page nearly empty; the sentinel then shows at once and keeps paging.
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMoreRef.current(); }, { root: list.current, rootMargin: "120px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, canLoadMore, origin, threads.length]);

  const now = Date.now();
  const choose = (thread: ChatThread, newTab = false) => {
    // A stale list (still typing, or results on their way) must not open an unrelated chat.
    if (pending || !threads.some(item => item.id === thread.id)) return;
    if (newTab) { window.open(`/?thread=${thread.id}`, "_blank", "noopener"); return; }
    onOpenChange(false);
    onOpen(thread);
  };
  const activate = (thread: ChatThread, newTab: boolean) => {
    if (narrow && previewing && !newTab) { setHighlighted(thread); setPaneOpen(true); return; }
    choose(thread, newTab);
  };
  const focusInput = () => requestAnimationFrame(() => document.getElementById(inputId)?.focus());
  const backToList = () => { setPaneOpen(false); focusInput(); };

  // The preview follows the highlighted row, and stays on it while newer results load.
  const previewed = highlighted ? threads.find(item => item.id === highlighted.id) ?? (pending ? highlighted : null) : null;
  const filters = [
    { value: "all", label: t.searchEverything }, { value: "web", label: t.searchWeb }, { value: "telegram", label: t.searchTelegram },
  ] satisfies { value: Origin; label: string }[];
  const filterLabel = filters.find(filter => filter.value === origin)!.label;
  const count = shown ? `${threads.length}${shown.next !== null ? "+" : ""}` : String(threads.length);
  const showPane = !narrow || paneOpen;
  const showList = !narrow || !paneOpen;

  return <CommandPalette.Dialog open={open} onOpenChange={onOpenChange}>
    <Dialog.Title className="sr-only">{t.searchChats}</Dialog.Title>
    <CommandPalette.Panel<ChatThread>
      className="chat-search"
      open={open}
      items={threads}
      value={query}
      // Choosing an item writes its title into the input; the palette is closing by then.
      onValueChange={value => { if (open) setQuery(value.slice(0, MAX_SEARCH_LENGTH)); }}
      onItemHighlighted={item => { if (item) setHighlighted(item); }}
      itemToStringValue={thread => thread.title}
      getSelectableItems={entries => pending ? [] : entries}
      onSelect={(thread, { newTab }) => choose(thread, newTab)}
    >
      <CommandPalette.Input id={inputId} className="chat-search-input" placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder} maxLength={MAX_SEARCH_LENGTH}
        leading={<IconSearch size={16} className="text-kumo-subtle" aria-hidden="true" />}
        trailing={<span className="chat-search-tools">
          {pending && <span className="chat-search-pending" role="status"><Loader size={14} /><span className="sr-only">{t.searching}</span></span>}
          {query && <Button variant="ghost" size="sm" shape="square" aria-label={t.searchClear} onClick={() => { setQuery(""); focusInput(); }}><IconX size={14} aria-hidden="true" /></Button>}
          <DropdownMenu>
            <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" className="chat-search-filter" aria-label={`${t.searchFilter}: ${filterLabel}`}>
              {filterLabel}<IconChevronDown size={14} aria-hidden="true" /></Button>} />
            <DropdownMenu.Content align="end" sideOffset={6}>
              <DropdownMenu.RadioGroup value={origin} onValueChange={(value: Origin) => setOrigin(value)}>
                {filters.map(filter => <DropdownMenu.RadioItem key={filter.value} value={filter.value} closeOnClick>
                  {filter.label}<DropdownMenu.RadioItemIndicator className="chat-search-filter-check"><IconCheck size={14} aria-hidden="true" /></DropdownMenu.RadioItemIndicator>
                </DropdownMenu.RadioItem>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu>
          <Button variant="ghost" size="sm" shape="square" aria-label={t.searchClose} onClick={() => onOpenChange(false)}><IconX size={16} aria-hidden="true" /></Button>
        </span>}
        // Enter during the debounce searches at once instead of choosing from the old list.
        onKeyDown={event => { if (event.key === "Enter" && typed !== search) setSearch(typed); }}
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" />
      <div className="chat-search-body" data-pane={narrow ? (paneOpen ? "preview" : "list") : "split"}>
        <section className="chat-search-results" aria-labelledby={headingId} hidden={!showList}>
          <div className="chat-search-heading">
            <span id={headingId}>{shown ? t.searchResults : t.searchRecent}</span>
            {!failed && !pending && threads.length > 0 && <span className="chat-search-count">{count}</span>}
          </div>
          <CommandPalette.List ref={list} className="chat-search-list">
            {failed ? <p className="chat-search-status chat-error-text" role="alert">{describeError(failure.error, t.searchFailed, language)}</p> : <>
              <CommandPalette.Results className="chat-search-options">
                {(thread: ChatThread) => {
                  const snippet = shown && thread.searchMatch ? matchSnippet(thread.searchMatch.text, shownQuery) : "";
                  return <CommandPalette.Item key={thread.id} value={thread} disabled={pending} onClick={event => activate(thread, event.metaKey || event.ctrlKey)} className="chat-search-item">
                    <span className="chat-search-icon" aria-hidden="true">{thread.origin === "telegram" ? <IconBrandTelegram size={16} /> : <IconMessage size={16} />}</span>
                    <span className="chat-search-main">
                      <span className="chat-search-line">
                        <CommandPalette.HighlightedText className="chat-search-title" text={thread.title} highlights={matchRanges(thread.title, shownQuery)} />
                        <span className="chat-search-origin">{t.originLabel(thread.origin)}</span>
                        <ThreadDate thread={thread} format={format} now={now} />
                      </span>
                      {snippet && <CommandPalette.HighlightedText className="chat-search-snippet" text={snippet} highlights={matchRanges(snippet, shownQuery)} />}
                    </span>
                    <span className="sr-only">{t.threadExtras({ origin: thread.origin, fork: thread.parentThreadId !== null, archived: thread.archived,
                      working: isWorking(thread), unread: isUnread(thread) })}</span>
                  </CommandPalette.Item>;
                }}
              </CommandPalette.Results>
              <CommandPalette.Empty>{pending ? t.searching : shown ? t.searchNoResults(shown.query) : t.searchNoRecent}</CommandPalette.Empty>
              {!pending && shown && shown.next !== null && <div ref={sentinel} className="chat-search-more" role="status">
                {shown.more === "failed" ? <button type="button" className="chat-search-retry" onClick={() => loadMore()}>{t.searchFailed} {t.retry}</button>
                  : <><Loader size={14} /><span>{t.searchMore}</span></>}
              </div>}
            </>}
          </CommandPalette.List>
        </section>
        {showPane && <SearchPreview thread={previewed} query={shownQuery} cache={previews.current} narrow={narrow}
          canOpen={previewed !== null && !pending && threads.some(item => item.id === previewed.id)}
          onOpen={() => { if (previewed) choose(previewed); }} onBack={backToList} />}
      </div>
      <CommandPalette.Footer>
        <span className="chat-search-hints" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t.searchNavigate}</span>
          <span><kbd>↵</kbd>{t.searchOpen}</span>
          <span><kbd>Esc</kbd>{t.searchClose}</span>
        </span>
        {narrow && <Button className="chat-search-mode" variant={previewing ? "secondary" : "ghost"} size="sm" aria-pressed={previewing}
          icon={previewing ? <IconEye size={14} aria-hidden="true" /> : <IconLayoutGrid size={14} aria-hidden="true" />}
          onClick={() => { setPreviewing(value => !value); setPaneOpen(false); }}>{t.searchPreview}</Button>}
      </CommandPalette.Footer>
    </CommandPalette.Panel>
  </CommandPalette.Dialog>;
}

/** A read-only look at a chat. It only reads history, so it never marks anything as read. */
function SearchPreview({ thread, query, cache, narrow, canOpen, onOpen, onBack }: {
  thread: ChatThread | null;
  query: string;
  cache: Map<string, Preview>;
  narrow: boolean;
  canOpen: boolean;
  onOpen: () => void;
  onBack: () => void;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const format = useMemo(() => chatFormat(language), [language]);
  const key = thread ? previewKey(thread) : null;
  const [, rerender] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const preview = key ? cache.get(key) ?? null : null;

  useEffect(() => {
    if (!thread || !key || cache.get(key)?.status === "ready") return;
    const controller = new AbortController();
    // Holding an arrow key moves through many rows; only the one it settles on is fetched.
    const timer = setTimeout(() => {
      cache.set(key, { status: "loading" }); rerender(value => value + 1);
      const match = thread.searchMatch;
      chatApi.history(thread.id, match ? { after: match.messageId } : null, controller.signal)
        .then(history => { cache.set(key, { status: "ready", history }); })
        .catch(error => { if (isAbort(error)) cache.delete(key); else cache.set(key, { status: "failed", error }); })
        .finally(() => { if (!controller.signal.aborted) rerender(value => value + 1); });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (cache.get(key)?.status === "loading") cache.delete(key);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the key names the thread and its match

  const matchId = thread?.searchMatch?.messageId ?? null;
  const history = preview?.status === "ready" ? preview.history : null;
  const messages = history?.messages.filter(message => message.role !== "system" && (message.text || message.attachments.length || message.openui)) ?? [];
  // Matches open at the matching message; recent chats open at their latest reply.
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !history) return;
    const target = matchId === null ? null : node.querySelector<HTMLElement>(`[data-message-id="${matchId}"]`);
    if (target) node.scrollTop = Math.max(0, target.offsetTop - 12);
    else node.scrollTop = matchId === null ? node.scrollHeight : 0;
  }, [history, matchId]);
  useHighlights(viewport, history ? query : "", history);

  return <section className="chat-search-preview" aria-labelledby={thread ? titleId : undefined} aria-label={thread ? undefined : t.searchPreview}>
    <div className="chat-search-preview-head">
      {narrow && <Button variant="ghost" size="sm" icon={<IconArrowLeft size={14} aria-hidden="true" />} onClick={onBack}>{t.searchBack}</Button>}
      {thread && <>
        <h2 id={titleId} className="chat-search-preview-title"><span className="sr-only">{t.searchPreviewLabel(thread.title)}</span><span aria-hidden="true">{thread.title}</span></h2>
        <span className="chat-search-origin">{t.originLabel(thread.origin)}</span>
        <Button variant="primary" size="sm" disabled={!canOpen} onClick={onOpen}>{t.searchOpen}</Button>
      </>}
    </div>
    <div ref={viewport} className="chat-search-preview-body" tabIndex={thread ? 0 : -1} aria-busy={preview?.status === "loading"}>
      {!thread && <p className="chat-search-preview-empty chat-muted">{t.searchPreviewEmpty}</p>}
      {thread && (!preview || preview.status === "loading") && <div className="chat-search-preview-skeleton" aria-label={t.loadingMessages}>
        {[80, 55, 70].map(width => <SkeletonLine key={width} minWidth={width - 20} maxWidth={width} />)}</div>}
      {preview?.status === "failed" && <p className="chat-search-preview-empty chat-error-text" role="alert">{describeError(preview.error, t.searchPreviewFailed, language)}</p>}
      {history && !messages.length && <p className="chat-search-preview-empty chat-muted">{t.searchPreviewNoMessages}</p>}
      {messages.map(message => {
        const assistant = message.role === "assistant";
        const matched = message.id === matchId;
        return <article key={message.id} className="chat-search-message" data-role={message.role} data-message-id={message.id} data-match={matched || undefined}>
          <header className="chat-search-message-meta">
            <span>{assistant ? t.assistant : t.you}</span>
            <time dateTime={new Date(message.createdAt).toISOString()} title={format.full(message.createdAt)}>{format.listDate(message.createdAt)}</time>
            {matched && <span className="chat-search-match-label">{t.searchPreviewMatch}</span>}
          </header>
          {message.text && <div className={assistant ? "chat-prose" : "chat-search-bubble"}><RichText text={message.text} /></div>}
          {assistant && message.openui && <p className="chat-search-chip"><IconLayoutGrid size={14} aria-hidden="true" />{t.interactiveView}</p>}
          {message.attachments.length > 0 && <ul className="chat-search-files">{message.attachments.map(file =>
            <li key={file.id} className="chat-search-chip"><IconFile size={14} aria-hidden="true" />{file.name}</li>)}</ul>}
        </article>;
      })}
    </div>
    {thread && isUnread(thread) && <p className="chat-search-preview-note">{t.searchPreviewNote}</p>}
  </section>;
}

declare global {
  // The CSS Custom Highlight API; older TypeScript DOM libraries may not declare it.
  interface Window { Highlight?: new (...ranges: Range[]) => object }
}
const HIGHLIGHT = "chat-search-match";
/** Marks the query inside rendered markdown without changing the DOM, where the browser supports it. */
function useHighlights(container: RefObject<HTMLElement | null>, query: string, content: unknown) {
  useLayoutEffect(() => {
    const registry = (globalThis.CSS as { highlights?: Map<string, object> } | undefined)?.highlights;
    const Highlight = window.Highlight;
    const root = container.current;
    if (!registry || !Highlight || !root || !searchTerms(query).length) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && ranges.length < 400; node = walker.nextNode()) {
      for (const [start, end] of matchRanges(node.textContent ?? "", query)) {
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, end + 1);
        ranges.push(range);
      }
    }
    if (ranges.length) registry.set(HIGHLIGHT, new Highlight(...ranges));
    return () => { registry.delete(HIGHLIGHT); };
  }, [container, query, content]);
}
