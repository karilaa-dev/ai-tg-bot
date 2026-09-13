import { useEffect, useId, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import type { WebMessageUsage, WebModelUsage, WebUsageReport, WebUsageTotals } from "../types.js";
import { Button } from "./components/ui/button.js";

const number = (n: number) => n.toLocaleString();
const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const money = (n: number | null) => n === null ? "Unavailable" : n > 0 && n < 0.0001 ? "<$0.0001" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
const percent = (n: number | null) => n === null ? "Unavailable" : `${(n * 100).toFixed(1)}%`;
const categories = [
  { key: "inputTokens", label: "Input", color: "var(--usage-input)" },
  { key: "cacheReadTokens", label: "Cache read", color: "var(--usage-read)" },
  { key: "cacheWriteTokens", label: "Cache write", color: "var(--usage-write)" },
  { key: "outputTokens", label: "Output", color: "var(--usage-output)" },
] as const;

function Cost({ usage }: { usage: WebUsageTotals }) {
  return <>{money(usage.estimatedCostUsd)}{usage.estimatedCostUsd !== null && (usage.unpricedTurns > 0 || usage.missingUsageTurns > 0) && <small className="partial-cost"> partial</small>}</>;
}

export function TokenBreakdown({ usage }: { usage: WebUsageTotals }) {
  return <dl className="token-breakdown">{categories.map(category => <div key={category.key}><dt><i style={{ background: category.color }} />{category.label}</dt><dd>{number(usage[category.key])}</dd></div>)}
    <div><dt>Reported reasoning</dt><dd>{usage.reasoningTokens === null ? "Not reported" : number(usage.reasoningTokens)}</dd></div>
  </dl>;
}

function TokenBar({ usage }: { usage: WebUsageTotals }) {
  return <span className="token-bar" aria-hidden="true">{categories.map(category => <span key={category.key} style={{ background: category.color, width: `${usage.totalTokens ? usage[category.key] / usage.totalTokens * 100 : 0}%` }} />)}</span>;
}

export function MessageUsage({ usage }: { usage?: WebMessageUsage | null }) {
  if (!usage?.recordedTurns) return <span className="usage-unavailable">Usage not recorded</span>;
  return <details className="message-usage"><summary>{compact(usage.totalTokens)} tokens · <Cost usage={usage} /></summary>
    <div className="message-usage-content"><UsageDetails usage={usage} models={usage.models} modelCalls={usage.modelCalls} />
      <p>Usage covers all model calls for this reply, including tools. Reasoning is included in output. Price is an API estimate in USD.</p>
    </div>
  </details>;
}

function UsageDetails({ usage, models, modelCalls }: {
  usage: WebUsageTotals; models: WebModelUsage[]; modelCalls?: number | null;
}) {
  return <><TokenBar usage={usage} /><TokenBreakdown usage={usage} />
    <p>Cache hit rate {percent(usage.cacheReadRatio)}{modelCalls != null ? ` · ${number(modelCalls)} model ${modelCalls === 1 ? "call" : "calls"}` : ""}</p>
    {models.map(model => <p key={`${model.provider}/${model.model}`}><strong>{model.model}</strong> · {model.provider} · {number(model.totalTokens)} tokens · <Cost usage={model} /></p>)}
  </>;
}

export function ThreadUsage({ threadId, initiallyOpen = false }: { threadId: number; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => setOpen(initiallyOpen), [threadId, initiallyOpen]);
  const { report, error, retry } = useUsageReport(null, threadId, 0);
  const tokensRecorded = report && (report.totals.recordedTurns > 0 || report.totals.missingUsageTurns === 0);
  return <div className="thread-usage"><details className="message-usage" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="thread-usage-summary">
      <span className="thread-usage-label">Thread usage · All time</span>
      <span className="thread-usage-metric"><strong data-unavailable={!tokensRecorded || undefined} title={tokensRecorded ? `${number(report.totals.totalTokens)} tokens` : undefined}>{report ? tokensRecorded ? compact(report.totals.totalTokens) : "Not recorded" : error ? "Unavailable" : "Loading…"}</strong><span>Tokens</span></span>
      <span className="thread-usage-metric"><strong data-unavailable={!report || report.totals.estimatedCostUsd === null || undefined}>{report ? <Cost usage={report.totals} /> : error ? "Unavailable" : "Loading…"}</strong><span>Estimated USD</span></span>
      <span className="thread-usage-toggle">{open ? "Less" : "Details"}<ChevronDown size={16} aria-hidden="true" /></span>
    </summary>
    <div className="message-usage-content">
      {error && <div className="failure" role="alert">{error}<Button onClick={retry}>Retry</Button></div>}
      {!report && !error && <p role="status">Loading thread usage…</p>}
      {report && <>
        {report.totals.recordedTurns ? <><UsageDetails usage={report.totals} models={report.models} /><p>{number(report.totals.recordedTurns)} recorded turns · All time</p></> : <p>No usage has been recorded for this thread yet.</p>}
        {report.totals.missingUsageTurns > 0 && <p>{number(report.totals.missingUsageTurns)} replies or turns have no saved usage.</p>}
        {report.totals.unpricedTurns > 0 && <p>{number(report.totals.unpricedTurns)} recorded turns have incomplete pricing.</p>}
        <p>Totals cover this entire thread, including messages not loaded here. Inherited messages count toward their original thread. Reasoning is included in output. Price is an API estimate in USD.</p>
      </>}
    </div>
  </details></div>;
}

function useUsageReport(userId: number | null, threadId: number | null, days: number) {
  const [report, setReport] = useState<WebUsageReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setReport(null); setError(""); }, [userId, threadId, days]);
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden) return;
      fetching = true; setBusy(true);
      try {
        const query = new URLSearchParams({ days: String(days) });
        if (userId) query.set("user", String(userId));
        if (threadId) query.set("thread", String(threadId));
        const response = await fetch(`/api/usage?${query}`, { signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "Could not load usage.");
        if (!controller.signal.aborted) { setReport(value); setError(""); }
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load usage."); }
      finally { fetching = false; if (!controller.signal.aborted) setBusy(false); }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [userId, threadId, days, revision]);
  return { report, error, busy, retry: () => setRevision(n => n + 1) };
}

