import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import type { ChatSettings, ChatSettingsPatch } from "../../chat-types.js";
import { browserLanguage, UiLanguageContext, type UiLanguage } from "../i18n.js";
import { chatApi } from "./api.js";
import { SettingsSync } from "./settings-sync.js";

const LANGUAGE_KEY = "chat-ui-language";
const POLL_MS = 30_000;
const CachedLanguage = z.object({ userId: z.number().int(), language: z.enum(["en", "ru"]) });

function cachedLanguage(): z.infer<typeof CachedLanguage> | null {
  try {
    const parsed = CachedLanguage.safeParse(JSON.parse(localStorage.getItem(LANGUAGE_KEY) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
function rememberLanguage(userId: number, language: UiLanguage) {
  try { localStorage.setItem(LANGUAGE_KEY, JSON.stringify({ userId, language })); } catch { /* Storage can be disabled. */ }
}

/** Signed-out pages use the last interface language on this device, then the browser's. */
export function deviceLanguage(): UiLanguage {
  return cachedLanguage()?.language ?? browserLanguage();
}

export function DocumentLanguage({ language }: { language: UiLanguage }) {
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return null;
}

type SettingsState = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; settings: ChatSettings };

interface Preferences {
  state: SettingsState;
  reload: () => void;
  /** Shows the change at once; a rejected save restores the confirmed value and rethrows. */
  update: (patch: ChatSettingsPatch) => Promise<void>;
}

const PreferencesContext = createContext<Preferences | null>(null);

export function usePreferences(): Preferences {
  const preferences = useContext(PreferencesContext);
  if (!preferences) throw new Error("usePreferences must be used inside ChatPreferences.");
  return preferences;
}

/** Persisted bot settings drive the interface language. Telegram changes arrive by polling and on focus. */
export function ChatPreferences({ userId, fallback, children }: { userId: number; fallback: ReactNode; children: ReactNode }) {
  const [state, setState] = useState<SettingsState>({ kind: "loading" });
  const [initial] = useState(() => { const cached = cachedLanguage(); return cached?.userId === userId ? cached.language : null; });
  const sync = useRef<SettingsSync | null>(null);
  const loadNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    const controller = new AbortController();
    const store = new SettingsSync({
      save: patch => chatApi.updateSettings(patch),
      changed: settings => setState(current => current.kind === "ready" && sameSettings(current.settings, settings) ? current : { kind: "ready", settings }),
      confirmed: settings => rememberLanguage(userId, settings.language),
    });
    sync.current = store;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let lastLoad = 0;
    const load = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      lastLoad = Date.now();
      const token = store.beginRead();
      try {
        const value = await chatApi.settings(controller.signal);
        if (!controller.signal.aborted) store.received(value, token);
      } catch (error) {
        if (!controller.signal.aborted && !store.settings) setState({ kind: "failed", error });
      } finally { busy = false; }
    };
    loadNow.current = () => void load();
    const loop = async () => {
      // A background tab still needs its first answer to choose a language.
      if (!document.hidden || !store.settings) await load();
      if (!controller.signal.aborted) timer = setTimeout(() => void loop(), POLL_MS);
    };
    void loop();
    const refresh = () => { if (!document.hidden && Date.now() - lastLoad > 2_000) void load(); };
    const storage = (event: StorageEvent) => { if (event.key === LANGUAGE_KEY) void load(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", storage);
    return () => {
      store.close();
      controller.abort();
      clearTimeout(timer);
      loadNow.current = () => undefined;
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", storage);
    };
  }, [userId]);

  const update = useCallback((patch: ChatSettingsPatch) => sync.current?.update(patch) ?? Promise.resolve(), []);
  // A retry keeps the current screen; the next response replaces the failure.
  const reload = useCallback(() => loadNow.current(), []);
  const language = state.kind === "ready" ? state.settings.language : initial ?? browserLanguage();
  const value = useMemo(() => ({ state, reload, update }), [state, reload, update]);
  // Without a remembered language, wait for the account's choice instead of flashing another one.
  const waiting = state.kind === "loading" && initial === null;
  return <PreferencesContext.Provider value={value}>
    <UiLanguageContext.Provider value={language}>
      <DocumentLanguage language={language} />
      {waiting ? fallback : children}
    </UiLanguageContext.Provider>
  </PreferencesContext.Provider>;
}

const sameSettings = (a: ChatSettings, b: ChatSettings) => a.language === b.language && a.timeZone === b.timeZone && a.timezoneOffsetMinutes === b.timezoneOffsetMinutes
  && a.streaming === b.streaming && a.memoryEnabled === b.memoryEnabled;
