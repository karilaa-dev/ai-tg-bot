import { useId, useMemo } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { IconBrandTelegram } from "@tabler/icons-react";
import type { ChatThread } from "../../chat-types.js";
import { useUiLanguage } from "../i18n.js";
import { cn } from "../lib/utils.js";
import { chatFormat, useChatStrings } from "./strings.js";
import { groupLabel, groupThreads } from "./thread-groups.js";

const isWorking = (thread: ChatThread) => thread.activity !== null && thread.activity.state !== "interrupted";

/** Only chats that started in Telegram carry a source mark; web chats need none. */
export function ThreadOrigin({ thread }: { thread: ChatThread }) {
  const t = useChatStrings();
  if (thread.origin !== "telegram") return null;
  return <span className="chat-thread-origin" title={t.startedIn(thread.origin)} aria-hidden="true"><IconBrandTelegram size={15} /></span>;
}

/** The blue dot means the chat has messages you have not seen yet. */
export function ThreadDate({ thread, format, now }: { thread: ChatThread; format: ReturnType<typeof chatFormat>; now: number }) {
  const t = useChatStrings();
  return <span className="chat-thread-meta">
    {thread.unread && <span className="chat-unread-dot" title={t.unread} aria-hidden="true" />}
    {isWorking(thread) ? <span className="chat-thread-working" title={t.working}><Loader size={12} /></span>
      : <time className="chat-thread-time" dateTime={new Date(thread.lastActivity).toISOString()} title={format.full(thread.lastActivity)}>{format.listDate(thread.lastActivity, now)}</time>}
  </span>;
}

export function ThreadList({ threads, activeId, onSelect }: { threads: ChatThread[]; activeId: string | null; onSelect: (thread: ChatThread) => void }) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const format = useMemo(() => chatFormat(language), [language]);
  const id = useId();
  const now = Date.now();
  return groupThreads(threads, now).map(group => {
    const labelId = `${id}-${group.key}`;
    return <Sidebar.Group key={group.key} className="chat-thread-group">
      <Sidebar.GroupLabel id={labelId} className="chat-thread-group-label">{groupLabel(group.group, t, format, now)}</Sidebar.GroupLabel>
      <ul className="chat-thread-list" aria-labelledby={labelId}>
        {group.threads.map(thread => {
          const active = thread.id === activeId;
          return <li key={thread.id}>
            <button type="button" className={cn("chat-thread", active && "is-active", thread.unread && "is-unread")} aria-current={active ? "page" : undefined} onClick={() => onSelect(thread)}>
              <ThreadOrigin thread={thread} />
              <span className="chat-thread-title">{thread.title}</span>
              <ThreadDate thread={thread} format={format} now={now} />
              <span className="sr-only">{t.threadExtras({ origin: thread.origin, fork: thread.parentThreadId !== null, archived: thread.archived, working: isWorking(thread), unread: thread.unread })}</span>
            </button>
          </li>;
        })}
      </ul>
    </Sidebar.Group>;
  });
}
