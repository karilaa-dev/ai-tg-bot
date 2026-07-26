import { setTimeout as delay } from "node:timers/promises";
import type { OpenSandboxClient, OpenSandboxInfo } from "../src/opensandbox/client.js";

export async function waitForSingleSandbox(input: {
  client: OpenSandboxClient;
  metadata: Record<string, string>;
  timeoutMs: number;
  expectedState?: string;
}): Promise<OpenSandboxInfo> {
  const deadline = Date.now() + input.timeoutMs;
  let last: OpenSandboxInfo[] = [];
  while (Date.now() < deadline) {
    last = await input.client.list(input.metadata);
    if (last.length === 1 && (!input.expectedState || last[0]?.state === input.expectedState)) return last[0]!;
    await delay(250);
  }
  const expected = input.expectedState ? ` ${input.expectedState}` : "";
  throw new Error(`Expected one${expected} managed sandbox, observed ${summarizeSandboxInfos(last)}.`);
}

export async function waitForSandboxState(input: {
  client: OpenSandboxClient;
  id: string;
  expectedState: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const info = await input.client.getInfo(input.id);
    lastState = info.state;
    if (lastState === input.expectedState) return;
    if (lastState === "Deleted" || lastState === "Error") break;
    await delay(250);
  }
  throw new Error(`Sandbox ${input.id} did not reach ${input.expectedState}; last state was ${lastState}.`);
}

export function summarizeSandboxInfos(infos: OpenSandboxInfo[]): string {
  if (!infos.length) return "none";
  return infos.map((info) => `${info.id}:${info.state}`).join(", ");
}
