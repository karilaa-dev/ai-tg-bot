import { useEffect, useId, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import type { WebMessageUsage, WebModelUsage, WebUsageReport, WebUsageTotals } from "../types.js";
import { userLabel } from "../types.js";
import { Button } from "./components/ui/button.js";
import { apiJson } from "./api.js";
import type { InferenceUsageCall } from "../../pi/usage.js";

const number = (n: number) => n.toLocaleString();
const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const money = (n: number | null) => n === null ? "Unavailable" : n > 0 && n < 0.0001 ? "<$0.0001" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
const percent = (n: number | null) => n === null ? "Unavailable" : `${(n * 100).toFixed(1)}%`;
const categories = [
  { key: "inputTokens", label: "Uncached input", color: "var(--usage-input)" },
  { key: "cacheReadTokens", label: "Cache reads", color: "var(--usage-read)" },
  { key: "cacheWriteTokens", label: "Reported cache writes", color: "var(--usage-write)" },
  { key: "outputTokens", label: "Output", color: "var(--usage-output)" },
] as const;

function Cost({ usage }: { usage: WebUsageTotals }) {
  return <>{money(usage.estimatedCostUsd)}{usage.estimatedCostUsd !== null && (usage.unpricedTurns > 0 || usage.missingUsageTurns > 0) && <small className="partial-cost"> partial</small>}</>;
}

function recordUnit(usage: WebUsageTotals) { return usage.aggregateUsageEntries > 0 ? "usage records" : "calls"; }

function cacheReporting(usage: WebUsageTotals, key: "cacheReadTokens" | "cacheWriteTokens") {
  const reported = (key === "cacheReadTokens" ? usage.cacheReadReportedCalls : usage.cacheWriteReportedCalls) ?? 0;
  const unreported = (key === "cacheReadTokens" ? usage.cacheReadUnreportedCalls : usage.cacheWriteUnreportedCalls) ?? 0;
  return { reported, unreported, total: reported + unreported };
}

function tokenValue(usage: WebUsageTotals, key: typeof categories[number]["key"]) {
  if (key === "cacheReadTokens" || key === "cacheWriteTokens") {
    const { reported } = cacheReporting(usage, key);
    if (usage[key] === 0 && !reported && usage.recordedTurns > 0) return "Not reported";
  }
  return number(usage[key]);
}

export function TokenBreakdown({ usage }: { usage: WebUsageTotals }) {
  return <dl className="token-breakdown">{categories.map(category => <div key={category.key}><dt><i style={{ background: category.color }} />{category.label}</dt><dd>{tokenValue(usage, category.key)}</dd>{(category.key === "cacheReadTokens" || category.key === "cacheWriteTokens") && usage.recordedTurns > 0 && <small className="token-reporting">{(() => {
    const { reported, total } = cacheReporting(usage, category.key);
    return total ? `Reported in ${number(reported)} of ${number(total)} ${recordUnit(usage)}` : "Reporting coverage unknown";
  })()}</small>}</div>)}
    <div><dt>Reported reasoning</dt><dd>{usage.reasoningTokens === null ? "Not reported" : number(usage.reasoningTokens)}</dd></div>
  </dl>;
}

export function CacheExplanation() {
  return <details className="cache-explanation"><summary>Why can cache reads be much higher than writes?</summary><div>
    <p>A prompt can be written once and reused across many requests. Each reuse adds cache-read tokens, so reads can far exceed writes.</p>
    <p>Write reporting varies by provider, model, and saved response. Missing fields are unknown, not measured zeroes. Reported cache writes include only recorded values; the bot does not estimate missing writes from reads or uncached input.</p>
    <p><a href="https://developers.openai.com/api/docs/guides/prompt-caching" target="_blank" rel="noreferrer">OpenAI prompt caching</a><span aria-hidden="true"> · </span><a href="https://platform.claude.com/docs/en/build-with-claude/prompt-caching" target="_blank" rel="noreferrer">Claude prompt caching</a></p>
  </div></details>;
}

export function FastModeSummary({ usage }: { usage: WebUsageTotals }) {
  const on = usage.fastModeCalls ?? 0, off = usage.standardModeCalls ?? 0, unknown = usage.unknownFastModeCalls ?? 0;
  if (!on && !off && !unknown) return usage.recordedTurns ? <p className="fast-mode-summary">Fast mode not recorded</p> : null;
  return <div className="fast-mode-summary" aria-label="Recorded fast mode"><span>Fast mode · {recordUnit(usage)}</span><div><span data-mode="on">On <strong>{number(on)}</strong></span><span data-mode="off">Off <strong>{number(off)}</strong></span><span data-mode="unknown">Unknown <strong>{number(unknown)}</strong></span></div>{unknown > 0 && <small>Unknown records do not show whether fast mode was enabled.</small>}</div>;
}

function CallTokens({ call }: { call: InferenceUsageCall }) {
  const cached = (value: number, reported?: boolean) => value > 0 || reported ? number(value) : "Not reported";
  return <dl className="token-breakdown call-tokens"><div><dt>Uncached input</dt><dd>{number(call.inputTokens)}</dd></div><div><dt>Cache reads</dt><dd>{cached(call.cacheReadTokens, call.cacheReadReported)}</dd></div><div><dt>Reported cache writes</dt><dd>{cached(call.cacheWriteTokens, call.cacheWriteReported)}</dd></div><div><dt>Output</dt><dd>{number(call.outputTokens)}</dd></div><div><dt>Reasoning</dt><dd>{call.reasoningTokens === undefined ? "Not reported" : number(call.reasoningTokens)}</dd></div></dl>;
}

export function UsageCalls({ calls }: { calls?: InferenceUsageCall[] }) {
  if (!calls?.length) return <p className="usage-call-unavailable">Individual call details were not saved for this reply.</p>;
  return <details className="usage-calls"><summary>Inspect {number(calls.length)} recorded {calls.some(call => call.aggregate) ? "usage records" : calls.length === 1 ? "call" : "calls"}</summary><ol>{calls.map((call, index) => <li key={index}>
    <header><div><span className="utility-label">{call.aggregate ? "Usage record" : "Call"} {index + 1}</span><strong>{call.model}</strong><span>{call.provider}{call.source ? ` · ${call.source}` : ""}</span></div><span className="fast-mode-badge" data-mode={call.fastMode === true ? "on" : call.fastMode === false ? "off" : "unknown"}>Fast mode {call.fastMode === true ? "on" : call.fastMode === false ? "off" : "unknown"}</span></header>
    <dl className="call-service-tier"><div><dt>Requested tier</dt><dd>{call.requestedServiceTier ?? "Not recorded"}</dd></div><div><dt>Delivered tier</dt><dd>{call.serviceTier ?? "Not reported"}</dd></div><div><dt>Recorded total</dt><dd>{number(call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens + call.outputTokens)}</dd></div></dl>
    <CallTokens call={call} />
    {call.aggregate && <p className="usage-call-unavailable">This record combines usage; its individual calls are unavailable.</p>}
  </li>)}</ol></details>;
}

function TokenBar({ usage }: { usage: WebUsageTotals }) {
  return <span className="token-bar" aria-hidden="true">{categories.map(category => <span key={category.key} style={{ background: category.color, width: `${usage.totalTokens ? usage[category.key] / usage.totalTokens * 100 : 0}%` }} />)}</span>;
}

export function MessageUsage({ usage }: { usage?: WebMessageUsage | null }) {
  if (!usage?.recordedTurns) return <span className="usage-unavailable">Usage not recorded</span>;
  return <details className="message-usage"><summary>{compact(usage.totalTokens)} tokens · <Cost usage={usage} /></summary>
    <div className="message-usage-content"><UsageDetails usage={usage} models={usage.models} modelCalls={usage.modelCalls} /><UsageCalls calls={usage.calls} />
      <p>Totals include saved usage for this reply. Tools and older calls may not report every field. Reasoning is included in output. Price is an API estimate in USD.</p>
    </div>
  </details>;
}

function UsageDetails({ usage, models, modelCalls }: {
  usage: WebUsageTotals; models: WebModelUsage[]; modelCalls?: number | null;
}) {
  return <><div className="usage-exact-total"><span>Recorded token total</span><strong>{number(usage.totalTokens)}</strong></div><TokenBar usage={usage} /><TokenBreakdown usage={usage} /><FastModeSummary usage={usage} /><CacheExplanation />
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
        const value = await apiJson<WebUsageReport>(`/api/usage?${query}`, { signal: controller.signal });
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
  const displayTitle = userId && report?.user?.id === userId ? userLabel(report.user) : title;
  return <>
    <header className="pane-header usage-header"><Button variant="ghost" size="icon-sm" onClick={back} aria-label="Back to conversations"><ArrowLeft /></Button><div><h2>Usage & estimated cost</h2><p>{displayTitle}</p></div>
      <Button variant="ghost" size="icon-sm" onClick={retry} disabled={busy} aria-label="Refresh usage"><RefreshCw /></Button>
    </header>
    <div className="usage-scroll"><div className="usage-dashboard">
      <div className="usage-controls"><div>{userId && <Button variant="outline" onClick={all}>All usage</Button>}<span>Daily totals in UTC</span></div><label>Period <select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={0}>All time</option></select></label></div>
      {error && <div role="alert" className="failure">{error}<Button onClick={retry}>Retry</Button></div>}
      {!report && busy && <p className="loading" role="status">Loading usage…</p>}
      {report && <>
        <div className="usage-stats">
          <div><span>Estimated cost · USD</span><strong><Cost usage={report.totals} /></strong><small>API equivalent</small></div>
          <div><span>Recorded tokens</span><strong title={number(report.totals.totalTokens)}>{compact(report.totals.totalTokens)}</strong><small>{number(report.totals.totalTokens)} tokens exactly</small></div>
          <div><span>Cache hit rate</span><strong>{percent(report.totals.cacheReadRatio)}</strong><small>Share of prompt tokens read from cache</small></div>
          <div><span>Recorded turns</span><strong>{number(report.totals.recordedTurns)}</strong><small>{report.threads.length} {report.threads.length === 1 ? "thread" : "threads"} in this period</small></div>
        </div>
        <div className="usage-token-summary"><TokenBar usage={report.totals} /><TokenBreakdown usage={report.totals} /><FastModeSummary usage={report.totals} /><CacheExplanation /></div>
        {(report.totals.missingUsageTurns > 0 || report.totals.unpricedTurns > 0) && <p className="usage-coverage">{report.totals.missingUsageTurns > 0 && `${number(report.totals.missingUsageTurns)} replies or turns have no saved usage. `}{report.totals.unpricedTurns > 0 && `${number(report.totals.unpricedTurns)} recorded turns have incomplete pricing. `}Totals include only available data.</p>}
        {report.dailyTruncated && <p className="usage-coverage">Graphs show the latest 365 days of this period. Totals and tables include the entire period.</p>}
        {!report.totals.recordedTurns ? <div className="notice"><h3>No recorded usage in this period</h3><p>Try a longer period. New bot replies will appear here after the model finishes.</p></div> : <UsageGraphs daily={report.daily} />}
        {report.models.length > 0 && <section className="usage-section"><h3>By model</h3><ModelTable models={report.models} /></section>}
        {report.threads.length > 0 && <section className="usage-section"><h3>By thread</h3><div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>Thread</th><th>Tokens</th><th>Cache hit</th><th>Turns</th><th>Est. USD</th></tr></thead><tbody>{report.threads.map(thread => <tr key={thread.id}>
          <td><button className="usage-thread-link" onClick={() => openThread(thread.userId, thread.id, true)}>{thread.title}</button><small>#{thread.id}{thread.archived ? " · Archived" : ""} · <button onClick={() => openThread(thread.userId, thread.id, false)}>Messages <ArrowUpRight size={11} /></button></small></td>
          <td>{number(thread.totalTokens)}<TokenBar usage={thread} /></td><td>{percent(thread.cacheReadRatio)}</td><td>{number(thread.recordedTurns)}{thread.missingUsageTurns > 0 && <small>{number(thread.missingUsageTurns)} untracked</small>}</td><td><Cost usage={thread} /></td>
        </tr>)}</tbody></table></div></section>}
        <details className="usage-method"><summary>How usage and estimates work</summary><div>
          <p>Estimates use the <a href="https://ccusage.com/guide/cost-modes" target="_blank" rel="noreferrer">ccusage token calculation method</a>: uncached input × input rate + cache reads × cache-read rate + cache writes × cache-write rate + output × output rate.</p>
          <p>Reasoning tokens are part of output and are not counted twice. The cache hit rate is recorded cache reads divided by recorded prompt tokens. Uncached input, cache reads, and cache writes are separate parts of input; a missing cache field does not establish a zero value.</p>
          <p>Fast mode reflects saved request settings. Requested and delivered service tiers can differ; the delivered tier takes precedence when pricing is available. A request without a reported delivery tier uses its requested tier for the estimate. Older records without this metadata show unknown fast mode.</p>
          <p>Prices use the current LiteLLM catalog, with saved model costs as a fallback. These USD estimates are not an invoice or a subscription charge. Calls with unavailable pricing remain unpriced. Tool usage is included only when reported and saved; separate tool fees may be missing. Historical estimates may change when model prices change.</p>
          <p>Forked messages keep their original usage. Thread totals include only work performed in that thread. Recorded context-summary and tool tokens are included even when their model is unknown. Combined historical records count as usage records, not individual calls. Failed or cancelled turns are included when usage was saved; older messages and interrupted work may have no usage.</p>
          <p>{report.pricing.fetchedAt ? `Prices fetched ${new Date(report.pricing.fetchedAt).toLocaleString()}.${report.pricing.stale ? " Refresh unavailable; using the last successful download." : " Refreshed daily."}` : "Pricing catalog unavailable. Saved model costs are used where available."}</p>
        </div></details>
      </>}
    </div></div>
  </>;
}

export function ModelTable({ models }: { models: WebModelUsage[] }) {
  return <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>Model</th>{categories.map(c => <th key={c.key}>{c.label}</th>)}<th>Fast mode</th><th>Est. USD</th></tr></thead><tbody>{models.map(model => <tr key={`${model.provider}/${model.model}`}><td>{model.model}<small>{model.provider}</small></td>{categories.map(c => <td key={c.key}>{tokenValue(model, c.key)}{c.key === "cacheWriteTokens" && <small>{(() => { const reporting = cacheReporting(model, c.key); return reporting.total ? `${number(reporting.reported)} / ${number(reporting.total)} ${recordUnit(model)} reported` : "Coverage unknown"; })()}</small>}</td>)}<td><span>On {number(model.fastModeCalls ?? 0)}</span><small>Off {number(model.standardModeCalls ?? 0)} · Unknown {number(model.unknownFastModeCalls ?? 0)}</small></td><td><Cost usage={model} /></td></tr>)}</tbody></table></div>;
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
