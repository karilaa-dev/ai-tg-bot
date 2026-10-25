import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconArrowLeft, IconBrandTelegram, IconLoader2, IconRefresh } from "@tabler/icons-react";
import type { ChatSession } from "../chat-types.js";
import { logo } from "./brand.js";
import { apiJson, SESSION_EXPIRED_EVENT } from "./api.js";
import { Button, buttonVariants } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

type AdminState =
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "signed-out"; loginAvailable: boolean; ended: boolean }
  | { kind: "not-admin"; name: string; id: number }
  | { kind: "admin" };

/** The admin dashboard uses the website's Telegram session; WEB_ADMIN_USER_IDS decides who gets in. */
export function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminState>({ kind: "checking" });
  const [revision, setRevision] = useState(0);
  const admitted = useRef(false);

  useEffect(() => {
    const expired = () => setRevision(v => v + 1);
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const check = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const session = await apiJson<ChatSession>("/api/chat/session", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!session.authenticated) setState({ kind: "signed-out", loginAvailable: session.loginAvailable, ended: admitted.current });
        else if (session.admin) setState({ kind: "admin" });
        else setState({ kind: "not-admin", id: session.user.id, name: session.user.name || (session.user.username ? `@${session.user.username}` : `Telegram user ${session.user.id}`) });
        admitted.current = session.authenticated && session.admin;
      } catch {
        // A brief outage keeps an open dashboard; requests inside it report their own failures.
        if (!controller.signal.aborted && !admitted.current) setState({ kind: "unreachable" });
      } finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    const visible = () => { if (!document.hidden) void check(); };
    window.addEventListener("focus", visible);
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", visible); window.removeEventListener("pageshow", visible); document.removeEventListener("visibilitychange", visible); };
  }, [revision]);

  if (state.kind === "admin") return children;
  return <main className="access-page">
    <section className="access-panel" aria-labelledby="access-title" aria-busy={state.kind === "checking"}>
      <img className="access-logo" src={logo} alt="" width={56} height={56} />
      <h1 id="access-title">Admin</h1>
      <p className="access-lede">AI KaRiLaA conversations, usage, and connections.</p>
      <div className="access-slot">
        {state.kind === "checking" && <p className="access-check" role="status"><IconLoader2 className="activity-spinner" size={16} aria-hidden="true" /> Checking your session…</p>}
        {state.kind === "unreachable" && <>
          <p className="access-note is-error" role="alert">Could not check your session. Check your connection and try again.</p>
          <Button className="access-submit" onClick={() => { setState({ kind: "checking" }); setRevision(v => v + 1); }}><IconRefresh aria-hidden="true" /> Try again</Button>
        </>}
        {state.kind === "signed-out" && <>
          {state.ended && <p className="access-note" role="status">Your session ended. Sign in again to continue.</p>}
          {state.loginAvailable
            ? <a className={cn(buttonVariants({ variant: "primary" }), "access-submit")} href="/api/auth/telegram/start?return=/admin"><IconBrandTelegram aria-hidden="true" /> Sign in with Telegram</a>
            : <p className="access-note" role="note">Telegram sign-in is not available. Check the website's Telegram login settings.</p>}
        </>}
        {state.kind === "not-admin" && <>
          <p className="access-note" role="status">You're signed in as <strong>{state.name}</strong> (Telegram ID {state.id}), which isn't an admin account.</p>
          <a className={cn(buttonVariants(), "access-submit")} href="/"><IconArrowLeft aria-hidden="true" /> Back to chat</a>
        </>}
      </div>
    </section>
  </main>;
}
