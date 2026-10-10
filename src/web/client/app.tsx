import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button as BaseButton } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { Collapsible } from "@base-ui/react/collapsible";
import { ArrowDown, ArrowLeft, MessageSquare, Search, Users, GitFork, Sun, Moon, ChartNoAxesCombined, KeyRound, LogOut, LockKeyhole, ChevronRight, ChevronDown, Brain, Archive, Bot, FolderOpen, LoaderCircle } from "lucide-react";
import { AdminGate } from "./auth.js";
import { BrandMark, logo } from "./brand.js";
import { apiJson } from "./api.js";
import { Memories } from "./memories.js";
import { CodexConnection } from "./codex-connection.js";
import { userLabel, type WebHistory, type WebMessage, type WebPage, type WebThread, type WebUser } from "../types.js";
import { AttachmentLoader, type LoadedAttachment } from "./attachments.js";
import { RichText } from "./rich-text.js";
import { Button } from "./components/ui/button.js";
import { FileAttachment } from "./file-attachment.js";
import { cn } from "./lib/utils.js";
import { ThreadActivity, activityLabel } from "./thread-activity.js";
import { MessageUsage, ThreadUsage, UsageDashboard } from "./usage.js";

async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  return apiJson<T>(url, { signal });
}
const timestamp = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });


function Notice({ title, description }: { title: string; description: string }) {
  return <div className="notice"><h3>{title}</h3><p>{description}</p></div>;
}
function Loading() { return <div className="loading" role="status"><LoaderCircle className="activity-spinner" size={16} aria-hidden="true" />Loading…</div>; }
function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="failure" role="alert">{message}{retry && <Button variant="outline" size="sm" onClick={retry}>Retry</Button>}</div>;
}

function selection() {
  const params = new URLSearchParams(location.search);
  const parse = (name: string) => { const value = Number(params.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : null; };
  const threadId = parse("thread");
  const usage = params.get("view") === "usage";
  return { userId: parse("user"), threadId, memories: Boolean(parse("user") && !threadId && params.get("view") === "memories"), codex: params.get("view") === "codex", usage: !threadId && usage,
    threadUsage: Boolean(threadId && (params.get("usage") === "thread" || usage)) };
}

function usePages<T extends { id: number }>(url: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const count = useRef(1);
  const more = useCallback(() => { count.current++; setRevision(v => v + 1); }, []);
  useEffect(() => { if (url) { count.current = 1; setItems([]); setNext(null); } }, [url]);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      setLoading(true);
      try {
        const all: T[] = [];
        let offset: number | null = 0;
        for (let page = 0; page < count.current && offset !== null; page++) {
          const result: WebPage<T> = await get(`${url}${url.includes("?") ? "&" : "?"}offset=${offset}`, controller.signal);
          all.push(...result.items);
          offset = result.nextOffset;
        }
        if (!controller.signal.aborted) { setItems([...new Map(all.map(item => [item.id, item])).values()]); setNext(offset); setError(""); }
      } catch (err) { if (!controller.signal.aborted) setError(String(err instanceof Error ? err.message : err)); }
      finally { busy = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    const interval = setInterval(() => void load(), 10_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [url, revision]);
  return { items, next, more, error, loading, retry: () => setRevision(v => v + 1) };
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.mode === "dark");
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.mode === "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => observer.disconnect();
  }, []);
  return <Button variant="ghost" size="icon-sm" aria-label={`Switch to ${dark ? "light" : "dark"} theme`} title={`Switch to ${dark ? "light" : "dark"} theme`} onClick={() => window.dispatchEvent(new Event("conversation-theme"))}>{dark ? <Sun /> : <Moon />}</Button>;
}

