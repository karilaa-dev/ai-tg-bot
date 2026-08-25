import { describe, expect, it } from "vitest";
import { TurnBudget } from "../../src/pi/turnBudget.js";

describe("TurnBudget", () => {
  it("blocks calls after the configured tool-call maximum", () => {
    const budget = createBudget({ maxToolCalls: 2 });

    expect(budget.beforeToolCall("1", "search", { q: "a" }).block).toBe(false);
    expect(budget.beforeToolCall("2", "search", { q: "b" }).block).toBe(false);
    expect(budget.beforeToolCall("3", "search", { q: "c" })).toMatchObject({
      block: true,
      terminate: true,
    });
    expect(budget.snapshot()).toMatchObject({ toolCalls: 2, terminationReason: "tool_call_limit" });
  });

  it("stops after three normalized identical failing calls", () => {
    const budget = createBudget({ maxIdenticalToolFailures: 3 });
    for (const [id, args] of [
      ["1", { a: 1, b: 2 }],
      ["2", { b: 2, a: 1 }],
      ["3", { a: 1, b: 2 }],
    ] as const) {
      budget.beforeToolCall(id, "bash", args);
      const terminated = budget.afterToolResult(id, true);
      expect(terminated).toBe(id === "3");
    }
    expect(budget.snapshot().terminationReason).toBe("identical_tool_failures");
  });

  it("uses a deterministic signature when tool arguments are not JSON values", () => {
    const budget = createBudget({ maxIdenticalToolFailures: 2 });
    expect(budget.beforeToolCall("1", "bash", undefined).block).toBe(false);
    expect(budget.afterToolResult("1", true)).toBe(false);
    expect(budget.beforeToolCall("2", "bash", undefined).block).toBe(false);
    expect(budget.afterToolResult("2", true)).toBe(true);
    expect(budget.snapshot().terminationReason).toBe("identical_tool_failures");
  });

  it("resets consecutive failures after a successful tool", () => {
    const budget = createBudget({ maxConsecutiveToolFailures: 3, maxIdenticalToolFailures: 10 });
    budget.beforeToolCall("1", "a", {});
    budget.afterToolResult("1", true);
    budget.beforeToolCall("2", "b", {});
    budget.afterToolResult("2", true);
    budget.beforeToolCall("3", "ok", {});
    budget.afterToolResult("3", false);
    budget.beforeToolCall("4", "c", {});

    expect(budget.afterToolResult("4", true)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ consecutiveToolFailures: 1, terminationReason: undefined });
  });

  it("stops before a model cycle beyond the configured maximum", () => {
    const budget = createBudget({ maxModelCycles: 2 });
    expect(budget.beforeModelCycle()).toBe(true);
    expect(budget.beforeModelCycle()).toBe(true);
    expect(budget.beforeModelCycle()).toBe(false);
    expect(budget.snapshot()).toMatchObject({ modelCycles: 3, terminationReason: "model_cycle_limit" });
  });
});

function createBudget(overrides: Partial<ConstructorParameters<typeof TurnBudget>[0]> = {}): TurnBudget {
  return new TurnBudget({
    maxModelCycles: 20,
    maxToolCalls: 40,
    maxConsecutiveToolFailures: 5,
    maxIdenticalToolFailures: 3,
    ...overrides,
  });
}
