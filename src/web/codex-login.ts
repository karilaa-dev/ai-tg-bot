import type { AuthEvent, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { CodexStatus } from "./admin-types.js";

const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 30_000;

interface LoginAttempt {
  controller: AbortController;
  task: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

type LoginView = CodexStatus["login"];
type ActiveView = Extract<LoginView, { status: "starting" | "pending" }>;
type LoginState =
  | { phase: "settled"; view: Exclude<LoginView, ActiveView> }
  | { phase: "authorizing" | "committing"; view: ActiveView; attempt: LoginAttempt }
  | { phase: "aborting"; view: { status: "cancelled" } | { status: "expired"; error: string }; attempt: LoginAttempt };

export interface CodexLoginOptions {
  credentialStatus(): Promise<CodexStatus["credentialStatus"]>;
  saveCredential(credential: OAuthCredential, signal: AbortSignal): Promise<void>;
  login?: OAuthAuth["login"];
}

export class CodexLoginManager {
  private state: LoginState = { phase: "settled", view: { status: "idle" } };
  private stopped = false;

  constructor(private readonly options: CodexLoginOptions) {}

  async status(): Promise<CodexStatus> {
    return { credentialStatus: await this.options.credentialStatus(), login: { ...this.state.view } };
  }

  async start(): Promise<CodexStatus> {
    if (this.stopped) throw new Error("Codex login is unavailable while the website is stopping.");
    if (this.state.phase === "settled") {
      const attempt: LoginAttempt = { controller: new AbortController(), task: Promise.resolve() };
      this.state = { phase: "authorizing", attempt, view: { status: "starting" } };
      this.setTimeout(attempt, START_TIMEOUT_MS);
      attempt.task = Promise.resolve().then(() => this.run(attempt));
    }
    return this.status();
  }

  async cancel(): Promise<CodexStatus> {
    const state = this.state;
    if (state.phase !== "settled") {
      if (state.phase === "authorizing") {
        this.state = { phase: "aborting", attempt: state.attempt, view: { status: "cancelled" } };
        state.attempt.controller.abort();
      }
      await state.attempt.task;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.cancel();
  }

  private async run(attempt: LoginAttempt): Promise<void> {
    try {
      attempt.controller.signal.throwIfAborted();
      const login = this.options.login ?? openaiCodexProvider().auth.oauth!.login;
      const credential = await abortable(login({
        signal: attempt.controller.signal,
        prompt: async (prompt) => {
          attempt.controller.signal.throwIfAborted();
          if (prompt.type === "select" && prompt.options.some((option) => option.id === "device_code")) return "device_code";
          throw new Error("Unsupported Codex login prompt.");
        },
        notify: (event) => this.onEvent(attempt, event),
      }), attempt.controller.signal);
      attempt.controller.signal.throwIfAborted();
      // Once tokens have arrived, cancellation waits for the atomic commit. It
      // must not report cancellation after the account has already been changed.
      if (this.state.phase !== "authorizing" || this.state.attempt !== attempt) return;
      this.state = { ...this.state, phase: "committing" };
      clearTimeout(attempt.timer);
      const commitController = new AbortController();
      attempt.timer = setTimeout(() => commitController.abort(), START_TIMEOUT_MS);
      attempt.timer.unref?.();
      await abortable(this.options.saveCredential(credential, commitController.signal), commitController.signal);
      this.state = { phase: "settled", view: { status: "success" } };
    } catch {
      const state = this.state;
      if (state.phase === "settled" || state.attempt !== attempt) return;
      this.state = { phase: "settled", view: state.phase === "aborting" ? state.view : {
        status: "error",
        error: state.phase === "committing"
          ? "Codex sign-in completed, but saving or activating the credentials failed. Check the server's credential file permissions and try again."
          : "Could not complete Codex sign-in. Enable device code login in ChatGPT Settings → Security, then try again.",
      } };
    } finally {
      clearTimeout(attempt.timer);
    }
  }

  private onEvent(attempt: LoginAttempt, event: AuthEvent): void {
    if (this.state.phase !== "authorizing" || this.state.attempt !== attempt || event.type !== "device_code") return;
    // Only link the documented OpenAI approval page, never an arbitrary URL from
    // a failed or unexpected provider response.
    const uri = new URL(event.verificationUri);
    if (uri.origin !== "https://auth.openai.com" || uri.pathname !== "/codex/device"
      || uri.username || uri.password || uri.search || uri.hash
      || !/^[A-Za-z0-9-]{3,64}$/.test(event.userCode)) {
      throw new Error("Invalid Codex device authorization response.");
    }
    const seconds = event.expiresInSeconds;
    const lifetime = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.min(DEVICE_LOGIN_TIMEOUT_MS, seconds * 1000)
      : DEVICE_LOGIN_TIMEOUT_MS;
    this.state = { ...this.state, view: { status: "pending", userCode: event.userCode, verificationUri: uri.href, expiresAt: Date.now() + lifetime } };
    this.setTimeout(attempt, lifetime);
  }

  private setTimeout(attempt: LoginAttempt, durationMs: number): void {
    clearTimeout(attempt.timer);
    attempt.timer = setTimeout(() => {
      if (this.state.phase !== "authorizing" || this.state.attempt !== attempt) return;
      this.state = { phase: "aborting", attempt, view: { status: "expired", error: "Codex sign-in expired. Start again to get a new code." } };
      attempt.controller.abort();
    }, durationMs);
    attempt.timer.unref?.();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Codex login cancelled."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
