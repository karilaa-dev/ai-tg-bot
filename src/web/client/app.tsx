import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { ArrowDown, ArrowLeft, MessageSquare, Search, Users, GitFork, Sun, Moon } from "lucide-react";
import { userLabel, type WebHistory, type WebMessage, type WebPage, type WebThread, type WebUser } from "../types.js";
import { AttachmentLoader, type LoadedAttachment } from "./attachments.js";
import { HookSidebar } from "./components/ui/hook-sidebar.js";
import { RichText } from "./rich-text.js";
import { Button } from "./components/ui/button.js";
import { FileAttachment } from "./file-attachment.js";
import { cn } from "./lib/utils.js";

async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not load conversations.");
  return body as T;
}
const timestamp = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });


function Notice({ title, description }: { title: string; description: string }) {
  return <div className="notice"><h3>{title}</h3><p>{description}</p></div>;
}
function Loading() { return <div className="loading" role="status">Loading…</div>; }
function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="failure" role="alert">{message}{retry && <Button variant="outline" size="sm" onClick={retry}>Retry</Button>}</div>;
}

function selection() {
  const params = new URLSearchParams(location.search);
  const parse = (name: string) => { const value = Number(params.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : null; };
  return { userId: parse("user"), threadId: parse("thread") };
}

function usePages<T extends { id: number }>(url: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const count = useRef(1);
  const more = useCallback(() => { count.current++; setRevision(v => v + 1); }, []);
  useEffect(() => { count.current = 1; setItems([]); setNext(null); }, [url]);
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
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return <Button className="theme-toggle" variant="ghost" size="icon-sm" aria-label={`Switch to ${dark ? "light" : "dark"} theme`} title={`Switch to ${dark ? "light" : "dark"} theme`} onClick={() => window.dispatchEvent(new Event("conversation-theme"))}>{dark ? <Sun /> : <Moon />}</Button>;
}

function App() {
  const [selected, setSelected] = useState(selection);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const users = usePages<WebUser>(`/api/users?q=${encodeURIComponent(query)}`);
  const threads = usePages<WebThread>(selected.userId ? `/api/users/${selected.userId}/threads` : null);
  const user = users.items.find(u => u.id === selected.userId);
  useEffect(() => { const timeout = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timeout); }, [search]);
  useEffect(() => { const pop = () => setSelected(selection()); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  const navigate = (userId: number | null, threadId: number | null) => {
    const params = new URLSearchParams();
    if (userId) params.set("user", String(userId));
    if (threadId) params.set("thread", String(threadId));
    history.pushState(null, "", `/${params.size ? `?${params}` : ""}`);
    setSelected({ userId, threadId });
  };
  const screen = selected.threadId ? "messages" : selected.userId ? "threads" : "users";
  return <MotionConfig reducedMotion="user"><div className="app-shell" data-screen={screen}>
    <aside className="users-pane pane" aria-label="Users">
      <header className="brand"><MessageSquare aria-hidden="true" /><div><h1>Conversations</h1><p>Telegram bot archive</p></div><ThemeToggle /></header>
      <div className="pane-tools"><label htmlFor="user-search"><Search className="size-3.5" /> Find a person</label><input id="user-search" placeholder="Name, username or ID" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="list-caption"><Users className="size-3.5" /><span>Most recently active</span></div>
      <div className="pane-scroll">
        {users.error && <Failure message={users.error} retry={users.retry} />}
        {!users.items.length && users.loading ? <Loading /> : !users.items.length ? <Notice title="No users found" description={query ? "Try another name or username." : "People will appear here after they message the bot."} /> : null}
        <div className="user-list">{users.items.map(u => <button key={u.id} className={cn("user-row", selected.userId === u.id && "selected")} onClick={() => navigate(u.id, null)} aria-current={selected.userId === u.id ? "true" : undefined}>
          <span className="initial" aria-hidden="true">{(u.name || u.username || "?").slice(0, 1).toUpperCase()}</span><span className="user-copy"><strong>{userLabel(u)}</strong>{u.username && u.name && <span>{u.name}</span>}<small>{u.threadCount} {u.threadCount === 1 ? "conversation" : "conversations"} · {timestamp(u.lastActivity)}</small></span>
        </button>)}</div>
        {users.next !== null && <Button className="m-4" variant="outline" onClick={users.more} disabled={users.loading}>Load more users</Button>}
      </div>
      <footer className="pane-footer">Read-only archive</footer>
    </aside>
    <aside className="threads-pane pane" aria-label="Conversations">
      <header className="pane-header"><Button className="mobile-back" variant="ghost" size="icon-sm" aria-label="Back to users" onClick={() => navigate(null, null)}><ArrowLeft /></Button><div><h2>{user ? userLabel(user) : "Conversations"}</h2><p>{selected.userId ? `Telegram ID ${selected.userId}` : "Choose a person to begin"}</p></div><ThemeToggle /></header>
      <div className="pane-scroll thread-list">
        {threads.error && <Failure message={threads.error} retry={threads.retry} />}
        {!selected.userId ? <Notice title="Choose a person" description="Their conversations will appear here." /> : !threads.items.length && threads.loading ? <Loading /> : !threads.items.length ? <Notice title="No conversations yet" description="This person has no saved conversations." /> : <HookSidebar aria-label="Conversation list" color="var(--primary)" dashed={false} items={threads.items.map(t => ({ label: `${t.title}${t.archived ? " · Archived" : ""}${t.parentThreadId ? " · Fork" : ""}` }))} value={threads.items.findIndex(t => t.id === selected.threadId)} onChange={index => navigate(selected.userId, threads.items[index]!.id)} />}
        {threads.next !== null && <Button variant="outline" className="mt-4" disabled={threads.loading} onClick={threads.more}>Load more conversations</Button>}
      </div>
      <footer className="pane-footer">Newest activity first · Includes archived</footer>
    </aside>
    <main className="messages-pane pane" aria-label="Message history">
      {selected.threadId ? <Transcript key={selected.threadId} threadId={selected.threadId} back={() => navigate(selected.userId, null)} /> : <div className="welcome"><MessageSquare className="size-12" /><Notice title="A place to catch up" description="Open a conversation to read its messages, thinking, and shared files." /></div>}
    </main>
  </div></MotionConfig>;
}

function Transcript({ threadId, back }: { threadId: number; back: () => void }) {
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
    void load();
    const interval = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.current?.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [load, revision]);
  useEffect(() => () => loader.dispose(), [loader]);
  useEffect(() => {
    if (!data || data.autoLoadMaxBytes === 0) return;
    for (const message of data.messages) for (const file of message.attachments) {
      if (file.size !== null && file.size <= data.autoLoadMaxBytes) loader.load(file, "auto");
    }
  }, [data, loader]);
  return <>
    <header className="pane-header conversation-header"><Button className="mobile-back" variant="ghost" size="icon-sm" aria-label="Back to conversations" onClick={back}><ArrowLeft /></Button><div><h2>{data?.thread.title ?? "Conversation"}</h2><p>{data ? `${userLabel(data.user)}${data.user.username && data.user.name ? ` · ${data.user.name}` : ""} · Telegram ID ${data.user.id}` : "Loading messages"}</p></div>{data?.thread.archived && <span className="archive-label">Archived</span>}<ThemeToggle /></header>
    {error && <div className="px-5"><Failure message={error} retry={() => setRevision(v => v + 1)} /></div>}
    {!data ? !error && <Loading /> : <>
      {data.thread.parentThreadId && <div className="fork-note"><GitFork className="size-3.5" />Forked history · Inherited messages are labeled below</div>}
      <div className="message-scroller">
        <div ref={viewport} className="message-viewport" tabIndex={0} aria-label="Conversation messages" onScroll={checkScroll}><div className="transcript" aria-live="off">
          {data.olderCursor !== null && <div className="flex justify-center"><Button variant="outline" disabled={busy} onClick={() => void load(true)}>Load older</Button></div>}
          {!data.messages.length && <Notice title="No messages yet" description="Saved messages will appear here as this conversation continues." />}
          {data.messages.map((message, index) => <div key={message.id} data-message-id={message.id}>
            {(message.threadId !== data.messages[index - 1]?.threadId && (message.threadId !== threadId || index > 0)) && <div className="history-boundary">{message.threadId === threadId ? "This conversation" : `Inherited from ${data.chain.find(t => t.id === message.threadId)?.title ?? "parent conversation"}`}</div>}
            <article className="message" data-role={message.role}>
              <header>{message.role === "user" ? userLabel(data.user) : message.role === "assistant" ? "Bot" : "System"}</header>
              {message.thinking && <details className="thinking"><summary>Thinking</summary><RichText text={message.thinking} /></details>}
              {message.text && <div className="message-bubble"><RichText text={message.text} /></div>}
              {message.attachments.map(file => <FileAttachment key={file.id} file={file} messageText={message.text} messageAttachments={message.attachments} state={files.get(file.id)} maxBytes={data.maxFileBytes} load={(allowSandbox = false) => loader.load(file, "download", true, allowSandbox)} />)}
              <footer><time dateTime={new Date(message.createdAt).toISOString()}>{timestamp(message.createdAt)}</time></footer>
            </article>
          </div>)}
        </div></div>{canJump && <Button className="jump-to-latest" variant="outline" size="icon-sm" aria-label="Jump to latest" onClick={() => { const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; }}><ArrowDown /></Button>}
      </div>
      <footer className="transcript-footer">{data.messages.length} messages loaded · Refreshes every 10 seconds</footer>
    </>}
  </>;
}

const container = document.getElementById("root")!;
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(<App />);
