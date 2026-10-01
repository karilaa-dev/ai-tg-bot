import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CheckCheck, CircleAlert, Copy, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { CodexStatus } from "../admin-types.js";
import { apiJson } from "./api.js";
import { Button, buttonVariants } from "./components/ui/button.js";

/** Device authorization never sends the admin to a URL supplied by an arbitrary host. */
export function trustedVerificationUri(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function CodexConnection() {
  const [data, setData] = useState<CodexStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const mutating = useRef(false);
  const generation = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const pending = data?.login.status === "pending" || data?.login.status === "starting";

  useEffect(() => () => actionController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || mutating.current || document.hidden) return;
      fetching = true;
      const current = generation.current;
      try {
        const status = await apiJson<CodexStatus>("/api/admin/codex", { signal: controller.signal });
        if (!controller.signal.aborted && current === generation.current) { setData(status); setError(""); }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load the Codex connection."); }
      finally { fetching = false; }
    };
    void load();
    const timer = setInterval(() => void load(), pending ? 2_000 : 15_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [pending, revision]);
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pending]);
  useEffect(() => { setCopied(false); setCopyError(""); }, [data?.login.userCode]);

  const changeLogin = async (method: "POST" | "DELETE") => {
    if (mutating.current) return;
    mutating.current = true; generation.current++; setBusy(true); setError("");
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const status = await apiJson<CodexStatus>("/api/admin/codex/login", { method, signal: controller.signal });
      if (!controller.signal.aborted) { setData(status); setRevision(value => value + 1); }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not update the Codex connection. Try again."); }
    finally { mutating.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const copy = async () => {
    if (!data?.login.userCode) return;
    try { await navigator.clipboard.writeText(data.login.userCode); setCopied(true); setCopyError(""); }
    catch { setCopyError("Select the code and copy it manually."); }
  };

  const login = data?.login;
  const available = data?.credentialStatus === "available";
  const verificationUri = trustedVerificationUri(login?.verificationUri);
  const seconds = login?.expiresAt ? Math.max(0, Math.ceil((login.expiresAt - now) / 1000)) : null;
  const expired = login?.status === "expired" || Boolean(pending && seconds === 0);
  const waiting = pending && !expired;
  const statusLabel = available ? "Credentials saved" : data?.credentialStatus === "invalid" ? "Sign-in needed" : "Not connected";

  return <>
    <header className="pane-header settings-header"><div><h2>Codex connection</h2><p>Manage the account your bot uses for Codex.</p></div><Button variant="ghost" size="icon-sm" aria-label="Refresh Codex status" onClick={() => setRevision(value => value + 1)} disabled={busy}><RefreshCw /></Button></header>
    <div className="settings-scroll"><div className="connection-page" data-pending={waiting || undefined}>
      <div className="connection-heading"><span className="eyebrow">Account access</span><h1>Sign in with ChatGPT</h1><p>Connect or sign in again with your ChatGPT account. Finish the approval in your browser, right from here.</p></div>
      {error && <div className="failure" role="alert">{error}<Button onClick={() => setRevision(value => value + 1)}>Retry</Button></div>}
      {!data ? !error && <p className="loading inline-loading" role="status"><LoaderCircle className="activity-spinner" size={16} /> Checking Codex credentials…</p> : <>
        <section className="connection-status" aria-label="Current Codex connection"><div className="connection-symbol"><KeyRound size={23} aria-hidden="true" /></div><div><h2>ChatGPT account</h2><p>{available ? "Saved credentials are available to the bot." : data.credentialStatus === "invalid" ? "The saved credentials need to be replaced." : "Sign in to let your bot use Codex."}</p></div><span className="status-pill" data-status={available ? "available" : "missing"}><span aria-hidden="true" />{statusLabel}</span></section>
        {login?.status === "success" && <div className="connection-success" role="status"><CheckCheck size={19} /><div><strong>Codex is ready</strong><p>Your new credentials are saved. The bot will use them for its next request.</p></div></div>}
        {waiting ? <section className="device-login" aria-labelledby="device-heading">
          <div className="device-heading"><span className="eyebrow"><LoaderCircle className="activity-spinner" size={14} /> Waiting for approval</span><Button variant="ghost" size="sm" onClick={() => void changeLogin("DELETE")} disabled={busy}><X /> Cancel</Button></div>
          <h2 id="device-heading">Approve your Codex sign-in</h2><p>Open the OpenAI sign-in page and enter this one-time code.</p>
          {login?.userCode && verificationUri ? <>
            <div className="device-code"><span className="utility-label">One-time code</span><div><code aria-label="One-time sign-in code" tabIndex={0}>{login.userCode}</code><Button variant="ghost" size="icon-sm" aria-label={copied ? "Code copied" : "Copy sign-in code"} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button></div><span className="code-copy-feedback" role="status">{copyError || (copied ? "Copied to clipboard" : "Only enter this code on the OpenAI sign-in page.")}</span></div>
            <div className="device-actions"><a className={`${buttonVariants()} primary-action`} href={verificationUri} target="_blank" rel="noopener noreferrer">Continue to OpenAI <ArrowUpRight /></a><span className="device-expiry">{seconds !== null ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Keep this page open or return after approval."}</span></div>
            <p className="device-help">This page updates automatically when you finish signing in.</p>
          </> : <p className="inline-loading" role="status"><LoaderCircle className="activity-spinner" size={16} /> Preparing your sign-in code…</p>}
        </section> : <section className="connection-action">
          {(expired || login?.status === "error" || login?.status === "cancelled") && <div className={login?.status === "cancelled" ? "connection-note" : "failure"} role="status"><CircleAlert size={17} /><p>{expired ? "This sign-in code expired. Start again to get a new code." : login?.status === "cancelled" ? "Sign-in cancelled. You can start again whenever you are ready." : login?.error || "Codex sign-in did not finish. Try again."}</p></div>}
          <div><h2>{available ? "Sign in again" : "Connect your account"}</h2><p>{available ? "Refresh your access or switch to another ChatGPT account." : "Get a one-time code, then approve access with OpenAI."}</p></div><Button className="primary-action" onClick={() => void changeLogin("POST")} disabled={busy}>{busy ? <><LoaderCircle className="activity-spinner" /> Starting sign-in…</> : <>{available ? "Sign in again" : "Connect Codex"}<ArrowUpRight /></>}</Button>
        </section>}
        <aside className="connection-help"><ShieldCheck size={18} aria-hidden="true" /><div><h3>Before you sign in</h3><p>Enable device code login in your ChatGPT security settings. OpenAI will ask you to approve this bot's access in a separate tab.</p><a href="https://chatgpt.com/#settings/Security" target="_blank" rel="noopener noreferrer">Open ChatGPT settings <ArrowUpRight size={13} /></a></div></aside>
      </>}
    </div></div>
  </>;
}
