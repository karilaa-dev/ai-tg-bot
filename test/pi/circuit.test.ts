import { describe, expect, it } from "vitest";
import { CodexCircuitBreaker, resetAtFromHeaders, retryableCodexError } from "../../src/pi/circuit.js";

describe("CodexCircuitBreaker", () => {
  it("waits until a near reset plus one minute and permits one probe", () => {
    let now = 1_000_000;
    const circuit = new CodexCircuitBreaker(() => now);
    circuit.recordFailure(now + 10 * 60_000);

    expect(circuit.acquire()).toMatchObject({ allowed: false, retryAt: now + 11 * 60_000 });
    now += 11 * 60_000;
    expect(circuit.acquire()).toEqual({ allowed: true, probe: true });
    expect(circuit.acquire()).toMatchObject({ allowed: false });
    circuit.recordSuccess();
    expect(circuit.acquire()).toEqual({ allowed: true, probe: false });
  });

  it("probes every thirty minutes for distant resets and assumes thirty minutes when unknown", () => {
    let now = 5_000_000;
    const circuit = new CodexCircuitBreaker(() => now);
    circuit.recordFailure(now + 2 * 60 * 60_000);
    expect(circuit.state().nextProbeAt).toBe(now + 30 * 60_000);

    now += 30 * 60_000;
    expect(circuit.acquire()).toEqual({ allowed: true, probe: true });
    circuit.recordFailure();
    expect(circuit.state().nextProbeAt).toBe(now + 30 * 60_000);
  });
});

describe("Codex fallback classification", () => {
  it("falls back only for provider/auth/network failures", () => {
    expect(retryableCodexError({ status: 429 })).toBe(true);
    expect(retryableCodexError({ status: 503 })).toBe(true);
    expect(retryableCodexError({ status: 504 })).toBe(true);
    expect(retryableCodexError({ message: "OAuth refresh token failed" })).toBe(true);
    expect(retryableCodexError({ message: "network socket ECONNRESET" })).toBe(true);
    expect(retryableCodexError({ status: 409 })).toBe(false);
    expect(retryableCodexError({ status: 501 })).toBe(false);
    expect(retryableCodexError({ message: "context window maximum tokens exceeded" })).toBe(false);
    expect(retryableCodexError({ message: "content policy refusal" })).toBe(false);
    expect(retryableCodexError({ status: 500, message: "content policy refusal" })).toBe(false);
    expect(retryableCodexError({ status: 429, message: "context window maximum tokens exceeded" })).toBe(false);
    expect(retryableCodexError({ message: "invalid request" })).toBe(false);
    expect(retryableCodexError({ message: "AbortError: operation aborted" })).toBe(false);
  });

  it("parses reset and retry headers", () => {
    expect(resetAtFromHeaders({ "retry-after": "5" }, 1_000)).toBe(6_000);
    expect(resetAtFromHeaders({ "x-ratelimit-reset": "2m" }, 1_000)).toBe(121_000);
  });
});
