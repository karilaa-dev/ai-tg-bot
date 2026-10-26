import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Input } from "@base-ui/react/input";
import { IconLoader2, IconRefresh } from "@tabler/icons-react";
import type { AllowedUser } from "../admin-types.js";
import { apiJson } from "./api.js";
import { Button } from "./components/ui/button.js";

type Action = { kind: "load" } | { kind: "add" | "remove"; telegramId: number };
type RequestState =
  | { kind: "idle" }
  | { kind: "pending"; action: Action }
  | { kind: "failed"; action: Action; message: string };

export function AllowedUsers() {
  const [users, setUsers] = useState<AllowedUser[] | null>(null);
  const [request, setRequest] = useState<RequestState>({ kind: "pending", action: { kind: "load" } });
  const [telegramId, setTelegramId] = useState("");
  const [inputError, setInputError] = useState("");
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = request.kind === "pending";
  const adding = busy && request.action.kind === "add";

  const perform = useCallback(async (action: Action) => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setRequest({ kind: "pending", action });
    setMessage("");
    try {
      const url = `/api/admin/allowed-users${action.kind === "remove" ? `/${action.telegramId}` : ""}`;
      const result = await apiJson<{ users: AllowedUser[] }>(url, {
        signal: current.signal,
        method: action.kind === "load" ? "GET" : action.kind === "add" ? "POST" : "DELETE",
        ...(action.kind === "add" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telegramId: action.telegramId }) } : {}),
      });
      if (current.signal.aborted) return;
      setUsers(result.users);
      setRequest({ kind: "idle" });
      if (action.kind !== "load") {
        setMessage(`Telegram ID ${action.telegramId} ${action.kind === "add" ? "is now allowed." : "was removed from allowed users."}`);
        if (action.kind === "add") setTelegramId("");
        input.current?.focus();
      }
    } catch (error) {
      if (!current.signal.aborted) setRequest({ kind: "failed", action, message: error instanceof Error ? error.message : "Check your connection and try again." });
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }, []);

  useEffect(() => {
    void perform({ kind: "load" });
    return () => { controller.current?.abort(); controller.current = null; };
  }, [perform]);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (controller.current) return;
    setMessage("");
    const value = telegramId.trim();
    const id = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) {
      setInputError("Enter a valid Telegram ID using positive whole-number digits only.");
      input.current?.focus();
      return;
    }
    setInputError("");
    void perform({ kind: "add", telegramId: id });
  };

  return <>
    <header className="pane-header settings-header"><div><h2>Allowed users</h2></div><Button variant="outline" size="sm" onClick={() => void perform({ kind: "load" })} disabled={busy} aria-label="Refresh allowed users"><IconRefresh aria-hidden="true" /> Refresh</Button></header>
    <div className="settings-scroll"><div className="allowed-users-page">
      <form className="allowed-user-form" onSubmit={add} noValidate aria-label="Allow a Telegram user" aria-busy={adding}>
        <label htmlFor="allowed-telegram-id">Telegram ID</label>
        <div className="allowed-user-controls">
          <Input ref={input} id="allowed-telegram-id" name="telegramId" type="text" inputMode="numeric" autoComplete="off" required readOnly={busy} value={telegramId} onChange={event => { setTelegramId(event.target.value); setInputError(""); }} aria-invalid={Boolean(inputError)} aria-describedby={inputError ? "allowed-user-help allowed-user-input-error" : "allowed-user-help"} />
          <Button type="submit" variant="primary" disabled={busy}>{adding ? <><IconLoader2 className="activity-spinner" aria-hidden="true" /> Adding…</> : "Add user"}</Button>
        </div>
        <p id="allowed-user-help">Add their numeric Telegram ID, then ask them to send <code>/start</code> to the bot.</p>
        {inputError && <p id="allowed-user-input-error" className="allowed-user-error" role="alert">{inputError}</p>}
      </form>
      {request.kind === "failed" && <div className="failure" role="alert"><span>{request.action.kind === "load" ? "Could not load allowed users." : request.action.kind === "add" ? "Could not add this user." : "Could not remove this user."} {request.message}</span>{request.action.kind === "load" && <Button variant="outline" size="sm" onClick={() => void perform({ kind: "load" })}>Retry</Button>}</div>}
      <p className="allowed-user-feedback" role="status">{message || (busy ? request.action.kind === "load" ? "Loading allowed users…" : request.action.kind === "add" ? "Adding user…" : `Removing Telegram ID ${request.action.telegramId}…` : "")}</p>
      {users !== null && <section aria-labelledby="allowed-users-heading" aria-busy={busy}>
        <h3 id="allowed-users-heading">{users.length} allowed {users.length === 1 ? "user" : "users"}</h3>
        {users.length === 0 ? <div className="notice"><h3>No allowed users yet</h3><p>Add a Telegram ID above to give someone access to the bot.</p></div> : <ul className="allowed-user-list">
          {users.map(user => <li key={user.telegramId}>
            <div className="allowed-user-identity">
              <strong>{user.firstName || (user.username ? `@${user.username}` : `Telegram ID ${user.telegramId}`)}</strong>
              {(user.firstName || user.username) && <span>{user.firstName && user.username ? `@${user.username} · ` : ""}Telegram ID {user.telegramId}</span>}
              <span className="allowed-user-status">{user.registered ? "Registered" : "Awaiting /start"}</span>
            </div>
            <Button variant="outline" size="sm" aria-label={`Remove Telegram ID ${user.telegramId} from allowed users`} disabled={busy} onClick={() => void perform({ kind: "remove", telegramId: user.telegramId })}>{busy && request.action.kind === "remove" && request.action.telegramId === user.telegramId ? "Removing…" : "Remove"}</Button>
          </li>)}
        </ul>}
      </section>}
    </div></div>
  </>;
}
