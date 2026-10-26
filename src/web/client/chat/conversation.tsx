import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { IconAlertCircle, IconArchive, IconArrowDown, IconBrandTelegram, IconCheck, IconCopy, IconDots, IconFile, IconFold, IconGitFork, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import { MAX_FILE_BYTES } from "../../../files/limits.js";
import { resolveOpenUiLanguage } from "../../../openui/language.js";
import { attachmentKind } from "../../media.js";
import type { WebAttachment } from "../../types.js";
import { AttachmentLoader, type AttachmentSource, type LoadedAttachment } from "../attachments.js";
import { FileAttachment } from "../file-attachment.js";
import { useUiLanguage, type UiLanguage } from "../i18n.js";
import { copyText } from "../lib/clipboard.js";
import { GenerativeResponse } from "../openui-response.js";
import { RichText } from "../rich-text.js";
import { activityLabel } from "../thread-activity.js";
import { ResponseChain, type LiveChainState } from "../tool-details.js";
import { chatApi, getChatAttachmentSource, describeError, type ChatMessage, type ChatReadResult } from "./api.js";
import { acceptFiles, Composer, fileProblemText, type FileProblem } from "./composer.js";
import { emptyDraft, newRequestId, type Draft, type DraftStore, type PendingSend } from "./drafts.js";
import { hasDraftContent, LiveDraft } from "./live-draft.js";
import { MobileNavButton } from "./shell-parts.js";
import { chatFormat, useChatStrings } from "./strings.js";
import type { ChatHistory, ChatThread } from "../../chat-types.js";
import { CompactionStatus } from "./compaction-status.js";

type ActionKind = "stop" | "fork" | "compact";

const excerpt = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140) + (text.length > 140 ? "…" : "");

/** Seen means at least a strip of the message (or all of a short one) is inside the transcript viewport. */
function newestVisibleMessage(viewport: HTMLElement, cap: number): number | null {
  const view = viewport.getBoundingClientRect();
  if (view.height <= 0) return null;
  const nodes = viewport.querySelectorAll<HTMLElement>("[data-message-id]");
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    const id = Number(node.dataset.messageId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > cap) continue;
    const rect = node.getBoundingClientRect();
    if (rect.top >= view.bottom) continue;
    if (rect.bottom <= view.top) return null;
    const shown = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
    if (shown < Math.min(rect.height, 24)) continue;
    return id;
  }
  return null;
}

