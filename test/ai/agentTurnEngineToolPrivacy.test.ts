import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Api } from "grammy";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { runTurn } from "../../src/ai/agentTurnEngine.js";
import type { TurnDraft, TurnInput } from "../../src/ai/types.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { messageView } from "../../src/web/message-view.js";
import { workspaceRuntime } from "../helpers/workspaceRuntime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("website tool privacy through real Pi execution", () => {
  it.each([
    "opaque-provider-credential",
    `opaque-provider-credential-${"private".repeat(20)}`,
    "opaque-provider-credential&<value>",
  ])("withholds raw tool labels before truncation or HTML escaping: %s", async credential => {
    const h = await setup([
      { name: "bash", arguments: { script: `printf ${credential}` } },
      { name: "finish_response", arguments: { text: "Done" } },
    ], { credential, streaming: true });

    await runTurn(h.input);

    expect(h.drafts.some(draft => draft.toolActivity?.calls.some(call => call.name === "bash"))).toBe(true);
    expect(h.drafts.every(draft => draft.thinking === "")).toBe(true);
    expect(JSON.stringify(h.drafts)).not.toContain("opaque-provider-credential");
    const assistant = await h.assistant();
    expect(assistant.content_json).not.toContain("opaque-provider-credential");
    expect(assistant.thinking).not.toContain("opaque-provider-credential");
  });

  it.each([false, true])("withholds browser input before nested execution and after an earlier failure (stream=%s)", async streaming => {
    const privateValue = "synthetic-nested-browser-password";
    const code = `throw new Error("earlier operation failed"); await tools.browser_type({tab_id:"tab-1",ref:"r7",text:"${privateValue}"});`;
    const h = await setup([
      { name: "codemode", arguments: { code } },
      { name: "finish_response", arguments: { text: "The script failed" } },
    ], { streaming });

    await runTurn(h.input);

    const first = h.drafts.find(draft => draft.toolActivity?.calls.some(call => call.name === "codemode"));
    expect(first?.toolActivity?.calls[0]?.status).toBe("running");
    expect(JSON.stringify(h.drafts)).not.toContain(privateValue);
    const assistant = await h.assistant();
    expect(assistant.content_json).not.toContain(privateValue);
    expect(messageView(assistant, []).toolActivity?.calls[0]?.status).toBe("error");
  });

  it("sanitizes skill names in the website projection of persisted thinking", async () => {
    const credential = "opaque-provider-credential&value";
    const h = await setup([
      { name: "read", arguments: { path: `skills/${credential}/SKILL.md` } },
      { name: "finish_response", arguments: { text: "The skill does not exist" } },
    ], { credential, streaming: true });

    await runTurn(h.input);

    const assistant = await h.assistant();
    expect(JSON.stringify(h.drafts)).not.toContain("opaque-provider-credential");
    expect(JSON.stringify(messageView(assistant, []))).not.toContain("opaque-provider-credential");
  });
});

async function setup(
  calls: Array<{ name: string; arguments: JsonObject }>,
  options: { credential?: string; streaming: boolean },
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tool-privacy-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadTestConfig({
    PI_CODING_AGENT_DIR: directory,
    CODEX_AUTH_FILE: path.join(directory, "no-auth.json"),
    BROWSER_USE_API_KEY: undefined,
    OPENROUTER_API_KEY: options.credential ?? "unit-provider-credential",
    LOG_LEVEL: "error",
  });
  const db = createDatabase(config);
  await db.initialize();
  cleanups.push(() => db.destroy());
  const repos = createRepos(db.db, db.search);
  const storedUser = await repos.users.ensure({ tgId: 91828, firstName: "Test", lang: "en" });
  const user = { ...storedUser, stream_mode: options.streaming ? 1 : 0 };
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Tool privacy", origin: "telegram" });
  const logger = createLogger(config);
  let cycle = 0;
  const pi = new PiRuntimeManager({
    config, db, repos, logger, commandRuntime: workspaceRuntime(),
    providerStreams: { openRouter: model => {
      const call = calls[cycle++];
      if (!call) throw new Error("Unexpected extra model cycle");
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, api: model.api, model: model.id,
        timestamp: Date.now(), stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${cycle}`, ...call }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    } },
  });
  cleanups.push(() => pi.dispose());
  const api = new Api(config.BOT_TOKEN, {
    fetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
  });
  const drafts: TurnDraft[] = [];
  const input: TurnInput = {
    config, db, repos, logger, user, thread, api, pi, chatId: user.tg_id,
    text: "Review private tool output", origin: "web", onDraft: draft => drafts.push(draft),
    t: (key, params) => {
      if (key === "thinking-final-tool-calls") return `Tool calls: ${params?.count}`;
      if (key === "thinking-final-tools") return "Tools:";
      return key;
    },
  };
  return { input, drafts, assistant: async () => {
    const assistant = (await repos.messages.listThread(thread.id)).find(message => message.role === "assistant");
    if (!assistant) throw new Error("Missing persisted assistant result");
    return assistant;
  } };
}
