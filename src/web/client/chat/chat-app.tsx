import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { IconAlertCircle, IconBrain, IconBrandTelegram, IconEdit, IconLayoutDashboard, IconLogout, IconMoon, IconSearch, IconSelector, IconSettings, IconSun } from "@tabler/icons-react";
import type { ChatThread } from "../../chat-types.js";
import { MAX_FILE_BYTES } from "../../../files/limits.js";
import { BrandMark } from "../brand.js";
import { useUiLanguage } from "../i18n.js";
import { Memories } from "../memories.js";
import { ChatApiError, chatApi, describeError } from "./api.js";
import { Composer } from "./composer.js";
import { Conversation } from "./conversation.js";
import { emptyDraft, type Draft, type DraftStore } from "./drafts.js";
import { WorkspaceLoading, type SignedIn } from "./gate.js";
import { ChatPreferences } from "./preferences.js";
import { ChatSearch } from "./search.js";
import { ChatSettingsView } from "./settings.js";
import { MobileNavButton, useTheme } from "./shell-parts.js";
import { useChatStrings, type ChatStrings } from "./strings.js";
import { ThreadList } from "./thread-list.js";
import { TimeZonePrompt } from "./time-zone-prompt.js";
import { useThreads } from "./use-threads.js";
import { isUuid } from "../../../utils/uuid.js";

type Route = { view: "home" } | { view: "thread"; threadId: string } | { view: "settings" } | { view: "memories" };

function readRoute(): Route {
  const params = new URLSearchParams(location.search);
  const thread = params.get("thread");
  if (thread !== null && isUuid(thread)) return { view: "thread", threadId: thread };
  const view = params.get("view");
  return view === "settings" || view === "memories" ? { view } : { view: "home" };
}
const routeUrl = (route: Route) => route.view === "thread" ? `/?thread=${route.threadId}` : route.view === "home" ? "/" : `/?view=${route.view}`;
const sameRoute = (a: Route, b: Route) => routeUrl(a) === routeUrl(b);
const displayName = (session: SignedIn, t: ChatStrings) => session.user.name || (session.user.username ? `@${session.user.username}` : t.user(session.user.id));
const shortcutLabel = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

/** The account's Telegram photo as a blob URL, or null while it loads or when there is none. */
function useAvatar(userId: number) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;
    void chatApi.avatar(controller.signal).then(async response => {
      if (response.status !== 200) return;
      const blob = await response.blob();
      if (controller.signal.aborted || !blob.type.startsWith("image/")) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    }).catch(() => { /* The initial stays in place. */ });
    return () => { controller.abort(); if (created) URL.revokeObjectURL(created); setUrl(null); };
  }, [userId]);
  return url;
}

declare module "react" {
  interface CSSProperties { "--sidebar-width"?: string }
}
// Room for a title and a time; Kumo's 16.25rem default is narrower on this app's 14px root.
const sidebarStyle = { "--sidebar-width": "272px" } satisfies CSSProperties;

export function ChatApp({ session, signOut }: { session: SignedIn; signOut: () => Promise<void> }) {
  return <ChatPreferences userId={session.user.id} fallback={<WorkspaceLoading />}>
    <TooltipProvider>
      <Sidebar.Provider collapsible="offcanvas" className="chat-shell" style={sidebarStyle}>
        <Workspace session={session} signOut={signOut} />
      </Sidebar.Provider>
    </TooltipProvider>
  </ChatPreferences>;
}