export function Conversation({ threadId, drafts, onThreadChange, onOpenThread, onRead, notice }: {
  threadId: string;
  drafts: DraftStore;
  onThreadChange: () => void;
  onOpenThread: (thread: ChatThread) => void;
  onRead: (threadId: string, result: ChatReadResult) => void;
  /** Shown above the composer, such as the time zone question. */
  notice?: ReactNode;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const format = useMemo(() => chatFormat(language), [language]);
  const [history, setHistory] = useState<ChatHistory | null>(null);
  const historyRef = useRef<ChatHistory | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const pendingSnapshot = useCallback(() => drafts.pending(threadId), [drafts, threadId]);
  const pending = useSyncExternalStore(drafts.subscribe, pendingSnapshot, pendingSnapshot);
  const setPending = useCallback((update: (current: readonly PendingSend[]) => readonly PendingSend[]) => drafts.updatePending(threadId, update), [drafts, threadId]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [draft, setDraftState] = useState<Draft>(() => drafts.read(threadId));
  const [action, setAction] = useState<{ kind: ActionKind; busy: boolean; error: unknown } | null>(null);
  const [forkTarget, setForkTarget] = useState<{ open: boolean; message: ChatMessage | null }>({ open: false, message: null });
  const [compactOpen, setCompactOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropProblem, setDropProblem] = useState<FileProblem | null>(null);
  const [files, setFiles] = useState(new Map<string, LoadedAttachment>());
  const [chatFiles] = useState(getChatAttachmentSource);
  const [loader] = useState(() => new AttachmentLoader(threadId, setFiles, chatFiles));
  const imageSource = useMemo(() => ({ threadId, source: chatFiles }), [threadId, chatFiles]);
  const mounted = useRef(true);
  const controller = useRef(new AbortController());
  const fetching = useRef(false);
  const again = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<{ top: number; height: number } | null>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const setDraft = useCallback((next: Draft) => { setDraftState(next); drafts.write(threadId, next); }, [threadId, drafts]);

  const load = useCallback(async (older = false) => {
    const signal = controller.current.signal;
    if (signal.aborted || !drafts.active) return;
    if (fetching.current) { if (!older) again.current = true; return; }
    fetching.current = true;
    if (older) setOlderBusy(true);
    try {
      do {
        again.current = false;
        const previous = historyRef.current;
        const activeAction = previous?.messages.find(message => message.action?.status === "queued" || message.action?.status === "running");
        let cursor = older ? previous?.olderCursor ?? null : Math.min(previous?.messages.slice(-50)[0]?.id ?? Infinity, activeAction?.id ?? Infinity);
        if (cursor === Infinity) cursor = null;
        let latest: ChatHistory;
        const received: ChatMessage[] = [];
        do {
          latest = await chatApi.history(threadId, cursor === null ? null : older ? { before: cursor } : { after: cursor }, signal);
          received.push(...latest.messages);
          cursor = older ? null : latest.newerCursor;
        } while (cursor !== null);
        if (signal.aborted || !drafts.active) return;
        const messages = [...new Map([...(historyRef.current?.messages ?? []), ...received].map(message => [message.id, message])).values()].sort((a, b) => a.id - b.id);
        const merged: ChatHistory = { ...latest, messages, olderCursor: older || !previous ? latest.olderCursor : previous.olderCursor };
        if (older && viewport.current) restoreScroll.current = { top: viewport.current.scrollTop, height: viewport.current.scrollHeight };
        historyRef.current = merged;
        setHistory(merged);
        setLoadError(null);
        const ids = new Set(messages.map(message => message.id));
        setPending(list => list.some(item => item.status === "sent" && ids.has(item.messageId)) ? list.filter(item => item.status !== "sent" || !ids.has(item.messageId)) : list);
        older = false;
      } while (again.current && !signal.aborted);
    } catch (error) {
      if (!signal.aborted) setLoadError(error ?? new Error());
    } finally {
      fetching.current = false;
      if (!signal.aborted) setOlderBusy(false);
    }
  }, [threadId, drafts, setPending]);

  useEffect(() => {
    mounted.current = true;
    const signal = controller.current.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const busy = () => Boolean(historyRef.current?.thread.activity) || pendingRef.current.some(item => item.status !== "failed");
    const poll = async () => {
      if (!document.hidden) await load();
      if (!signal.aborted) timer = setTimeout(() => void poll(), busy() ? 1_500 : 8_000);
    };
    void poll();
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      controller.current.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      loader.dispose();
    };
  }, [load, loader]);

  const compacting = history?.messages.some(message => message.action?.status === "queued" || message.action?.status === "running") ?? false;
  useEffect(() => {
    if (!compacting) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 1_000);
    return () => clearInterval(timer);
  }, [compacting, load]);

  useEffect(() => {
    if (!history) return;
    for (const message of history.messages) for (const file of message.attachments) {
      if (attachmentKind(file) === "image") loader.observe(file);
      else if (history.autoLoadMaxBytes > 0 && file.size !== null && file.size <= history.autoLoadMaxBytes) loader.load(file, "auto");
    }
  }, [history, loader]);

  const acked = useRef(0);
  const acking = useRef(false);
  const ackAgain = useRef(false);
  /** Marks read only what the reader can see: the newest stored message inside the viewport, with the latest history
   * loaded, the transcript at the bottom, and this tab visible and focused. Pending sends and drafts carry no id. */
  const acknowledge = useCallback(async () => {
    const current = historyRef.current;
    const node = viewport.current;
    const signal = controller.current.signal;
    if (!current || !node || signal.aborted || !drafts.active || document.hidden || !document.hasFocus()) return;
    const cap = current.thread.lastMessageId;
    if (cap === null || current.newerCursor !== null || node.scrollHeight - node.scrollTop - node.clientHeight > 80) return;
    const target = newestVisibleMessage(node, cap);
    if (target === null || target <= acked.current || (!current.thread.unread && target === cap)) return;
    if (acking.current) { ackAgain.current = true; return; }
    acking.current = true;
    try {
      const result = await chatApi.markRead(threadId, target, signal);
      if (signal.aborted || !drafts.active) return;
      acked.current = Math.max(acked.current, result.readMessageId ?? 0);
      onRead(threadId, result);
    } catch { /* The next scroll, poll or focus retries. */ }
    finally {
      acking.current = false;
      if (ackAgain.current && !signal.aborted) { ackAgain.current = false; void acknowledge(); }
    }
  }, [threadId, drafts, onRead]);
  const ackFrame = useRef(0);
  const scheduleAck = useCallback(() => {
    cancelAnimationFrame(ackFrame.current);
    ackFrame.current = requestAnimationFrame(() => void acknowledge());
  }, [acknowledge]);
  useEffect(() => {
    window.addEventListener("focus", scheduleAck);
    document.addEventListener("visibilitychange", scheduleAck);
    return () => { cancelAnimationFrame(ackFrame.current); window.removeEventListener("focus", scheduleAck); document.removeEventListener("visibilitychange", scheduleAck); };
  }, [scheduleAck]);
  useEffect(() => { if (history) scheduleAck(); }, [history, scheduleAck]);

  const measure = () => {
    const node = viewport.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distance < 80;
    setShowJump(distance > 240);
    scheduleAck();
  };
  const toBottom = () => { const node = viewport.current; if (node) { node.scrollTop = node.scrollHeight; stickToBottom.current = true; setShowJump(false); } };
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (restoreScroll.current) {
      node.scrollTop = restoreScroll.current.top + node.scrollHeight - restoreScroll.current.height;
      restoreScroll.current = null;
    } else if (stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [history?.messages, history?.draft, pending]);
  useEffect(() => {
    const content = viewport.current?.firstElementChild;
    if (!content) return;
    // Images and generated views grow after layout; keep following the latest reply.
    const observer = new ResizeObserver(() => { if (stickToBottom.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [Boolean(history)]);

  const send = useCallback(async (input: Draft) => {
    if (!drafts.active) return;
    const requestId = input.requestId ?? newRequestId();
    const item: PendingSend = { requestId, text: input.text.trim(), files: input.files, status: "sending" };
    setPending(list => [...list.filter(entry => entry.requestId !== requestId), item]);
    stickToBottom.current = true;
    try {
      const result = await chatApi.send(threadId, { text: item.text, requestId, files: item.files });
      if (!drafts.active) return;
      drafts.confirmSend(threadId, requestId, result.messageId);
      if (!mounted.current) return;
      void load();
      onThreadChange();
    } catch (error) {
      if (!drafts.active) return;
      setPending(list => list.map(entry => entry.requestId === requestId && entry.status !== "sent" ? { ...entry, status: "failed", error: error ?? new Error() } : entry));
    }
  }, [threadId, drafts, load, onThreadChange, setPending]);

  useEffect(() => {
    const start = drafts.takeStart(threadId);
    if (start) void send(start);
  }, [threadId, drafts, send]);

  const submit = (value: Draft) => { setDraft(emptyDraft); void send(value); };
  const editFailed = (item: Extract<PendingSend, { status: "failed" }>) => {
    setPending(list => list.filter(entry => entry.requestId !== item.requestId));
    setDraft({ text: item.text, files: item.files, requestId: item.requestId });
  };

  const run = async (kind: ActionKind, task: () => Promise<void>) => {
    if (!mounted.current || !drafts.active) return;
    setAction({ kind, busy: true, error: null });
    try {
      await task();
      if (mounted.current && drafts.active) setAction(null);
    } catch (error) {
      if (mounted.current && drafts.active) setAction({ kind, busy: false, error: error ?? new Error() });
    }
  };
  const stop = () => void run("stop", async () => {
    await chatApi.stop(threadId);
    if (!mounted.current || !drafts.active) return;
    void load(); onThreadChange();
  });
  const fork = (message: ChatMessage | null) => void run("fork", async () => {
    const thread = await chatApi.fork(threadId, message?.id);
    if (!mounted.current || !drafts.active) return;
    setForkTarget(target => ({ ...target, open: false }));
    onOpenThread(thread);
  });
  const compact = () => void run("compact", async () => {
    setCompactOpen(false);
    await chatApi.compact(threadId);
    if (!mounted.current || !drafts.active) return;
    void load(); onThreadChange();
  });
  const forkFrom = useCallback((message: ChatMessage) => setForkTarget({ open: true, message }), []);
  const followUp = useCallback((text: string) => void send({ text, files: [], requestId: null }), [send]);
  const autoLoadFile = useCallback((file: WebAttachment) => loader.load(file, "auto"), [loader]);
  const loadFile = useCallback((file: WebAttachment, sandbox: boolean) => loader.load(file, "download", true, sandbox), [loader]);

  const thread = history?.thread;
  const activity = thread?.activity ?? null;
  const sentAt = pending.find(item => item.status === "sent")?.sentAt ?? null;
  const canStop = Boolean(activity && activity.state !== "interrupted" && activity.state !== "stopping");
  // Without a server start time, the timer counts from when this tab first saw the reply working.
  const firstSeen = useRef<number | null>(null);
  if (!activity || activity.state === "queued") firstSeen.current = null;
  else firstSeen.current ??= Date.now();
  const live: LiveChainState | null = activity
    ? { state: activity.state, queuedTurns: activity.queuedTurns, startedAt: activity.startedAt ?? firstSeen.current ?? sentAt ?? Date.now() }
    : sentAt !== null ? { state: "generating", queuedTurns: 0, startedAt: sentAt } : null;
  const web = thread?.origin === "web";
  const maxBytes = history?.maxFileBytes ?? MAX_FILE_BYTES;
  const actionError = action?.error ? describeError(action.error, t.actionFailed, language) : "";

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const result = acceptFiles(draft.files, [...event.dataTransfer.files], maxBytes);
    setDropProblem(result.problem);
    setDraft({ ...draft, files: result.files, requestId: null });
  };

  return <div className="chat-view" onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) setDragging(true); }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={drop}>
    <header className="chat-view-header">
      <MobileNavButton />
      <div className="chat-view-title">
        <h1>{thread?.title ?? (loadError !== null ? t.chatUnavailable : <SkeletonLine minWidth={40} maxWidth={60} />)}</h1>
        {thread && <span className="chat-view-marks">
          {!web && <Tooltip content={thread.topicId !== null ? t.telegramTopic : t.telegram} render={<span className="chat-view-mark" tabIndex={0} aria-label={thread.topicId !== null ? t.telegramTopic : t.telegram}><IconBrandTelegram size={16} aria-hidden="true" /></span>} />}
          {thread.parentThreadId !== null && <Tooltip content={t.fork} render={<span className="chat-view-mark" tabIndex={0} aria-label={t.fork}><IconGitFork size={16} aria-hidden="true" /></span>} />}
          {thread.archived && <Badge variant="secondary">{t.archived}</Badge>}
        </span>}
        <span className="sr-only" role="status" aria-live="polite">{activity ? activityLabel(activity, language) : ""}</span>
      </div>
      <div className="chat-view-actions">
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button variant="ghost" shape="square" aria-label={t.chatActions} disabled={!thread}><IconDots size={20} aria-hidden="true" /></Button>} />
          <DropdownMenu.Content align="end" sideOffset={6}>
            <DropdownMenu.Item icon={<IconGitFork size={16} aria-hidden="true" />} onClick={() => setForkTarget({ open: true, message: null })}>{t.forkChat}</DropdownMenu.Item>
            <DropdownMenu.Item disabled={compacting || (action?.kind === "compact" && action.busy)} icon={<IconFold size={16} aria-hidden="true" />} onClick={() => setCompactOpen(true)}>{t.compactContext}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </header>

    {actionError && <div className="chat-banner-row"><Banner variant="error" size="sm" icon={<IconAlertCircle aria-hidden="true" />} description={actionError}
      action={<Button size="sm" variant="ghost" onClick={() => setAction(null)}>{t.dismiss}</Button>} /></div>}
    {loadError !== null && history && <div className="chat-banner-row"><Banner variant="alert" size="sm" icon={<IconAlertCircle aria-hidden="true" />} description={t.retryingAutomatically(describeError(loadError, t.chatLoadFailed, language))} /></div>}

    <div className="chat-scroller">
      <div ref={viewport} className="chat-viewport" onScroll={measure} tabIndex={-1}>
        <div className="chat-transcript" role="log" aria-label={t.messages} aria-busy={!history}>
          {!history && loadError === null && <div className="chat-transcript-skeleton" aria-label={t.loadingMessages}>{[70, 45, 85].map(width => <SkeletonLine key={width} minWidth={width - 20} maxWidth={width} />)}</div>}
          {!history && loadError !== null && <div className="chat-empty-state" role="alert">
            <h2>{t.chatOpenFailed}</h2><p className="chat-muted">{describeError(loadError, t.chatLoadFailed, language)}</p>
            <Button icon={<IconRefresh size={16} aria-hidden="true" />} onClick={() => void load()}>{t.tryAgain}</Button>
          </div>}
          {history && history.olderCursor !== null && <div className="chat-older"><Button variant="secondary" loading={olderBusy} onClick={() => void load(true)}>{t.showEarlier}</Button></div>}
          {history && !history.messages.length && !pending.length && !history.thread.archived && <div className="chat-empty-state">
            <h2>{t.startConversation}</h2>
            <p className="chat-muted">{web ? t.emptyWeb : t.emptyTelegram}</p>
          </div>}
          {history?.messages.map((message, index) => {
            const previous = history.messages[index - 1];
            const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
            const boundary = message.threadId !== previous?.threadId && (message.threadId !== threadId || index > 0);
            return <div key={message.id} className="chat-turn">
              {newDay && <div className="chat-day" role="separator"><span>{format.day(message.createdAt)}</span></div>}
              {boundary && <div className="chat-boundary">{message.threadId === threadId ? t.continuedInFork : t.fromChat(history.chain.find(item => item.id === message.threadId)?.title ?? t.originalChat)}</div>}
              <MessageView message={message} web={web} files={files} maxBytes={history.maxFileBytes} autoLoadMaxBytes={history.autoLoadMaxBytes} autoLoad={autoLoadFile} language={language} imageSource={imageSource}
                load={loadFile} onFork={forkFrom} onAction={followUp} />
            </div>;
          })}
          {pending.map(item => {
            const fileNames = item.status === "sent" ? item.fileNames : item.files.map(file => file.name);
            return <article key={item.requestId} className="chat-message" data-role="user" data-pending={item.status}>
              <div className="chat-bubble">{item.text && <p className="chat-plain">{item.text}</p>}
                {fileNames.length > 0 && <ul className="chat-pending-files">{fileNames.map((name, index) => <li key={index}><IconFile size={14} aria-hidden="true" />{name}</li>)}</ul>}
              </div>
              {item.status === "failed" ? <div className="chat-send-failed" role="alert">
                <IconAlertCircle size={16} aria-hidden="true" /><span>{describeError(item.error, t.sendFailed, language)}</span>
                <Button size="sm" variant="secondary" onClick={() => void send({ text: item.text, files: item.files, requestId: item.requestId })}>{t.retry}</Button>
                <Button size="sm" variant="ghost" icon={<IconPencil size={14} aria-hidden="true" />} onClick={() => editFailed(item)}>{t.edit}</Button>
                <Button size="sm" variant="ghost" shape="square" aria-label={t.discardMessage} onClick={() => setPending(list => list.filter(entry => entry.requestId !== item.requestId))}><IconTrash size={14} aria-hidden="true" /></Button>
              </div> : <p className="chat-message-meta" role="status">{item.status === "sending" ? <><Loader size={12} /> {t.sending}</> : t.sent}</p>}
            </article>;
          })}
          {history && (live || hasDraftContent(history.draft)) && <LiveDraft draft={history.draft} live={live} />}
        </div>
      </div>
      {showJump && <Button className="chat-jump" variant="secondary" shape="circle" aria-label={t.jumpToLatest} onClick={toBottom}><IconArrowDown size={16} aria-hidden="true" /></Button>}
    </div>

    <div className="chat-composer-dock">
      {notice}
      {thread?.archived ? <div className="chat-archived" role="note">
        <IconArchive size={18} aria-hidden="true" /><p>{t.archivedNotice}</p>
        <Button size="sm" variant="secondary" icon={<IconGitFork size={16} aria-hidden="true" />} onClick={() => setForkTarget({ open: true, message: null })}>{t.forkChat}</Button>
      </div> : <>
        {dropProblem && <p className="chat-composer-problem" role="alert">{fileProblemText(dropProblem, language)}</p>}
        <Composer draft={draft} onDraftChange={next => { setDropProblem(null); setDraft(next); }} onSubmit={submit} maxFileBytes={maxBytes} autoFocus
          disabled={!history} stop={{ visible: canStop, busy: action?.kind === "stop" && action.busy, onStop: stop }} />
      </>}
    </div>
    {dragging && <div className="chat-drop" aria-hidden="true"><IconFile size={28} /><span>{t.dropFiles}</span></div>}

    <Dialog.Root open={forkTarget.open} onOpenChange={open => setForkTarget(target => ({ ...target, open }))}>
      <Dialog size="lg" className="chat-dialog">
        <Dialog.Title>{t.forkTitle}</Dialog.Title>
        <Dialog.Description>{t.forkDescription(Boolean(forkTarget.message))}</Dialog.Description>
        {forkTarget.message && <blockquote className="chat-dialog-quote">{excerpt(forkTarget.message.text) || t.attachment}</blockquote>}
        {action?.kind === "fork" && actionError && <p className="chat-error-text" role="alert">{actionError}</p>}
        <div className="chat-dialog-actions">
          <Dialog.Close render={<Button variant="secondary">{t.cancel}</Button>} />
          <Button variant="primary" icon={<IconGitFork size={16} aria-hidden="true" />} loading={action?.kind === "fork" && action.busy} onClick={() => fork(forkTarget.message)}>{t.forkChat}</Button>
        </div>
      </Dialog>
    </Dialog.Root>
    <Dialog.Root open={compactOpen} onOpenChange={setCompactOpen}>
      <Dialog size="lg" className="chat-dialog">
        <Dialog.Title>{t.compactTitle}</Dialog.Title>
        <Dialog.Description>{t.compactDescription}</Dialog.Description>
        {action?.kind === "compact" && actionError && <p className="chat-error-text" role="alert">{actionError}</p>}
        <div className="chat-dialog-actions">
          <Dialog.Close render={<Button variant="secondary">{t.cancel}</Button>} />
          <Button variant="primary" icon={<IconFold size={16} aria-hidden="true" />} loading={action?.kind === "compact" && action.busy} onClick={compact}>{t.compact}</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  </div>;
}

