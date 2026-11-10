import { useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "@cloudflare/kumo/components/button";
import { IconRefresh } from "@tabler/icons-react";
import type { ChatApp } from "./chat/chat-app.js";
import { logo } from "./brand.js";
import { ChatGate, probablySignedIn, WorkspaceLoadFailed, WorkspaceLoading } from "./chat/gate.js";

const admin = location.pathname === "/admin" || location.pathname.startsWith("/admin/");
document.title = admin ? "AI KaRiLaA · Admin" : "AI KaRiLaA";
const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) {
  favicon.href = logo;
  void roundedIcon(logo).then(icon => { favicon.type = "image/png"; favicon.href = icon; }).catch(() => { /* The square logo stays. */ });
}

/** The logo with rounded corners, drawn once at icon size so every browser shows the same shape. */
async function roundedIcon(source: string, size = 64): Promise<string> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.beginPath();
  context.roundRect(0, 0, size, size, size * 0.22);
  context.clip();
  // Cover the square, cropping the longer side evenly.
  const scale = size / Math.min(image.naturalWidth, image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  return canvas.toDataURL("image/png");
}
/**
 * A route loaded on demand. Loading is tracked in state rather than with
 * Suspense, so the route appears as soon as its code arrives. A failed
 * download can be requested again without reloading the page.
 */
function routeChunk<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const fetch = () => pending ??= load().then(component => (loaded = component), error => { pending = undefined; throw error; });
  return {
    loaded: () => loaded,
    fetch,
    preload: () => { void fetch().catch(() => { /* Rendering reports the failure and offers a retry. */ }); },
  };
}

type RouteState<P> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; component: ComponentType<P> };

function useRoute<P extends object>(route: ReturnType<typeof routeChunk<P>>): [RouteState<P>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RouteState<P>>(() => {
    const component = route.loaded();
    return component ? { kind: "ready", component } : { kind: "loading" };
  });
  useEffect(() => {
    // The download may have finished between the first render and this effect.
    const component = route.loaded();
    if (component) { setState(current => current.kind === "ready" ? current : { kind: "ready", component }); return; }
    let live = true;
    setState({ kind: "loading" });
    route.fetch().then(component => { if (live) setState({ kind: "ready", component }); }, () => { if (live) setState({ kind: "failed" }); });
    return () => { live = false; };
  }, [route, attempt]);
  return [state, () => setAttempt(value => value + 1)];
}

// Signed-out visitors download only the sign-in gate; each signed-in route loads its own code.
const chatRoute = routeChunk(() => import("./chat/chat-app.js").then(module => module.ChatApp));
const adminRoute = routeChunk(() => import("./admin-app.js").then(module => module.AdminApp));

function ChatRoute(props: ComponentProps<typeof ChatApp>) {
  const [state, retry] = useRoute(chatRoute);
  if (state.kind === "failed") return <WorkspaceLoadFailed retry={retry} />;
  if (state.kind === "loading") return <WorkspaceLoading />;
  const Chat = state.component;
  return <Chat {...props} />;
}

function AdminRoute() {
  const [state, retry] = useRoute(adminRoute);
  if (state.kind === "loading") return null;
  if (state.kind === "failed") return <main className="chat-access">
    <section className="chat-access-panel" aria-labelledby="admin-load-title">
      <h1 id="admin-load-title">Admin dashboard</h1>
      <p className="chat-access-note is-error" role="alert">Could not load the admin dashboard. Check your connection and try again.</p>
      <Button size="lg" variant="secondary" className="chat-access-button" icon={<IconRefresh size={18} aria-hidden="true" />} onClick={retry}>Try again</Button>
    </section>
  </main>;
  const Admin = state.component;
  return <Admin />;
}

// Start the route download now when it will be needed, in parallel with the session check.
if (admin) adminRoute.preload();
else if (probablySignedIn()) chatRoute.preload();

const container = document.getElementById("root")!;
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(admin ? <AdminRoute /> : <ChatGate>{(session, signOut) => <ChatRoute key={session.drafts.id} session={session} signOut={signOut} />}</ChatGate>);
