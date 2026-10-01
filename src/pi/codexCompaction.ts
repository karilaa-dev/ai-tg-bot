import { normalizeContext, type Usage } from "@earendil-works/pi-ai";
import { compact, convertToLlm, type CompactionEntry, type InlineExtension, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logger.js";
import { asRecord } from "../util/records.js";
import { requestCodex, type CodexRequestRuntime } from "./codexRequest.js";
import { annotateCodexCheckpoint, projectCodexCheckpoint, replayCodexCheckpoint, retainCodexUserMessages, type CodexCheckpoint } from "./codexCheckpoint.js";
import { projectTurnContext } from "./turnContext.js";
import { withModelIdentity } from "./modelIdentity.js";
export { replayCodexCheckpoint } from "./codexCheckpoint.js";

function latestCompaction(entries: readonly SessionEntry[]): CompactionEntry | undefined {
  return entries.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
}

export function createCodexCompactionExtension(runtime: CodexRequestRuntime & { logger?: Logger }): InlineExtension {
  return {
    name: "codex-server-compaction",
    factory: pi => {
      pi.on("context_with_system", (event, ctx) => runtime.config.CODEX_SERVER_COMPACTION
        ? { messages: annotateCodexCheckpoint(event.messages, ctx.sessionManager) } : undefined);
      pi.on("before_provider_request", (event, ctx) => {
        const previous = latestCompaction(ctx.sessionManager.getBranch());
        // v2 replay belongs to the Codex router so OpenRouter retains Pi's tail.
        if (runtime.config.CODEX_SERVER_COMPACTION && asRecord(asRecord(previous?.details)?.codexCompaction)?.version === 1)
          return replayCodexCheckpoint(event.payload, previous);
      });
      pi.on("session_before_compact", async (event, ctx) => {
        if (!runtime.config.CODEX_SERVER_COMPACTION || !runtime.providerRouter.codexConfigured()
          || runtime.providerRouter.circuit.state().open) return;
        const model = runtime.providerRouter.mainModel;
        const signal = AbortSignal.any([event.signal, AbortSignal.timeout(runtime.config.PI_REQUEST_TIMEOUT_MS)]);
        const preparation = event.preparation;
        const thinkingLevel = pi.getThinkingLevel();
        const previous = latestCompaction(event.branchEntries);
        const codexModel = runtime.providerRouter.codexModel("main");
        const messages = projectTurnContext(ctx.sessionManager.buildSessionProjection().messages.filter(message => message.role !== "system"), event.branchEntries);
        const context = normalizeContext({ systemPrompt: ctx.getSystemPrompt(),
          messages: convertToLlm(annotateCodexCheckpoint(messages, ctx.sessionManager)),
          tools: pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name)) });
        const projected = projectCodexCheckpoint(withModelIdentity(context, codexModel), codexModel.id);
        let retained: Record<string, unknown>[] = [];
        const [portable, native] = await Promise.allSettled([
          compact(preparation, model, undefined, undefined, event.customInstructions, signal,
            thinkingLevel, (selected, context, options) => runtime.modelRegistry.streamSimple(selected, context, options)),
          requestCodex(runtime, {
            kind: "main", signal, sessionId: ctx.sessionManager.getSessionId(), source: "compaction",
            headers: { "x-codex-beta-features": "remote_compaction_v2" },
            reasoning: thinkingLevel === "off" ? "minimal" : thinkingLevel,
            context: projected.context,
            patch: body => {
              const replayed = replayCodexCheckpoint(projected.replay(body), previous) as Record<string, unknown>;
              retained = retainCodexUserMessages(replayed.input as unknown[], Math.min(64_000, Math.floor(codexModel.contextWindow / 2)));
              return { ...replayed, input: [...replayed.input as unknown[], { type: "compaction_trigger" }] };
            },
          }).then(result => {
            const items = result.output.filter(item => item.type === "compaction");
            if (items.length !== 1 || typeof items[0]!.encrypted_content !== "string" || !items[0]!.encrypted_content.trim())
              throw new Error("Codex returned no unique compaction checkpoint.");
            return { items, usage: result.message.usage };
          }),
        ]);
        if (event.signal.aborted) return { cancel: true };
        // Never discard history unless a portable summary also succeeded.
        if (portable.status === "rejected") {
          runtime.logger?.warn("Codex compaction summary failed; retaining Pi's default compaction path");
          return;
        }
        if (native.status === "rejected") {
          runtime.logger?.warn("Codex server compaction unavailable; using the portable summary", { error: String(native.reason) });
          return { compaction: portable.value };
        }
        const checkpoint: CodexCheckpoint = { version: 2, model: codexModel.id, items: [...retained, ...native.value.items] };
        return { compaction: {
          ...portable.value,
          usage: addUsage(portable.value.usage, native.value.usage),
          details: { ...asRecord(portable.value.details), codexCompaction: checkpoint },
        } };
      });
    },
  };
}

function addUsage(first: Usage | undefined, second: Usage): Usage {
  if (!first) return second;
  return {
    input: first.input + second.input, output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead, cacheWrite: first.cacheWrite + second.cacheWrite,
    totalTokens: first.totalTokens + second.totalTokens,
    reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0),
    cost: { input: first.cost.input + second.cost.input, output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead, cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total },
  };
}
