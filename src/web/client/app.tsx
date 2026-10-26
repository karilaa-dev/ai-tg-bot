import { createRoot, type Root } from "react-dom/client";
import { AdminApp } from "./admin-app.js";
import { logo } from "./brand.js";
import { ChatApp } from "./chat/chat-app.js";
import { ChatGate } from "./chat/gate.js";

const admin = location.pathname === "/admin" || location.pathname.startsWith("/admin/");
document.title = admin ? "AI KaRiLaA · Admin" : "AI KaRiLaA";
const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) favicon.href = logo;
const container = document.getElementById("root")!;
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(admin ? <AdminApp /> : <ChatGate>{(session, signOut) => <ChatApp key={session.drafts.id} session={session} signOut={signOut} />}</ChatGate>);
