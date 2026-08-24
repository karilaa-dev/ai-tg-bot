import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export type TurnBudgetReason =
  | "model_cycle_limit"
  | "tool_call_limit"
  | "consecutive_tool_failures"
  | "identical_tool_failures";

export interface TurnBudgetSnapshot {
  modelCycles: number;
  toolCalls: number;
  consecutiveToolFailures: number;
  terminationReason?: TurnBudgetReason;
}

export class TurnBudget {
  private modelCycles = 0;
  private toolCalls = 0;
  private consecutiveToolFailures = 0;
  private terminationReason?: TurnBudgetReason;
  private readonly callSignatures = new Map<string, string>();
  private readonly failedSignatures = new Map<string, number>();

  constructor(private readonly limits: {
    maxModelCycles: number;
    maxToolCalls: number;
    maxConsecutiveToolFailures: number;
    maxIdenticalToolFailures: number;
  }) {}

  beforeModelCycle(): boolean {
    if (this.terminationReason) return false;
    this.modelCycles += 1;
    if (this.modelCycles <= this.limits.maxModelCycles) return true;
    this.terminationReason = "model_cycle_limit";
    return false;
  }

  beforeToolCall(toolCallId: string, toolName: string, args: unknown): {
    block: boolean;
    reason?: string;
    terminate?: boolean;
  } {
    if (this.terminationReason) return this.blockedDecision();
    if (this.toolCalls >= this.limits.maxToolCalls) {
      this.terminationReason = "tool_call_limit";
      return this.blockedDecision();
    }
    this.toolCalls += 1;
    this.callSignatures.set(toolCallId, `${toolName}:${stableJson(args)}`);
    return { block: false };
  }

  afterToolResult(toolCallId: string, isError: boolean): boolean {
    if (!isError) {
      this.consecutiveToolFailures = 0;
      return false;
    }
    this.consecutiveToolFailures += 1;
    const signature = this.callSignatures.get(toolCallId);
    if (signature) {
      const failures = (this.failedSignatures.get(signature) ?? 0) + 1;
      this.failedSignatures.set(signature, failures);
      if (failures >= this.limits.maxIdenticalToolFailures) {
        this.terminationReason = "identical_tool_failures";
        return true;
      }
    }
    if (this.consecutiveToolFailures >= this.limits.maxConsecutiveToolFailures) {
      this.terminationReason = "consecutive_tool_failures";
      return true;
    }
    return false;
  }

  snapshot(): TurnBudgetSnapshot {
    return {
      modelCycles: this.modelCycles,
      toolCalls: this.toolCalls,
      consecutiveToolFailures: this.consecutiveToolFailures,
      terminationReason: this.terminationReason,
    };
  }

  private blockedDecision() {
    return {
      block: true,
      reason: budgetReasonText(this.terminationReason ?? "tool_call_limit"),
      terminate: true,
    } as const;
  }
}

export interface TurnBudgetSource {
  currentTurnBudget(): TurnBudget | undefined;
}

export function createTurnBudgetExtension(source: TurnBudgetSource): InlineExtension {
  return {
    name: "turn-budget",
    factory: (pi) => {
      pi.on("turn_start", (_event, context) => {
        const budget = source.currentTurnBudget();
        if (budget && !budget.beforeModelCycle()) context.abort();
      });
      pi.on("tool_call", (event) => {
        return source.currentTurnBudget()?.beforeToolCall(
          event.toolCallId,
          event.toolName,
          event.input,
        );
      });
      pi.on("tool_result", (event, context) => {
        const structuredFailure = hasStructuredError(event.details);
        const failed = event.isError || structuredFailure;
        if (source.currentTurnBudget()?.afterToolResult(event.toolCallId, failed)) {
          context.abort();
        }
        // Bot tools return actionable JSON errors. Preserve their content and
        // details while telling Pi and later extensions that the call failed.
        if (structuredFailure && !event.isError) return { isError: true };
      });
    },
  };
}

export function budgetReasonText(reason: TurnBudgetReason, locale: "en" | "ru" = "en"): string {
  if (locale === "ru") {
    switch (reason) {
      case "model_cycle_limit": return "достигнут лимит циклов модели.";
      case "tool_call_limit": return "достигнут лимит вызовов инструментов.";
      case "consecutive_tool_failures": return "слишком много инструментов завершились ошибкой подряд.";
      case "identical_tool_failures": return "один и тот же вызов инструмента повторно завершился ошибкой.";
    }
  }
  switch (reason) {
    case "model_cycle_limit": return "The model-cycle limit was reached.";
    case "tool_call_limit": return "The tool-call limit was reached.";
    case "consecutive_tool_failures": return "Too many tools failed consecutively.";
    case "identical_tool_failures": return "The same tool call failed repeatedly.";
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, normalize(child)]));
}

function hasStructuredError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim().length > 0;
}
