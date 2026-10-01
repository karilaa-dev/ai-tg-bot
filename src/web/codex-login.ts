import type { AuthEvent, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { CodexStatus } from "./admin-types.js";

const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 30_000;

interface LoginAttempt {
  controller: AbortController;
  task: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  committing: boolean;
}

export interface CodexLoginOptions {
  credentialStatus(): Promise<CodexStatus["credentialStatus"]>;
  saveCredential(credential: OAuthCredential, signal: AbortSignal): Promise<void>;
  login?: OAuthAuth["login"];
}

export class CodexLoginManager {
  private login: CodexStatus["login"] = { status: "idle" };
  private attempt?: LoginAttempt;
  private stopped = false;

  constructor(private readonly options: CodexLoginOptions) {}

  async status(): Promise<CodexStatus> {
    return { credentialStatus: await this.options.credentialStatus(), login: { ...this.login } };
  }

  async start(): Promise<CodexStatus> {
    if (this.stopped) throw new Error("Codex login is unavailable while the website is stopping.");
    if (!this.attempt) {
      const attempt: LoginAttempt = { controller: new AbortController(), task: Promise.resolve(), committing: false };
      this.attempt = attempt;
      this.login = { status: "starting" };
      this.setTimeout(attempt, START_TIMEOUT_MS);
      attempt.task = Promise.resolve().then(() => this.run(attempt));
    }
    return this.status();
  }

  async cancel(): Promise<CodexStatus> {
    const attempt = this.attempt;
    if (attempt) {
      if (!attempt.committing) {
        this.login = { status: "cancelled" };
        attempt.controller.abort();
      }
      await attempt.task;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.cancel();
  }

  private async run(attempt: LoginAttempt): Promise<void> {
    let saving = false;
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
      attempt.committing = true;
      clearTimeout(attempt.timer);
      saving = true;
      const commitController = new AbortController();
      attempt.timer = setTimeout(() => commitController.abort(), START_TIMEOUT_MS);
      attempt.timer.unref?.();
      await abortable(this.options.saveCredential(credential, commitController.signal), commitController.signal);
      this.login = { status: "success" };
    } catch {
      if (!attempt.controller.signal.aborted) {
        this.login = {
          status: "error",
          error: saving
            ? "Codex sign-in completed, but saving or activating the credentials failed. Check the server's credential file permissions and try again."
            : "Could not complete Codex sign-in. Enable device code login in ChatGPT Settings → Security, then try again.",
        };
      }
    } finally {
      clearTimeout(attempt.timer);
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

  private onEvent(attempt: LoginAttempt, event: AuthEvent): void {
    if (attempt.controller.signal.aborted || this.attempt !== attempt || event.type !== "device_code") return;
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
    this.login = { status: "pending", userCode: event.userCode, verificationUri: uri.href, expiresAt: Date.now() + lifetime };
    this.setTimeout(attempt, lifetime);
  }

  private setTimeout(attempt: LoginAttempt, durationMs: number): void {
    clearTimeout(attempt.timer);
    attempt.timer = setTimeout(() => {
      this.login = { status: "expired", error: "Codex sign-in expired. Start again to get a new code." };
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