function App({ logout, signingOut, logoutError }: { logout: () => Promise<void>; signingOut: boolean; logoutError: string }) {
  const [selected, setSelected] = useState(selection);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const users = usePages<WebUser>(selected.usage || selected.codex ? null : `/api/users?q=${encodeURIComponent(query)}`);
  const threads = usePages<WebThread>(selected.userId && !selected.usage && !selected.codex ? `/api/users/${selected.userId}/threads` : null);
  const user = users.items.find(u => u.id === selected.userId);
  useEffect(() => { const timeout = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timeout); }, [search]);
  useEffect(() => { const pop = () => setSelected(selection()); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  const navigate = (userId: number | null, threadId: number | null, usage = false) => {
    const params = new URLSearchParams();
    if (userId) params.set("user", String(userId));
    if (threadId) params.set("thread", String(threadId));
    if (usage) { if (threadId) params.set("usage", "thread"); else params.set("view", "usage"); }
    history.pushState(null, "", `/${params.size ? `?${params}` : ""}`);
    setSelected({ userId, threadId, memories: false, codex: false, usage: !threadId && usage, threadUsage: Boolean(threadId && usage) });
  };
  const openCodex = () => { history.pushState(null, "", "/?view=codex"); setSelected(selection()); };
  const openMemories = () => { history.pushState(null, "", `/?user=${selected.userId}&view=memories`); setSelected(selection()); };
  const screen = selected.memories ? "messages" : selected.codex ? "codex" : selected.usage ? "usage" : selected.threadId ? "messages" : selected.userId ? "threads" : "users";
  const view = selected.codex ? "codex" : selected.usage ? "usage" : "conversations";
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <nav className="app-navigation" aria-label="Main navigation">
      <a className="nav-brand" href="/" aria-label="AI KaRiLaA home" onClick={event => { event.preventDefault(); navigate(null, null); }}><BrandMark /><span>AI KaRiLaA</span><span className="nav-brand-divider" /><span className="nav-workspace-label">Workspace</span></a>
      <div className="nav-destinations">
        <BaseButton className="nav-item" aria-current={view === "conversations" ? "page" : undefined} onClick={() => navigate(null, null)}><MessageSquare /><span>Conversations</span></BaseButton>
        <BaseButton className="nav-item" aria-current={view === "usage" ? "page" : undefined} onClick={() => navigate(null, null, true)}><ChartNoAxesCombined /><span>Usage</span></BaseButton>
        <BaseButton className="nav-item" aria-current={view === "codex" ? "page" : undefined} onClick={openCodex}><KeyRound /><span>Codex</span></BaseButton>
      </div>
      <div className="nav-account"><span className="nav-private" title="Private admin session"><LockKeyhole size={13} /><span>Admin</span></span><ThemeToggle /><BaseButton className="nav-item nav-logout" onClick={() => void logout()} disabled={signingOut} aria-label={signingOut ? "Signing out" : "Sign out"}><LogOut /><span>{signingOut ? "Signing out" : "Sign out"}</span></BaseButton></div>
    </nav>
    <div className="workspace" data-screen={screen} data-view={view}>
    {view === "conversations" && <>
    <aside className="users-pane pane" aria-label="People">
      <header className="brand"><div><h1>Conversations</h1><p>Your bot’s conversation archive</p></div></header>
      <div className="pane-tools"><label className="search-label" htmlFor="user-search"><Search size={16} aria-hidden="true" /><Input id="user-search" type="search" aria-label="Find a person" placeholder="Search people…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      <div className="list-caption"><Users className="size-3.5" /><span>People</span><span className="list-count">{users.items.length}{users.next !== null ? "+" : ""}</span></div>
      <div className="pane-scroll">
        {users.error && <Failure message={users.error} retry={users.retry} />}
        {!users.items.length && users.loading ? <Loading /> : !users.items.length && !users.error ? <Notice title={query ? "No matching people" : "Your inbox starts here"} description={query ? "Try a name, username, or Telegram ID." : "People appear here after they message your Telegram bot."} /> : null}
        <div className="user-list">{users.items.map(u => <BaseButton key={u.id} className={cn("user-row", selected.userId === u.id && "selected")} onClick={() => navigate(u.id, null)} aria-current={selected.userId === u.id ? "true" : undefined}>
          <span className="initial" aria-hidden="true">{(u.name || u.username || "?").slice(0, 1).toUpperCase()}</span><span className="user-copy"><strong>{userLabel(u)}</strong>{u.username && u.name && <span>{u.name}</span>}<small>{u.threadCount} {u.threadCount === 1 ? "conversation" : "conversations"}</small><time dateTime={new Date(u.lastActivity).toISOString()}>{timestamp(u.lastActivity)}</time></span><ChevronRight size={14} className="user-chevron" aria-hidden="true" />
        </BaseButton>)}</div>
        {users.next !== null && <Button className="m-4" variant="outline" onClick={users.more} disabled={users.loading}>Load more people</Button>}
      </div>
      <footer className="pane-footer"><span className="status-dot" aria-hidden="true" /> Updates automatically</footer>
    </aside>
    <aside className="threads-pane pane" aria-label="Conversations">
      <header className="pane-header"><Button className="mobile-back" variant="ghost" size="icon-sm" aria-label="Back to people" onClick={() => navigate(null, null)}><ArrowLeft /></Button><div><h2>{user ? userLabel(user) : "Threads"}</h2><p>{selected.userId ? `Telegram ID ${selected.userId}` : "Select a person"}</p></div></header>
      {selected.userId && <div className="person-usage"><Button variant="ghost" onClick={openMemories} aria-pressed={selected.memories}><Brain /> Memories</Button><Button variant="ghost" onClick={() => navigate(selected.userId, null, true)}><ChartNoAxesCombined /> Usage</Button></div>}
      <div className="pane-scroll thread-list">
        {threads.error && <Failure message={threads.error} retry={threads.retry} />}
        {!selected.userId ? <Notice title="Choose a person" description="Their conversations will appear here." /> : !threads.items.length && threads.loading ? <Loading /> : !threads.items.length ? <Notice title="No conversations yet" description="This person has no saved conversations." /> : <div className="conversation-list">{threads.items.map(t => <BaseButton key={t.id} className={cn("thread-row", selected.threadId === t.id && "selected")} aria-current={selected.threadId === t.id ? "true" : undefined} onClick={() => navigate(selected.userId, t.id)}>
          <span className="thread-icon" aria-hidden="true">{t.archived ? <Archive size={17} /> : <MessageSquare size={17} />}</span>
          <span className="thread-copy"><strong>{t.title}</strong><time dateTime={new Date(t.lastActivity).toISOString()}>{new Date(t.lastActivity).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
            {(t.archived || t.parentThreadId) && <span className="thread-labels">{t.archived && <span>Archived</span>}{t.parentThreadId && <span><GitFork size={13} /> Fork</span>}</span>}
            {!threads.error && t.activity && <span className="thread-row-activity"><span className="status-dot" />{activityLabel(t.activity)}</span>}
          </span>
        </BaseButton>)}</div>}
        {threads.next !== null && <Button variant="outline" className="mt-4" disabled={threads.loading} onClick={threads.more}>Load more conversations</Button>}
      </div>
      <footer className="pane-footer"><Archive size={14} aria-hidden="true" /> Archived threads included</footer>
    </aside>
    </>}
    <main id="main-content" tabIndex={-1} className="messages-pane pane" aria-label={selected.memories ? "Saved memories" : selected.codex ? "Codex connection" : selected.usage ? "Usage statistics" : "Message history"}>
      {logoutError && <div className="failure global-error" role="alert">{logoutError}</div>}
      {selected.memories && selected.userId ? <Memories key={selected.userId} userId={selected.userId} back={() => navigate(selected.userId, null)} /> : selected.codex ? <CodexConnection /> : selected.usage ? <UsageDashboard key={selected.userId} userId={selected.userId} title={selected.userId ? user ? userLabel(user) : `Telegram ID ${selected.userId}` : "All conversations"} back={() => navigate(selected.userId, null)} all={() => navigate(null, null, true)} openThread={navigate} /> : selected.threadId ? <Transcript key={selected.threadId} threadId={selected.threadId} back={() => navigate(selected.userId, null)} showUsage={selected.threadUsage} /> : <><header className="pane-header"><div><h2>Conversation archive</h2><p>Messages, files, and response details</p></div><span className="read-only-label"><LockKeyhole size={13} /> Read-only</span></header><div className="welcome"><div className="welcome-mark"><FolderOpen size={28} aria-hidden="true" /></div><Notice title={selected.userId ? "Select a conversation" : "A closer look at every conversation"} description={selected.userId ? "Choose a thread to view its messages and shared files." : "Choose a person, then a conversation. Everything your bot has saved is here."} /><div className="welcome-features"><span><MessageSquare /> Message history</span><span><Brain /> Saved thinking</span><span><ChartNoAxesCombined /> Response usage</span></div></div><footer className="transcript-footer"><LockKeyhole size={14} aria-hidden="true" /> Private admin workspace</footer></>}
    </main>
    </div>
  </div>;
}

function Transcript({ threadId, back, showUsage }: { threadId: number; back: () => void; showUsage: boolean }) {
  const [data, setData] = useState<WebHistory | null>(null);
  const dataRef = useRef<WebHistory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [files, setFiles] = useState(new Map<number, LoadedAttachment>());
  const [loader] = useState(() => new AttachmentLoader(threadId, setFiles));
  const controller = useRef<AbortController | null>(null);
  const fetching = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef<{ top: number; height: number } | null>(null);
  const positioned = useRef(false);
  const [canJump, setCanJump] = useState(false);
  const checkScroll = () => {
    const node = viewport.current;
    if (node) setCanJump(node.scrollHeight - node.scrollTop - node.clientHeight > 40);
  };
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !data) return;
    if (scrollPosition.current) {
      node.scrollTop = scrollPosition.current.top + node.scrollHeight - scrollPosition.current.height;
      scrollPosition.current = null;
    } else if (!positioned.current) {
      node.scrollTop = node.scrollHeight;
      positioned.current = true;
    }
    checkScroll();
  }, [data?.messages]);
  useEffect(() => {
    const content = viewport.current?.firstElementChild;
    if (!content) return;
    const observer = new ResizeObserver(checkScroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [Boolean(data)]);
  const load = useCallback(async (older = false) => {
    if (fetching.current || !controller.current || controller.current.signal.aborted) return;
    fetching.current = true; setBusy(true);
    const signal = controller.current.signal;
    try {
      const previous = dataRef.current;
      let cursor: number | null = older ? previous?.olderCursor ?? null : previous?.messages.slice(-50)[0]?.id ?? null;
      let latest: WebHistory;
      const received: WebMessage[] = [];
      do {
        latest = await get<WebHistory>(`/api/threads/${threadId}/messages${cursor === null ? "" : `?${older ? "before" : "after"}=${cursor}`}`, signal);
        received.push(...latest.messages);
        cursor = older ? null : latest.newerCursor;
      } while (cursor !== null);
      if (signal.aborted) return;
      const messages = [...new Map([...(previous?.messages ?? []), ...received].map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id);
      const merged = { ...latest, messages, olderCursor: older || !previous ? latest.olderCursor : previous.olderCursor };
      if (older && viewport.current) scrollPosition.current = { top: viewport.current.scrollTop, height: viewport.current.scrollHeight };
      dataRef.current = merged; setData(merged); setError("");
    } catch (err) { if (!signal.aborted) setError(err instanceof Error ? err.message : "Could not load this conversation."); }
    finally { fetching.current = false; if (!signal.aborted) setBusy(false); }
  }, [threadId]);
  useEffect(() => {
    controller.current = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await load();
      if (!stopped) timer = setTimeout(() => void poll(), dataRef.current?.thread.activity ? 3_000 : 10_000);
    };
    void poll();
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; controller.current?.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load, revision]);
  useEffect(() => () => loader.dispose(), [loader]);
  useEffect(() => {
    if (!data || data.autoLoadMaxBytes === 0) return;
    for (const message of data.messages) for (const file of message.attachments) {
      if (file.size !== null && file.size <= data.autoLoadMaxBytes) loader.load(file, "auto");
    }
  }, [data, loader]);
  return <>
    <header className="pane-header conversation-header"><Button className="mobile-back" variant="ghost" size="icon-sm" aria-label="Back to conversations" onClick={back}><ArrowLeft /></Button><div><h2>{data?.thread.title ?? "Conversation"}</h2><p>{data ? `${userLabel(data.user)}${data.user.username && data.user.name ? ` · ${data.user.name}` : ""} · Telegram ID ${data.user.id}` : "Loading messages"}</p><ThreadActivity activity={data?.thread.activity} unavailable={Boolean(error && data)} /></div>{data?.thread.archived && <span className="archive-label">Archived</span>}</header>
    {error && <div className="px-5"><Failure message={error} retry={() => setRevision(v => v + 1)} /></div>}
    <ThreadUsage threadId={threadId} initiallyOpen={showUsage} />
    {!data ? !error && <Loading /> : <>
      {data.thread.parentThreadId && <div className="fork-note"><GitFork className="size-3.5" />Forked history · Inherited messages are labeled below</div>}
      <div className="message-scroller">
        <div ref={viewport} className="message-viewport" tabIndex={0} aria-label="Conversation messages" onScroll={checkScroll}><div className="transcript" aria-live="off">
          {data.olderCursor !== null && <div className="flex justify-center"><Button variant="outline" disabled={busy} onClick={() => void load(true)}>Load older</Button></div>}
          {!data.messages.length && <Notice title="No messages yet" description="Saved messages will appear here as this conversation continues." />}
          {data.messages.map((message, index) => <div key={message.id} data-message-id={message.id}>
            {(message.threadId !== data.messages[index - 1]?.threadId && (message.threadId !== threadId || index > 0)) && <div className="history-boundary">{message.threadId === threadId ? "This conversation" : `Inherited from ${data.chain.find(t => t.id === message.threadId)?.title ?? "parent conversation"}`}</div>}
            <article className="message" data-role={message.role}>
              <header>{message.role === "assistant" && <Bot size={16} aria-hidden="true" />}{message.role === "user" ? userLabel(data.user) : message.role === "assistant" ? "Bot" : "System"}</header>
              {message.thinking && <Collapsible.Root className="thinking"><Collapsible.Trigger className="disclosure-trigger"><Brain size={15} /> Thinking <ChevronDown size={15} /></Collapsible.Trigger><Collapsible.Panel hiddenUntilFound><div className="thinking-content"><RichText text={message.thinking} /></div></Collapsible.Panel></Collapsible.Root>}
              {message.text && <div className="message-bubble"><RichText text={message.text} /></div>}
              {message.attachments.map(file => <FileAttachment key={file.id} file={file} messageText={message.text} messageAttachments={message.attachments} state={files.get(file.id)} maxBytes={data.maxFileBytes} load={(allowSandbox = false) => loader.load(file, "download", true, allowSandbox)} />)}
              <footer><time dateTime={new Date(message.createdAt).toISOString()}>{timestamp(message.createdAt)}</time></footer>
              {message.role === "assistant" && <MessageUsage usage={message.usage} />}
            </article>
          </div>)}
        </div></div>{canJump && <Button className="jump-to-latest" variant="outline" size="icon-sm" aria-label="Jump to latest" onClick={() => { const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; }}><ArrowDown /></Button>}
      </div>
      <footer className="transcript-footer">{data.messages.length} messages loaded · {data.thread.activity ? "Checking active response every 3 seconds" : "Refreshes every 10 seconds"}</footer>
    </>}
  </>;
}

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) favicon.href = logo;
const container = document.getElementById("root")!;
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(<AdminGate>{(logout, signingOut, logoutError) => <App logout={logout} signingOut={signingOut} logoutError={logoutError} />}</AdminGate>);
