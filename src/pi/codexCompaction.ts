import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { compact, convertToLlm, type CompactionEntry, type InlineExtension, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logger.js";
import { asRecord } from "../util/records.js";
import { requestCodex, type CodexRequestRuntime } from "./codexRequest.js";

interface CodexCheckpoint {
  version: 1;
  model: string;
  items: Record<string, unknown>[];
}

function latestCompaction(entries: readonly SessionEntry[]): CompactionEntry | undefined {
  return entries.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
}

function summaryMessage(summary: string): AgentMessage {
  return { role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 };
}

// Replace only Pi's checkpoint message. Keep its retained tail, current attachments,
// session context and tool declarations exactly as the transport converted them.
export function replayCodexCheckpoint(payload: unknown, entry: CompactionEntry | undefined): unknown {
  const body = asRecord(payload);
  const checkpoint = asRecord(asRecord(entry?.details)?.codexCompaction);
  if (!body || !entry || !checkpoint || checkpoint.version !== 1 || checkpoint.model !== body.model
    || !Array.isArray(body.input) || !Array.isArray(checkpoint.items)
    || !checkpoint.items.some(item => asRecord(item)?.type === "compaction" && typeof asRecord(item)?.encrypted_content === "string")) return payload;
  const message = convertToLlm([summaryMessage(entry.summary)])[0];
  if (!message || message.role !== "user" || typeof message.content === "string") return payload;
  const text = message.content[0]?.type === "text" ? message.content[0].text : undefined;
  const index = body.input.findIndex(item => {
    const record = asRecord(item);
    const content = record?.content;
    return record?.role === "user" && Array.isArray(content) && content.length === 1
      && asRecord(content[0])?.type === "input_text" && asRecord(content[0])?.text === text;
  });
  if (index < 0) return payload;
  return { ...body, input: [...body.input.slice(0, index), ...checkpoint.items, ...body.input.slice(index + 1)] };
}

export function createCodexCompactionExtension(runtime: CodexRequestRuntime & { logger?: Logger }): InlineExtension {
  return {
    name: "codex-server-compaction",
    factory: pi => {
      pi.on("before_provider_request", (event, ctx) => runtime.config.CODEX_SERVER_COMPACTION
        ? replayCodexCheckpoint(event.payload, latestCompaction(ctx.sessionManager.getBranch())) : undefined);
      pi.on("session_before_compact", async (event, ctx) => {
        if (!runtime.config.CODEX_SERVER_COMPACTION || !runtime.providerRouter.codexConfigured()
          || runtime.providerRouter.circuit.state().open) return;
        const model = runtime.providerRouter.mainModel;
        const signal = AbortSignal.any([event.signal, AbortSignal.timeout(runtime.config.PI_REQUEST_TIMEOUT_MS)]);
        const preparation = event.preparation;
        const thinkingLevel = pi.getThinkingLevel();
        const previous = latestCompaction(event.branchEntries);
        const messages = [
          ...(preparation.previousSummary ? [summaryMessage(preparation.previousSummary)] : []),
          ...preparation.messagesToSummarize, ...preparation.turnPrefixMessages,
        ];
        const [portable, native] = await Promise.allSettled([
          compact(preparation, model, undefined, undefined, event.customInstructions, signal,
            thinkingLevel, (selected, context, options) => runtime.modelRegistry.streamSimple(selected, context, options)),
          requestCodex(runtime, {
            kind: "main", signal, sessionId: ctx.sessionManager.getSessionId(),
            headers: { "x-codex-beta-features": "remote_compaction_v2" },
            reasoning: thinkingLevel === "off" ? "minimal" : thinkingLevel,
            context: { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages),
              tools: pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name)) },
            patch: body => {
              const replayed = replayCodexCheckpoint(body, previous) as Record<string, unknown>;
              return { ...replayed, input: [...replayed.input as unknown[], { type: "compaction_trigger" }] };
            },
          }).then(result => {
            const items = result.output.filter(item => item.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length);
            if (items.length !== 1) throw new Error("Codex returned no unique compaction checkpoint.");
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
        const checkpoint: CodexCheckpoint = { version: 1, model: runtime.providerRouter.codexModel("main").id, items: native.value.items };
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