export function UsageDashboard({ userId, title, back, all, openThread }: {
  userId: number | null; title: string; back: () => void; all: () => void;
  openThread: (userId: number, threadId: number, showUsage: boolean) => void;
}) {
  const [days, setDays] = useState(30);
  const { report, error, busy, retry } = useUsageReport(userId, null, days);
  return <>
    <header className="pane-header usage-header"><Button variant="ghost" size="icon-sm" onClick={back} aria-label="Back to conversations"><ArrowLeft /></Button><div><h2>Usage & estimated cost</h2><p>{title}</p></div>
      <Button variant="ghost" size="icon-sm" onClick={retry} disabled={busy} aria-label="Refresh usage"><RefreshCw /></Button>
    </header>
    <div className="usage-scroll"><div className="usage-dashboard">
      <div className="usage-controls"><div>{userId && <Button variant="outline" onClick={all}>All usage</Button>}<span>Daily totals in UTC</span></div><label>Period <select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={0}>All time</option></select></label></div>
      {error && <div role="alert" className="failure">{error}<Button onClick={retry}>Retry</Button></div>}
      {!report && busy && <p className="loading" role="status">Loading usage…</p>}
      {report && <>
        <div className="usage-stats">
          <div><span>Estimated cost · USD</span><strong><Cost usage={report.totals} /></strong><small>API equivalent</small></div>
          <div><span>Total tokens</span><strong title={number(report.totals.totalTokens)}>{compact(report.totals.totalTokens)}</strong><small>Input + caches + output</small></div>
          <div><span>Cache hit rate</span><strong>{percent(report.totals.cacheReadRatio)}</strong><small>Share of prompt tokens read from cache</small></div>
          <div><span>Recorded turns</span><strong>{number(report.totals.recordedTurns)}</strong><small>{report.threads.length} {report.threads.length === 1 ? "thread" : "threads"} in this period</small></div>
        </div>
        <div className="usage-token-summary"><TokenBar usage={report.totals} /><TokenBreakdown usage={report.totals} /></div>
        {(report.totals.missingUsageTurns > 0 || report.totals.unpricedTurns > 0) && <p className="usage-coverage">{report.totals.missingUsageTurns > 0 && `${number(report.totals.missingUsageTurns)} replies or turns have no saved usage. `}{report.totals.unpricedTurns > 0 && `${number(report.totals.unpricedTurns)} recorded turns have incomplete pricing. `}Totals include only available data.</p>}
        {!report.totals.recordedTurns ? <div className="notice"><h3>No recorded usage in this period</h3><p>Try a longer period. New bot replies will appear here after the model finishes.</p></div> : <UsageGraphs daily={report.daily} />}
        {report.models.length > 0 && <section className="usage-section"><h3>By model</h3><ModelTable models={report.models} /></section>}
        {report.threads.length > 0 && <section className="usage-section"><h3>By thread</h3><div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>Thread</th><th>Tokens</th><th>Cache hit</th><th>Turns</th><th>Est. USD</th></tr></thead><tbody>{report.threads.map(thread => <tr key={thread.id}>
          <td><button className="usage-thread-link" onClick={() => openThread(thread.userId, thread.id, true)}>{thread.title}</button><small>#{thread.id}{thread.archived ? " · Archived" : ""} · <button onClick={() => openThread(thread.userId, thread.id, false)}>Messages <ArrowUpRight size={11} /></button></small></td>
          <td>{number(thread.totalTokens)}<TokenBar usage={thread} /></td><td>{percent(thread.cacheReadRatio)}</td><td>{number(thread.recordedTurns)}{thread.missingUsageTurns > 0 && <small>{number(thread.missingUsageTurns)} untracked</small>}</td><td><Cost usage={thread} /></td>
        </tr>)}</tbody></table></div></section>}
        <details className="usage-method"><summary>How usage and estimates work</summary><div>
          <p>Estimates use the <a href="https://ccusage.com/guide/cost-modes" target="_blank" rel="noreferrer">ccusage token calculation method</a>: uncached input × input rate + cache reads × cache-read rate + cache writes × cache-write rate + output × output rate.</p>
          <p>Reasoning tokens are part of output and are not counted twice. The cache hit rate is cache reads divided by all prompt tokens. Each model call is priced separately when that breakdown is available. Older turn totals use the saved model and its standard rates.</p>
          <p>Prices use the current LiteLLM catalog, with saved model costs as a fallback. These USD estimates are not an invoice or a subscription charge. They exclude image generation, transcription, sandbox, search, and other tool fees. Historical estimates may change when model prices change.</p>
          <p>Forked messages keep their original usage. Thread totals include only work performed in that thread. Recorded context-summary and tool tokens are included even when their model is unknown. Failed or cancelled turns are included when usage was saved; older messages and interrupted work may have no usage.</p>
          <p>{report.pricing.fetchedAt ? `Prices fetched ${new Date(report.pricing.fetchedAt).toLocaleString()}.${report.pricing.stale ? " Refresh unavailable; using the last successful download." : " Refreshed daily."}` : "Pricing catalog unavailable. Saved model costs are used where available."}</p>
        </div></details>
      </>}
    </div></div>
  </>;
}

