import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { IconAlertCircle, IconBrandTelegram, IconLock, IconRefresh } from "@tabler/icons-react";
import type { ChatProfile } from "../../chat-types.js";
import { loginReturnPath, type LoginFailure } from "../../login-return.js";
import { logo } from "../brand.js";
import { UiLanguageContext } from "../i18n.js";
import { useLoginFailure } from "../login-failure.js";
import { CHAT_SESSION_EXPIRED_EVENT, ChatApiError, bindChatRequests, chatApi, invalidateChatRequests } from "./api.js";
import { clearStoredDrafts, DraftStore } from "./drafts.js";
import { deviceLanguage, DocumentLanguage } from "./preferences.js";
import { useChatStrings } from "./strings.js";

// Lets the page start downloading the workspace while the session is checked. It holds no account data.
const SIGNED_IN_HINT = "chat-signed-in";
const SIGN_OUT_INTENT = "chat-sign-out";
export function probablySignedIn(): boolean {
  try { return localStorage.getItem(SIGNED_IN_HINT) === "1"; } catch { return false; }
}
function rememberSignedIn(signedIn: boolean) {
  try { if (signedIn) localStorage.setItem(SIGNED_IN_HINT, "1"); else localStorage.removeItem(SIGNED_IN_HINT); } catch { /* Storage can be disabled. */ }
}

function pendingSignOut(): number | undefined {
  try {
    const userId = Number(sessionStorage.getItem(SIGN_OUT_INTENT));
    if (Number.isSafeInteger(userId) && userId > 0) return userId;
  } catch { /* Storage can be disabled. */ }
}

function rememberSignOut(userId: number | null) {
  try {
    if (userId === null) sessionStorage.removeItem(SIGN_OUT_INTENT);
    else sessionStorage.setItem(SIGN_OUT_INTENT, String(userId));
  } catch { /* Keep the intent in memory while this page is open. */ }
}

export interface SignedIn { user: ChatProfile; botUsername: string; admin: boolean; drafts: DraftStore }

type Notice = "none" | "signed-out" | "session-ended";
type GateState =
  | { kind: "checking" | "signing-out" }
  | { kind: "unreachable"; notice: Notice }
  | { kind: "sign-out-failed"; userId: number }
  | { kind: "signed-out"; loginAvailable: boolean; notice: Notice }
  | { kind: "signed-in"; session: SignedIn };

/** The signed-out frame; the workspace reuses it while it learns the account's language. */
export function AccessFrame({ busy, children }: { busy: boolean; children: ReactNode }) {
  const t = useChatStrings();
  return <main className="chat-access">
    <section className="chat-access-panel" aria-labelledby="chat-access-title" aria-busy={busy}>
      <img className="chat-access-logo" src={logo} alt="" width={56} height={56} />
      <h1 id="chat-access-title">{t.appName}</h1>
      <p className="chat-access-lede">{t.signInDescription}</p>
      <div className="chat-access-slot">{children}</div>
    </section>
  </main>;
}

export function WorkspaceLoading() {
  const t = useChatStrings();
  return <AccessFrame busy><p className="chat-access-status" role="status"><Loader size="sm" /> {t.loadingWorkspace}</p></AccessFrame>;
}

/** Shown when the workspace code could not be downloaded; retrying requests it again. */
export function WorkspaceLoadFailed({ retry, updateReady }: { retry: () => void; updateReady: boolean }) {
  const t = useChatStrings();
  const controlled = typeof location !== "undefined" && location.pathname === "/chat/" && navigator.serviceWorker?.controller;
  return <AccessFrame busy={false}>
    <p className="chat-access-note is-error" role="alert"><IconAlertCircle size={16} aria-hidden="true" /><span><strong>{t.serverUnreachable}.</strong> {t.checkConnection}</span></p>
    {updateReady && <p className="chat-access-note" role="status">{t.appUpdateReady}</p>}
    <Button size="lg" variant="secondary" className="chat-access-button" icon={<IconRefresh size={18} aria-hidden="true" />} onClick={retry}>{t.tryAgain}</Button>
    {controlled
      ? <LinkButton size="lg" variant="ghost" className="chat-access-button" href={`/${location.search}`}>{t.openChatInBrowser}</LinkButton>
      : <Button size="lg" variant="ghost" className="chat-access-button" onClick={() => location.reload()}>{t.reloadPage}</Button>}
  </AccessFrame>;
}

