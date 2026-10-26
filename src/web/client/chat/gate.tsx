import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { IconAlertCircle, IconBrandTelegram, IconLock, IconRefresh } from "@tabler/icons-react";
import type { ChatProfile } from "../../chat-types.js";
import { loginReturnPath } from "../../login-return.js";
import { logo } from "../brand.js";
import { UiLanguageContext } from "../i18n.js";
import { CHAT_SESSION_EXPIRED_EVENT, ChatApiError, bindChatRequests, chatApi, invalidateChatRequests } from "./api.js";
import { clearStoredDrafts, DraftStore } from "./drafts.js";
import { deviceLanguage, DocumentLanguage } from "./preferences.js";
import { useChatStrings } from "./strings.js";

export interface SignedIn { user: ChatProfile; botUsername: string; admin: boolean; drafts: DraftStore }

type Notice = "none" | "signed-out" | "session-ended";
type GateState =
  | { kind: "checking" }
  | { kind: "unreachable" }
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

export function ChatGate({ children }: { children: (session: SignedIn, signOut: () => Promise<void>) => ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const signingOut = useRef(false);
  const drafts = useRef<DraftStore | null>(null);
  const endSession = useCallback(() => {
    invalidateChatRequests();
    drafts.current?.close();
    drafts.current = null;
    clearStoredDrafts();
  }, []);

  const check = useCallback(async (signal: AbortSignal, notice: Notice = "none") => {
    if (signingOut.current) return;
    const current = ++generation.current;
    try {
      const session = await chatApi.session(signal);
      if (signal.aborted || current !== generation.current) return;
      if (session.authenticated) {
        if (drafts.current?.userId !== session.user.id) {
          if (drafts.current) endSession();
          drafts.current = new DraftStore(session.user.id);
          bindChatRequests(session.user.id);
        }
        setState({ kind: "signed-in", session: { user: session.user, botUsername: session.botUsername, admin: session.admin, drafts: drafts.current } });
      } else {
        endSession();
        setState({ kind: "signed-out", loginAvailable: session.loginAvailable, notice });
      }
    } catch (error) {
      if (signal.aborted || current !== generation.current) return;
      endSession();
      setState(error instanceof ChatApiError && error.status === 401
        ? { kind: "signed-out", loginAvailable: true, notice }
        : { kind: "unreachable" });
    }
  }, [endSession]);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check, revision]);

  useEffect(() => {
    const controller = new AbortController();
    const expired = () => {
      if (signingOut.current) return;
      endSession();
      setState({ kind: "checking" });
      void check(controller.signal, "session-ended");
    };
    window.addEventListener(CHAT_SESSION_EXPIRED_EVENT, expired);
    return () => { controller.abort(); window.removeEventListener(CHAT_SESSION_EXPIRED_EVENT, expired); };
  }, [check, endSession]);

  useEffect(() => () => { endSession(); }, [endSession]);

  const signOut = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    generation.current++;
    const logout = chatApi.logout();
    endSession();
    setState({ kind: "checking" });
    try {
      await logout;
      history.replaceState(null, "", "/");
      setState({ kind: "signed-out", loginAvailable: true, notice: "signed-out" });
    } catch {
      setState({ kind: "unreachable" });
    } finally {
      signingOut.current = false;
    }
  }, [endSession]);

  if (state.kind === "signed-in") return children(state.session, signOut);
  // Before an account is known, use the last interface language on this device.
  const language = deviceLanguage();
  return <UiLanguageContext.Provider value={language}>
    <DocumentLanguage language={language} />
    <SignedOut state={state} retry={() => { setState({ kind: "checking" }); setRevision(v => v + 1); }} />
  </UiLanguageContext.Provider>;
}

function SignedOut({ state, retry }: { state: Exclude<GateState, { kind: "signed-in" }>; retry: () => void }) {
  const t = useChatStrings();
  const returnTo = loginReturnPath(window.location.pathname + window.location.search);
  const signInUrl = `/api/auth/telegram/start${returnTo === "/" ? "" : `?return=${encodeURIComponent(returnTo)}`}`;
  return <AccessFrame busy={state.kind === "checking"}>
    {state.kind === "checking" && <p className="chat-access-status" role="status"><Loader size="sm" /> {t.checkingSession}</p>}
    {state.kind === "unreachable" && <>
      <p className="chat-access-note is-error" role="alert"><IconAlertCircle size={16} aria-hidden="true" /><span><strong>{t.serverUnreachable}.</strong> {t.checkConnection}</span></p>
      <Button size="lg" variant="secondary" className="chat-access-button" icon={<IconRefresh size={18} aria-hidden="true" />} onClick={retry}>{t.tryAgain}</Button>
    </>}
    {state.kind === "signed-out" && <>
      {state.notice !== "none" && <p className="chat-access-note" role="status">{state.notice === "signed-out" ? t.signedOutNotice : t.sessionEnded}</p>}
      {state.loginAvailable
        ? <LinkButton variant="primary" size="lg" className="chat-access-button" href={signInUrl}><IconBrandTelegram size={18} aria-hidden="true" />{t.signInWithTelegram}</LinkButton>
        : <p className="chat-access-note" role="note"><IconLock size={16} aria-hidden="true" /><span><strong>{t.signInUnavailable}.</strong> {t.signInNotConfigured}</span></p>}
    </>}
  </AccessFrame>;
}