function Workspace({ session, signOut }: { session: SignedIn; signOut: () => Promise<void> }) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const [route, setRoute] = useState(readRoute);
  const [signOutError, setSignOutError] = useState<unknown>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const threads = useThreads();
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    // Retired views such as the old usage page resolve to the home screen.
    if (location.pathname === "/" && location.search && routeUrl(readRoute()) === "/") history.replaceState(null, "", "/");
    const pop = () => setRoute(readRoute());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const current = route.view === "thread" ? threads.threads.find(thread => thread.id === route.threadId) : undefined;
  useEffect(() => {
    // Tabs show the chat's own name; only the home screen names the app.
    const titles = { home: t.appName, settings: t.settings, memories: t.memories };
    document.title = route.view === "thread" ? current?.title ?? t.chat : titles[route.view];
  }, [route, current?.title, t]);

  const navigate = useCallback((next: Route) => {
    if (!session.drafts.active) return;
    if (!sameRoute(next, readRoute())) history.pushState(null, "", routeUrl(next));
    setRoute(next);
    if (isMobile) setOpenMobile(false);
    // Chat views focus their composer; other pages move focus to the new content.
    if (next.view !== "thread" && next.view !== "home") requestAnimationFrame(() => document.getElementById("chat-main")?.focus({ preventScroll: true }));
  }, [isMobile, setOpenMobile, session.drafts]);
  const openThread = useCallback((thread: ChatThread) => {
    if (!session.drafts.active) return;
    threads.remember(thread); navigate({ view: "thread", threadId: thread.id });
  }, [threads.remember, navigate, session.drafts]);
  const openSearch = useCallback(() => { if (session.drafts.active) setSearchOpen(true); }, [session.drafts]);
  const zonePrompt = <TimeZonePrompt userId={session.user.id} onChoose={() => navigate({ view: "settings" })} />;
  const searchShortcut = useRef(shortcutLabel());

  useEffect(() => {
    // KeyK matches the physical key, so the shortcut also works with a Cyrillic layout.
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.code !== "KeyK") return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [openSearch]);

  const leave = async () => {
    setSignOutError(null);
    try { await signOut(); } catch (error) { setSignOutError(error ?? new Error()); }
  };
  const deleteMemory = useCallback(async (memoryId: number) => {
    if (!session.drafts.active) return;
    try { await chatApi.deleteMemory(memoryId); }
    catch (error) {
      // Another tab may have removed it already; the list reloads either way.
      if (error instanceof ChatApiError && error.status === 404) return;
      throw error;
    }
  }, [session.drafts]);
  const name = displayName(session, t);
  const theme = useTheme();
  const avatar = useAvatar(session.user.id);
  const [avatarFailed, setAvatarFailed] = useState<string | null>(null);

  return <>
    <Sidebar className="chat-sidebar">
      <Sidebar.Header className="chat-sidebar-head">
        <a className="chat-brand" href="/" onClick={event => { event.preventDefault(); navigate({ view: "home" }); }}><BrandMark /><span>{t.appName}</span></a>
      </Sidebar.Header>
      <div className="chat-sidebar-actions">
        <button type="button" className="chat-side-action" aria-current={route.view === "home" ? "page" : undefined} onClick={() => navigate({ view: "home" })}>
          <IconEdit size={18} aria-hidden="true" /><span>{t.newChat}</span>
        </button>
        <button type="button" className="chat-side-action" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" onClick={openSearch}>
          <IconSearch size={18} aria-hidden="true" /><span>{t.searchChats}</span><kbd aria-hidden="true">{searchShortcut.current}</kbd>
        </button>
      </div>
      <Sidebar.Content className="chat-sidebar-content">
        {threads.status === "loading" && <div className="chat-thread-skeleton" aria-label={t.loadingChats}>{[80, 60, 70, 50].map(width => <SkeletonLine key={width} minWidth={width - 20} maxWidth={width} />)}</div>}
        {threads.error !== null && <Banner className="chat-sidebar-banner" variant="error" size="sm" icon={<IconAlertCircle aria-hidden="true" />} description={describeError(threads.error, t.chatsFailed, language)}
          action={<Button size="sm" variant="ghost" onClick={threads.refresh}>{t.retry}</Button>} />}
        {threads.status === "ready" && threads.error === null && !threads.threads.length && <p className="chat-sidebar-empty">{t.noChats}</p>}
        <nav aria-label={t.chats}>
          <ThreadList threads={threads.threads} activeId={route.view === "thread" ? route.threadId : null} onSelect={thread => navigate({ view: "thread", threadId: thread.id })} />
        </nav>
        {threads.next !== null && <div className="chat-sidebar-more"><Button variant="ghost" size="sm" onClick={threads.more}>{t.showMore}</Button></div>}
      </Sidebar.Content>
      <Sidebar.Footer className="chat-sidebar-foot h-auto! px-2! py-2!">
        <div className="chat-sidebar-pages">
          <button type="button" className="chat-side-action" aria-current={route.view === "memories" ? "page" : undefined} onClick={() => navigate({ view: "memories" })}><IconBrain size={18} aria-hidden="true" /><span>{t.memories}</span></button>
          <button type="button" className="chat-side-action" aria-current={route.view === "settings" ? "page" : undefined} onClick={() => navigate({ view: "settings" })}><IconSettings size={18} aria-hidden="true" /><span>{t.settings}</span></button>
        </div>
        {signOutError !== null && <p className="chat-error-text" role="alert">{describeError(signOutError, t.signOutFailed, language)}</p>}
        <DropdownMenu>
          <DropdownMenu.Trigger render={<button type="button" className="chat-account" aria-label={t.account(name)}>
            <span className="chat-avatar" aria-hidden="true">{avatar && avatar !== avatarFailed
              ? <img src={avatar} alt="" decoding="async" onError={() => setAvatarFailed(avatar)} />
              : name.replace("@", "").slice(0, 1).toUpperCase()}</span>
            <span className="chat-account-copy"><span className="chat-account-name">{name}</span>
              <span className="chat-muted">{session.user.username && session.user.name ? `@${session.user.username}` : t.telegramAccount}</span></span>
            <IconSelector size={14} aria-hidden="true" />
          </button>} />
          <DropdownMenu.Content side="top" align="start" sideOffset={6}>
            {session.botUsername && <DropdownMenu.LinkItem icon={<IconBrandTelegram size={16} aria-hidden="true" />} href={`https://t.me/${encodeURIComponent(session.botUsername)}`} target="_blank" rel="noopener noreferrer">{t.openBot(session.botUsername)}</DropdownMenu.LinkItem>}
            {session.admin && <DropdownMenu.LinkItem icon={<IconLayoutDashboard size={16} aria-hidden="true" />} href="/admin">{t.adminPanel}</DropdownMenu.LinkItem>}
            <DropdownMenu.Item icon={theme.dark ? <IconSun size={16} aria-hidden="true" /> : <IconMoon size={16} aria-hidden="true" />} closeOnClick={false} onClick={theme.toggle}>{t.switchTheme(theme.dark)}</DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item icon={<IconLogout size={16} aria-hidden="true" />} onClick={() => void leave()}>{t.signOut}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </Sidebar.Footer>
    </Sidebar>
    <main id="chat-main" className="chat-main" tabIndex={-1}>
      {route.view === "thread" && <Conversation key={route.threadId} threadId={route.threadId} drafts={session.drafts} onThreadChange={threads.refresh} onOpenThread={openThread} onRead={threads.markRead} notice={zonePrompt} />}
      {route.view === "home" && <Home name={session.user.name} drafts={session.drafts} onStarted={openThread} notice={zonePrompt} />}
      {route.view === "settings" && <ChatSettingsView onOpenMemories={() => navigate({ view: "memories" })} />}
      {route.view === "memories" && <div className="chat-view chat-legacy-view"><Memories page load={chatApi.memories} onDelete={deleteMemory} subtitle={t.memoriesSubtitle}
        describeError={(error, fallback) => describeError(error, fallback, language)} leading={<MobileNavButton />} /></div>}
    </main>
    <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} recent={threads.threads} onOpen={openThread} />
  </>;
}