export function ChatGate({ children }: { children: (session: SignedIn, signOut: () => Promise<void>) => ReactNode }) {
  const loginFailure = useLoginFailure();
  const [unfinishedSignOut] = useState(pendingSignOut);
  const [state, setState] = useState<GateState>(() => unfinishedSignOut === undefined
    ? { kind: "checking" } : { kind: "sign-out-failed", userId: unfinishedSignOut });
  const [sessionRequest, setSessionRequest] = useState<{ notice: Notice } | null>(() => unfinishedSignOut === undefined ? { notice: "none" } : null);
  const operation = useRef<{ kind: "idle" | "checking" | "signing-out" | "sign-out-failed" }>({
    kind: unfinishedSignOut === undefined ? "idle" : "sign-out-failed",
  });
  const automaticRetryUsed = useRef(false);
  const drafts = useRef<DraftStore | null>(null);
  const endSession = useCallback(() => {
    invalidateChatRequests();
    drafts.current?.close();
    drafts.current = null;
    clearStoredDrafts();
  }, []);

  const check = useCallback(async (signal: AbortSignal, notice: Notice = "none") => {
    if (operation.current.kind === "signing-out" || operation.current.kind === "sign-out-failed") return;
    const attempt = { kind: "checking" } as const;
    operation.current = attempt;
    try {
      const session = await chatApi.session(signal);
      if (signal.aborted || operation.current !== attempt) return;
      automaticRetryUsed.current = false;
      if (session.authenticated) {
        if (drafts.current?.userId !== session.user.id) {
          if (drafts.current) endSession();
          drafts.current = new DraftStore(session.user.id);
          bindChatRequests(session.user.id);
        }
        rememberSignedIn(true);
        setState({ kind: "signed-in", session: { user: session.user, botUsername: session.botUsername, admin: session.admin, drafts: drafts.current } });
      } else {
        endSession();
        rememberSignedIn(false);
        setState({ kind: "signed-out", loginAvailable: session.loginAvailable, notice });
      }
    } catch (error) {
      if (signal.aborted || operation.current !== attempt) return;
      if (error instanceof ChatApiError && error.status === 401) {
        automaticRetryUsed.current = false;
        endSession();
        rememberSignedIn(false);
        setState({ kind: "signed-out", loginAvailable: true, notice });
      } else {
        setState({ kind: "unreachable", notice });
      }
    } finally {
      if (operation.current === attempt) operation.current = { kind: "idle" };
    }
  }, [endSession]);

  useEffect(() => {
    if (!sessionRequest) return;
    const controller = new AbortController();
    void check(controller.signal, sessionRequest.notice);
    return () => controller.abort();
  }, [check, sessionRequest]);

  const retry = useCallback((notice: Notice, automatic = false) => {
    automaticRetryUsed.current = automatic;
    setState({ kind: "checking" });
    setSessionRequest({ notice });
  }, []);

  useEffect(() => {
    if (state.kind !== "unreachable") return;
    let checking = false;
    const reconnect = () => {
      if (checking || document.hidden || !navigator.onLine) return;
      checking = true;
      retry(state.notice, true);
    };
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    // A navigation can initialize with an online signal even if its first request lost connectivity.
    const timer = automaticRetryUsed.current ? undefined : setTimeout(reconnect, 1_500);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
    };
  }, [state, retry]);

  useEffect(() => {
    const controller = new AbortController();
    const expired = () => {
      if (operation.current.kind === "signing-out" || operation.current.kind === "sign-out-failed") return;
      automaticRetryUsed.current = false;
      endSession();
      setState({ kind: "checking" });
      void check(controller.signal, "session-ended");
    };
    window.addEventListener(CHAT_SESSION_EXPIRED_EVENT, expired);
    return () => { controller.abort(); window.removeEventListener(CHAT_SESSION_EXPIRED_EVENT, expired); };
  }, [check, endSession]);

  useEffect(() => () => { endSession(); }, [endSession]);

  const signOut = useCallback(async (userId = drafts.current?.userId) => {
    if (userId === undefined || operation.current.kind === "signing-out") return;
    operation.current = { kind: "signing-out" };
    rememberSignOut(userId);
    const logout = chatApi.logout(userId);
    endSession();
    rememberSignedIn(false);
    setState({ kind: "signing-out" });
    try {
      await logout;
    } catch (error) {
      if (!(error instanceof ChatApiError) || error.status !== 401) {
        operation.current = { kind: "sign-out-failed" };
        setState({ kind: "sign-out-failed", userId });
        return;
      }
    }
    operation.current = { kind: "idle" };
    rememberSignOut(null);
    history.replaceState(null, "", location.pathname);
    setState({ kind: "signed-out", loginAvailable: true, notice: "signed-out" });
  }, [endSession]);

  if (state.kind === "signed-in") return children(state.session, signOut);
  // Before an account is known, use the last interface language on this device.
  const language = deviceLanguage();
  return <UiLanguageContext.Provider value={language}>
    <DocumentLanguage language={language} />
    <SignedOut state={state} retry={() => {
      if (state.kind === "sign-out-failed") void signOut(state.userId);
      else if (state.kind === "unreachable") retry(state.notice);
    }} loginFailure={loginFailure} />
  </UiLanguageContext.Provider>;
}

