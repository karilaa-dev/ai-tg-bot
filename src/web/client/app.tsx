import { createRoot, type Root } from "react-dom/client";
import { AdminApp } from "./admin-app.js";
import { logo } from "./brand.js";
import { ChatApp } from "./chat/chat-app.js";
import { ChatGate } from "./chat/gate.js";

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
const container = document.getElementById("root")!;
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(admin ? <AdminApp /> : <ChatGate>{(session, signOut) => <ChatApp key={session.drafts.id} session={session} signOut={signOut} />}</ChatGate>);
