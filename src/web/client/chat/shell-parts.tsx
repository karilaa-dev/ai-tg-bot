import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { useSidebar } from "@cloudflare/kumo/components/sidebar";
import { IconMenu2 } from "@tabler/icons-react";
import { useChatStrings } from "./strings.js";

/** The sidebar is a sheet on narrow screens, so each view header carries its opener. */
export function MobileNavButton() {
  const t = useChatStrings();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!isMobile) return null;
  return <Button variant="ghost" shape="square" aria-label={t.openChats} className="chat-nav-button" onClick={() => setOpenMobile(true)}><IconMenu2 size={20} aria-hidden="true" /></Button>;
}

/** The page theme, kept in sync with toggles in other tabs and the system preference. */
export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.mode === "dark");
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.mode === "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => observer.disconnect();
  }, []);
  return { dark, toggle: () => window.dispatchEvent(new Event("conversation-theme")) };
}

/** Pages keep a slim bar for navigation and status; their title opens the content column. */
export function PageHeader({ actions }: { actions?: ReactNode }) {
  return <header className="chat-view-header">
    <MobileNavButton />
    <span className="chat-view-spacer" />
    {actions && <div className="chat-view-actions">{actions}</div>}
  </header>;
}

export function PageTitle({ title, description }: { title: string; description?: string }) {
  return <div className="chat-page-title"><h1>{title}</h1>{description && <p className="chat-muted">{description}</p>}</div>;
}