export function ModelTable({ models }: { models: WebModelUsage[] }) {
  return <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>Model</th>{categories.map(c => <th key={c.key}>{c.label}</th>)}<th>Est. USD</th></tr></thead><tbody>{models.map(model => <tr key={`${model.provider}/${model.model}`}><td>{model.model}<small>{model.provider}</small></td>{categories.map(c => <td key={c.key}>{number(model[c.key])}</td>)}<td><Cost usage={model} /></td></tr>)}</tbody></table></div>;
}

export function UsageGraphs({ daily }: { daily: WebUsageReport["daily"] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const id = useId();
  if (!daily.length) return null;
  const index = Math.min(selected ?? daily.length - 1, daily.length - 1);
  const day = daily[index]!;
  const width = 640, height = 200, left = 56, right = 12, bottom = 26, top = 16;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const step = plotWidth / daily.length;
  const x = (i: number) => left + step * (i + 0.5);
  const maxTokens = Math.max(1, ...daily.map(d => d.totalTokens));
  const maxCost = Math.max(0.01, ...daily.map(d => d.estimatedCostUsd ?? 0));
  const y = (value: number, max: number) => top + plotHeight * (1 - value / max);
  const costSegments: string[] = [];
  let drawing = false;
  daily.forEach((d, i) => {
    if (d.estimatedCostUsd === null && (d.recordedTurns > 0 || d.missingUsageTurns > 0)) { drawing = false; return; }
    costSegments.push(`${drawing ? "L" : "M"}${x(i)},${y(d.estimatedCostUsd ?? 0, maxCost)}`);
    drawing = true;
  });
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const axes = (max: number, cost: boolean) => <>{[0, 0.5, 1].map(fraction => <g key={fraction}><line x1={left} x2={width - right} y1={y(fraction * max, max)} y2={y(fraction * max, max)} className="usage-grid-line" /><text x={left - 8} y={y(fraction * max, max) + 4} textAnchor="end">{cost ? `$${Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 }).format(fraction * max)}` : compact(fraction * max)}</text></g>)}<text x={left} y={height - 5}>{dateLabel(daily[0]!.date)}</text><text x={width - right} y={height - 5} textAnchor="end">{dateLabel(daily.at(-1)!.date)}</text></>;
  const targets = daily.map((d, i) => <rect key={d.date} x={left + step * i} y={top} width={step} height={plotHeight} fill="transparent" onMouseEnter={() => setSelected(i)} onClick={() => setSelected(i)}><title>{d.date}: {number(d.totalTokens)} tokens; {money(d.estimatedCostUsd)}</title></rect>);
  return <section className="usage-graphs" aria-label="Daily usage graphs">
    <div className="usage-chart"><h3>Tokens per day</h3><div className="usage-legend">{categories.map(c => <span key={c.key}><i style={{ background: c.color }} />{c.label}</span>)}</div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily stacked token counts. Use the day selector below for exact values.">{axes(maxTokens, false)}{daily.map((d, i) => {
      let sum = 0;
      return <g key={d.date}>{categories.map(c => { const value = d[c.key]; sum += value; return <rect key={c.key} x={x(i) - Math.max(1, step * 0.7) / 2} y={y(sum, maxTokens)} width={Math.max(1, step * 0.7)} height={value / maxTokens * plotHeight} fill={c.color} />; })}</g>;
    })}<line className="usage-cursor" x1={x(index)} x2={x(index)} y1={top} y2={height - bottom} />{targets}</svg></div>
    <div className="usage-chart"><h3>Estimated cost per day</h3><p className="usage-chart-unit">USD · Available estimates</p><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily estimated cost in US dollars. Use the day selector below for exact values.">{axes(maxCost, true)}<path d={costSegments.join(" ")} fill="none" stroke="var(--primary)" strokeWidth={2} />{daily.map((d, i) => d.estimatedCostUsd !== null ? <circle key={d.date} cx={x(i)} cy={y(d.estimatedCostUsd, maxCost)} r={daily.length < 100 ? 3 : 1} fill="var(--primary)" /> : null)}<line className="usage-cursor" x1={x(index)} x2={x(index)} y1={top} y2={height - bottom} />{targets}</svg></div>
    <div className="usage-day-detail"><label htmlFor={id}>Inspect day <strong>{day.date}</strong></label><input id={id} type="range" min={0} max={daily.length - 1} value={index} onChange={e => setSelected(Number(e.target.value))} aria-valuetext={day.date} /><p>{number(day.totalTokens)} tokens · <Cost usage={day} /></p><TokenBreakdown usage={day} /></div>
  </section>;
}
