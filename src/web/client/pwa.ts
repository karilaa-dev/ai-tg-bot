import { useEffect, useState } from "react";

export function registerChatWorker() {
  if (location.pathname !== "/chat/" || !document.querySelector('link[rel="manifest"]') ||
      !("serviceWorker" in navigator) || !window.isSecureContext) return;

  const ready = document.readyState === "complete" ? Promise.resolve() :
    new Promise<void>(resolve => window.addEventListener("load", () => resolve(), { once: true }));
  return ready.then(() => navigator.serviceWorker.register("/chat/service-worker.js")).catch(error => {
    console.warn("Offline setup failed", error);
  });
}

export function useWaitingChatWorker(pending: ReturnType<typeof registerChatWorker>) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const listeners = new AbortController();
    const { signal } = listeners;
    void pending.then(registration => {
      if (!registration || signal.aborted) return;
      let lastCheck = Date.now();
      const report = () => setWaiting(Boolean(navigator.serviceWorker.controller && registration.waiting));
      const observeUpdate = () => {
        registration.installing?.addEventListener("statechange", report, { signal });
        registration.waiting?.addEventListener("statechange", report, { signal });
        report();
      };
      const check = () => {
        if (document.hidden || !navigator.onLine || Date.now() - lastCheck < 60_000) return;
        lastCheck = Date.now();
        void registration.update().catch(() => { /* The next foreground check can retry. */ });
      };
      registration.addEventListener("updatefound", observeUpdate, { signal });
      navigator.serviceWorker.addEventListener("controllerchange", report, { signal });
      document.addEventListener("visibilitychange", check, { signal });
      window.addEventListener("online", check, { signal });
      window.addEventListener("pageshow", check, { signal });
      observeUpdate();
    });
    return () => listeners.abort();
  }, [pending]);
  return waiting;
}
