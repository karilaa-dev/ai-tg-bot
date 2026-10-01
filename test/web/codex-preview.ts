import type { CodexStatus } from "../../src/web/admin-types.js";

/** Synthetic account controls for the local preview. Never contacts OpenAI or writes credentials. */
export function createCodexLoginPreview() {
  let state: CodexStatus = { credentialStatus: "missing", login: { status: "idle" } };
  let completion: ReturnType<typeof setTimeout> | undefined;
  const snapshot = () => structuredClone(state);
  return {
    async status() { return snapshot(); },
    async start() {
      if (state.login.status === "pending") return snapshot();
      state = { ...state, login: {
        status: "pending", userCode: "DEMO-CODE",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresAt: Date.now() + 15 * 60_000,
      } };
      completion = setTimeout(() => {
        state = { credentialStatus: "available", login: { status: "success" } };
      }, 30_000);
      return snapshot();
    },
    async cancel() {
      clearTimeout(completion);
      state = { ...state, login: { status: "cancelled" } };
      return snapshot();
    },
    async stop() { clearTimeout(completion); },
  };
}