function Home({ name, drafts, onStarted, notice }: { name: string | null; drafts: DraftStore; onStarted: (thread: ChatThread) => void; notice?: ReactNode }) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const [draft, setDraftState] = useState<Draft>(() => drafts.read("new"));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const setDraft = (next: Draft) => { setDraftState(next); drafts.write("new", next); };
  const start = async (value: Draft) => {
    if (!mounted.current || !drafts.active) return;
    setBusy(true); setError(null);
    try {
      const thread = await chatApi.createThread();
      if (!mounted.current || !drafts.active) return;
      drafts.queueStart(thread.id, value);
      setDraft(emptyDraft);
      onStarted(thread);
    } catch (err) {
      if (!mounted.current || !drafts.active) return;
      setError(err ?? new Error());
      setBusy(false);
    }
  };
  return <div className="chat-view chat-home">
    <header className="chat-view-header chat-home-header"><MobileNavButton /></header>
    <div className="chat-home-body">
      <h1 className="chat-home-title">{t.greeting(new Date().getHours())}{name ? `, ${name.split(" ")[0]}` : ""}</h1>
      {error !== null && <Banner variant="error" size="sm" icon={<IconAlertCircle aria-hidden="true" />} description={describeError(error, t.startFailed, language)} />}
      <Composer draft={draft} onDraftChange={setDraft} onSubmit={value => void start(value)} maxFileBytes={MAX_FILE_BYTES} disabled={busy} autoFocus placeholder={t.askAnything} />
      {notice}
    </div>
  </div>;
}