/** Messages re-render only when their own data, files, or language change. */
const MessageView = memo(function MessageView({ message, web, files, maxBytes, autoLoadMaxBytes, autoLoad, language, imageSource, load, onFork, onAction }: {
  message: ChatMessage; web: boolean; files: Map<string, LoadedAttachment>; maxBytes: number; autoLoadMaxBytes: number; autoLoad: (file: WebAttachment) => void; language: UiLanguage;
  imageSource: { threadId: string; source: AttachmentSource };
  load: (file: WebAttachment, sandbox: boolean) => void; onFork: (message: ChatMessage) => void; onAction: (text: string) => void;
}) {
  const t = useChatStrings();
  const format = useMemo(() => chatFormat(language), [language]);
  const [renderedImages, setRenderedImages] = useState<{ source: ChatMessage["openui"]; ids: ReadonlySet<string> }>({ source: undefined, ids: new Set() });
  const messageImageSource = useMemo(() => ({ ...imageSource, fileNames: new Map(message.attachments.map(file => [file.id, file.name])) }), [imageSource, message.attachments]);
  const imagesRendered = useCallback((ids: ReadonlySet<string>) => setRenderedImages({ source: message.openui, ids }), [message.openui]);
  if (message.role === "system") return message.action
    ? <CompactionStatus action={message.action} messageId={message.id} language={language} />
    : <div className="chat-system" role="note" data-message-id={message.id}><RichText text={message.text} /></div>;
  const assistant = message.role === "assistant";
  const openui = assistant && web && message.openui ? message.openui : null;
  // Tool-only records (for example a cancelled run) have nothing to copy or fork from.
  const hasContent = Boolean(message.text || message.attachments.length || openui);
  // Generated components speak the answer's language; the surrounding app keeps the reader's locale.
  const answerLanguage = message.openuiLanguage ?? resolveOpenUiLanguage(message.text);
  // An image the generated view actually mounted already has its own preview and save action there.
  const represented = openui && renderedImages.source === openui ? renderedImages.ids : null;
  const attachments = represented ? message.attachments.filter(file => !(attachmentKind(file) === "image" && represented.has(file.id))) : message.attachments;
  const stopped = assistant && !hasContent && Boolean(message.toolActivity?.calls.some(call => call.status === "cancelled"));
  return <article className="chat-message" data-role={message.role} data-message-id={message.id}>
    {assistant && <ResponseChain activity={message.toolActivity} thinking={message.toolActivity ? null : message.thinking} language={language}
      durationMs={message.durationMs ?? null} stopped={stopped} />}
    {message.text && <div className={assistant ? "chat-prose" : "chat-bubble"}><RichText text={message.text} /></div>}
    {openui && <div className="chat-openui"><GenerativeResponse source={openui} onAction={onAction} language={answerLanguage} imageSource={messageImageSource} onImagesRendered={imagesRendered} /></div>}
    {attachments.length > 0 && <div className="chat-attachments">{attachments.map(file => <FileAttachment key={file.id} file={file} messageText={message.text} messageAttachments={message.attachments}
      state={files.get(file.id)} maxBytes={maxBytes}
      autoLoad={attachmentKind(file) === "image" && file.size !== null && file.size <= autoLoadMaxBytes ? () => autoLoad(file) : undefined} load={(allowSandbox = false) => load(file, allowSandbox)} />)}</div>}
    {message.telegramSyncFailed && <p className="chat-message-meta" role="note">{t.syncFailed}</p>}
    {hasContent && <footer className="chat-message-actions" role="group" aria-label={assistant ? t.responseActions : t.messageActions}>
      <time className="chat-message-time" dateTime={new Date(message.createdAt).toISOString()} title={format.full(message.createdAt)}>{format.time(message.createdAt)}</time>
      {message.text && <CopyButton text={message.text} />}
      <Tooltip content={t.forkFromHere} render={<Button variant="ghost" size="sm" shape="square" className="chat-action-button" aria-label={t.forkFromHere} onClick={() => onFork(message)}><IconGitFork size={16} aria-hidden="true" /></Button>} />
    </footer>}
  </article>;
});

function CopyButton({ text }: { text: string }) {
  const t = useChatStrings();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? t.copied : t.copy;
  return <Tooltip content={label} render={<Button variant="ghost" size="sm" shape="square" className="chat-action-button" aria-label={label}
    onClick={() => void copyText(text).then(done => setCopied(done))}>{copied ? <IconCheck size={16} aria-hidden="true" /> : <IconCopy size={16} aria-hidden="true" />}</Button>} />;
}