function SignedOut({ state, retry, loginFailure }: { state: Exclude<GateState, { kind: "signed-in" }>; retry: () => void; loginFailure?: LoginFailure }) {
  const t = useChatStrings();
  const returnTo = loginReturnPath(window.location.pathname + window.location.search);
  const signInUrl = `/api/auth/telegram/start${returnTo === "/" ? "" : `?return=${encodeURIComponent(returnTo)}`}`;
  const checking = state.kind === "checking" || state.kind === "signing-out";
  return <AccessFrame busy={checking}>
    {checking && <p className="chat-access-status" role="status"><Loader size="sm" /> {t.checkingSession}</p>}
    {(state.kind === "unreachable" || state.kind === "sign-out-failed") && <>
      <p className="chat-access-note is-error" role="alert"><IconAlertCircle size={16} aria-hidden="true" /><span>{state.kind === "sign-out-failed" ? t.signOutFailed : <><strong>{t.serverUnreachable}.</strong> {t.checkConnection}</>}</span></p>
      <Button size="lg" variant="secondary" className="chat-access-button" icon={<IconRefresh size={18} aria-hidden="true" />} onClick={retry}>{t.tryAgain}</Button>
    </>}
    {state.kind === "signed-out" && <>
      {loginFailure && <p className="chat-access-note is-error" role="alert">{t.loginFailure[loginFailure]}</p>}
      {state.notice !== "none" && <p className="chat-access-note" role="status">{state.notice === "signed-out" ? t.signedOutNotice : t.sessionEnded}</p>}
      {state.loginAvailable
        ? <LinkButton variant="primary" size="lg" className="chat-access-button" href={signInUrl}><IconBrandTelegram size={18} aria-hidden="true" />{t.signInWithTelegram}</LinkButton>
        : <p className="chat-access-note" role="note"><IconLock size={16} aria-hidden="true" /><span><strong>{t.signInUnavailable}.</strong> {t.signInNotConfigured}</span></p>}
    </>}
  </AccessFrame>;
}
