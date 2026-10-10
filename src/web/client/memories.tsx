import { useEffect, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { ArrowLeft, ArrowRight, Brain, FileText, LoaderCircle, RefreshCw } from "lucide-react";
import { userLabel, type WebMemories } from "../types.js";
import { apiJson } from "./api.js";
import { Button } from "./components/ui/button.js";

export function Memories({ userId, back }: { userId: number; back: () => void }) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<WebMemories | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void apiJson<WebMemories>(`/api/users/${userId}/memories?offset=${offset}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load memories."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [userId, offset, revision]);
  return <>
    <header className="pane-header memory-header">
      <Button variant="ghost" size="icon-sm" aria-label="Back to conversations" onClick={back}><ArrowLeft /></Button>
      <div><h2>Memories</h2><p>{data ? userLabel(data.user) : `Telegram ID ${userId}`}</p></div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw /> Refresh</Button>
    </header>
    <div className="pane-scroll memory-content" aria-busy={loading}>
      {error && <div className="failure" role="alert">{error}<Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Retry</Button></div>}
      {loading ? <div className="loading inline-loading" role="status"><LoaderCircle className="activity-spinner" size={16} aria-hidden="true" /> Loading memories…</div> : !error && data && <>
        <div className="memory-toolbar"><p className="memory-status">{data.total} saved {data.total === 1 ? "note" : "notes"}</p><Badge className="settings-badge" variant={data.enabled ? "success" : "neutral"} appearance="dot">Memory {data.enabled ? "on" : "off"}</Badge><span className="memory-sort">Oldest first</span></div>
        {!data.enabled && <p className="memory-disabled">Memory is off. Previously saved notes are kept.</p>}
        {data.items.length ? <ol className="memory-list" aria-label="Saved memories">{data.items.map(memory => <li key={memory.id}>
          <div className="memory-meta"><span><FileText size={16} aria-hidden="true" /> Note #{memory.id}</span><span>{memory.date}</span></div>
          <p>{memory.text}</p>
        </li>)}</ol> : <div className="notice"><Brain aria-hidden="true" /><h3>{data.total ? "No notes on this page" : "No saved memories yet"}</h3><p>{data.total ? "Go back to an earlier page." : "Notes will appear here when the assistant saves something to remember."}</p></div>}
        {(offset > 0 || data.nextOffset !== null) && <nav className="memory-pagination" aria-label="Memory pages">
          <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}><ArrowLeft /> Previous</Button>
          <span>Page {Math.floor(offset / 50) + 1} of {Math.max(1, Math.ceil(data.total / 50))}</span>
          <Button variant="outline" disabled={data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) setOffset(data.nextOffset); }}>Next <ArrowRight /></Button>
        </nav>}
      </>}
    </div>
  </>;
}
