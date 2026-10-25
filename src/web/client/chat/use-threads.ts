import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatThread } from "../../chat-types.js";
import { chatApi, type ChatReadResult } from "./api.js";

/** Polls every loaded page together so ordering stays consistent as threads move to the top. */
export function useThreads() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [next, setNext] = useState<number | null>(null);
  /** Rendered in the current language by the sidebar; null when the last poll succeeded. */
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [revision, setRevision] = useState(0);
  const pages = useRef(1);
  const active = useRef(false);
  const readGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      const generation = readGeneration.current;
      try {
        const all: ChatThread[] = [];
        let offset: number | null = 0;
        for (let page = 0; page < pages.current && offset !== null; page++) {
          const result = await chatApi.threads(offset, controller.signal);
          all.push(...result.items);
          offset = result.nextOffset;
        }
        if (controller.signal.aborted || generation !== readGeneration.current) return;
        const unique = [...new Map(all.map(thread => [thread.id, thread])).values()];
        active.current = unique.some(thread => thread.activity !== null);
        setThreads(unique); setNext(offset); setError(null); setStatus("ready");
      } catch (err) {
        if (!controller.signal.aborted) { setError(err ?? new Error()); setStatus("ready"); }
      } finally { busy = false; }
    };
    const loop = async () => {
      await load();
      if (!controller.signal.aborted) timer = setTimeout(() => void loop(), active.current ? 4_000 : 15_000);
    };
    void loop();
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [revision]);

  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const more = useCallback(() => { pages.current++; setRevision(v => v + 1); }, []);
  /** Shows a new or forked thread before the next poll returns it. */
  const remember = useCallback((thread: ChatThread) => setThreads(list => [thread, ...list.filter(item => item.id !== thread.id)]), []);
  const markRead = useCallback((threadId: number, result: ChatReadResult) => {
    readGeneration.current++;
    setThreads(list => list.map(thread => {
      if (thread.id !== threadId || thread.unread === result.unread) return thread;
      // A safe acknowledgement watermark can precede a pending response.
      if (!result.unread && (thread.activity || thread.lastMessageId === null
        || thread.lastMessageId > (result.readMessageId ?? 0))) return thread;
      return { ...thread, unread: result.unread };
    }));
    setRevision(value => value + 1);
  }, []);
  return { threads, next, error, status, refresh, more, remember, markRead };
}
