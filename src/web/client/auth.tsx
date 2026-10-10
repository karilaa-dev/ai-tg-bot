import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Input } from "@base-ui/react/input";
import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";
import { BrandMark } from "./brand.js";
import { ApiError, apiJson, SESSION_EXPIRED_EVENT } from "./api.js";
import { Button } from "./components/ui/button.js";

export function AdminGate({ children }: { children: (logout: () => Promise<void>, signingOut: boolean, error: string) => ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const [checkError, setCheckError] = useState("");
  const [revision, setRevision] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const expire = () => { generation.current++; setAuthenticated(false); setMessage("Your session expired. Sign in again to continue."); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const check = async () => {
      if (busy || document.hidden) return;
      busy = true;
      const current = generation.current;
      try {
        const session = await apiJson<{ authenticated: boolean }>("/api/auth/session", { signal: controller.signal });
        if (!controller.signal.aborted && current === generation.current) {
          if (authenticated && !session.authenticated) setMessage("Your session expired. Sign in again to continue.");
          setAuthenticated(session.authenticated); setCheckError("");
        }
      } catch (error) {
        if (!controller.signal.aborted && !(error instanceof ApiError && error.status === 401)) setCheckError("Could not check your session. Check your connection and try again.");
      } finally { busy = false; }
    };
    // Signed-out pages stay signed out until the user submits a token.
    if (authenticated === false) return;
    void check();
    const timer = setInterval(() => void check(), 60_000);
    const visible = () => { if (!document.hidden) void check(); };
    window.addEventListener("focus", visible);
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", visible); window.removeEventListener("pageshow", visible); document.removeEventListener("visibilitychange", visible); };
  }, [authenticated, revision]);

  const logout = async () => {
    generation.current++;
    setSigningOut(true); setLogoutError("");
    try {
      await apiJson("/api/auth/session", { method: "DELETE" });
      generation.current++; setAuthenticated(false); setMessage("You signed out.");
      history.replaceState(null, "", "/");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setLogoutError("Could not sign out. Check your connection and try again.");
    } finally { setSigningOut(false); }
  };

  if (authenticated) return children(logout, signingOut, logoutError);
  return <div className="access-page">
    <header className="access-brand"><BrandMark /><span>AI KaRiLaA<span className="brand-divider">/</span><span className="utility-label">Admin</span></span></header>
    <main className="access-main">
      <section className="access-form" aria-labelledby="access-title">
        <div className="access-lock"><LockKeyhole size={20} aria-hidden="true" /></div>
        <h1 id="access-title">Admin access</h1>
        {authenticated === null ? <>{checkError ? <div className="failure" role="alert">{checkError}<Button onClick={() => setRevision(v => v + 1)}>Try again</Button></div> : <p className="access-check" role="status"><LoaderCircle className="activity-spinner" size={16} aria-hidden="true" /> Checking your session…</p>}</> : <LoginForm message={message} onSuccess={() => { generation.current++; setMessage(""); setAuthenticated(true); }} />}
      </section>
    </main>
  </div>;
}

export function LoginForm({ onSuccess, message = "" }: { onSuccess: () => void; message?: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true); setError("");
    try {
      await apiJson("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) });
      onSuccess();
    } catch (error) {
      setError(error instanceof ApiError && error.status === 401 ? "That admin token was not accepted. Check it and try again."
        : error instanceof ApiError && error.status === 429 ? "Too many sign-in attempts. Wait a minute before trying again."
        : error instanceof ApiError && error.status === 503 ? "Admin access is not configured. Set the admin token in the server environment."
        : "Could not sign in. Check your connection and try again.");
    } finally { setToken(""); setBusy(false); }
  };
  return <Form className="access-token-form" onSubmit={event => void submit(event)}>
    {message && !error && <p className="form-message" role="status">{message}</p>}
    <Field.Root name="password" className="access-field" invalid={Boolean(error)} disabled={busy}>
      <Field.Label>Admin token</Field.Label>
      <Input id="admin-token" type="password" autoComplete="current-password" autoFocus required value={token} onValueChange={value => { setToken(value); setError(""); }} placeholder="Enter your admin token" />
      <Field.Description className="access-hint">Use the admin token configured for this bot.</Field.Description>
      <Field.Error className="form-error" match={error ? true : undefined} role="alert">{error || undefined}</Field.Error>
    </Field.Root>
    <Button type="submit" variant="primary" className="access-submit" disabled={busy || !token.trim()}>{busy ? <><LoaderCircle className="activity-spinner" /> Signing in…</> : <>Sign in <ArrowRight /></>}</Button>
  </Form>;
}
