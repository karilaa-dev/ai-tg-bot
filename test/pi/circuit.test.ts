import { describe, expect, it } from "vitest";
import { CodexCircuitBreaker, resetAtFromHeaders, retryableCodexError } from "../../src/pi/circuit.js";

function acquire(circuit: CodexCircuitBreaker) {
  const attempt = circuit.acquire();
  if (!attempt.allowed) throw new Error("Expected an allowed attempt");
  return attempt;
}

describe("CodexCircuitBreaker", () => {
  it("waits until a near reset plus one minute and permits one probe", () => {
    let now = 1_000_000;
    const circuit = new CodexCircuitBreaker(() => now);
    acquire(circuit).recordFailure(now + 10 * 60_000);

    expect(circuit.acquire()).toMatchObject({ allowed: false, retryAt: now + 11 * 60_000 });
    now += 11 * 60_000;
    const probe = acquire(circuit);
    expect(probe.probe).toBe(true);
    expect(circuit.acquire()).toMatchObject({ allowed: false });
    probe.recordSuccess();
    expect(circuit.acquire()).toMatchObject({ allowed: true, probe: false });
  });

  it("probes every thirty minutes for distant resets and assumes thirty minutes when unknown", () => {
    let now = 5_000_000;
    const circuit = new CodexCircuitBreaker(() => now);
    acquire(circuit).recordFailure(now + 2 * 60 * 60_000);
    expect(circuit.state().nextProbeAt).toBe(now + 30 * 60_000);

    now += 30 * 60_000;
    const probe = acquire(circuit);
    expect(probe.probe).toBe(true);
    probe.recordFailure();
    expect(circuit.state().nextProbeAt).toBe(now + 30 * 60_000);
  });

  it.each([false, true])("preserves cooldown when an overlapping success finishes later, success started first=%s", startedFirst => {
    const circuit = new CodexCircuitBreaker(() => 1_000);
    const first = acquire(circuit);
    const second = acquire(circuit);
    const [success, failure] = startedFirst ? [first, second] : [second, first];
    failure.recordFailure();
    const cooldown = circuit.state();
    success.recordSuccess();
    expect(circuit.state()).toEqual(cooldown);
    expect(circuit.acquire()).toMatchObject({ allowed: false });
  });

  it("ignores an older failure after a newer request succeeds", () => {
    const circuit = new CodexCircuitBreaker();
    const older = acquire(circuit);
    acquire(circuit).recordSuccess();
    older.recordFailure();
    expect(circuit.state().open).toBe(false);
  });

  it("still opens for a newer request failure after an older success", () => {
    const circuit = new CodexCircuitBreaker();
    const older = acquire(circuit);
    const newer = acquire(circuit);
    older.recordSuccess();
    newer.recordFailure();
    expect(circuit.state().open).toBe(true);
  });

  it("does not let an old request change a recovery probe or its result", () => {
    let now = 1_000;
    const circuit = new CodexCircuitBreaker(() => now);
    const older = acquire(circuit);
    const overlapping = acquire(circuit);
    acquire(circuit).recordFailure();
    now = circuit.state().nextProbeAt;
    const probe = acquire(circuit);
    older.recordSuccess();
    older.release();
    expect(circuit.state().probeActive).toBe(true);
    expect(circuit.acquire()).toMatchObject({ allowed: false });
    probe.recordSuccess();
    overlapping.recordFailure();
    expect(circuit.state()).toMatchObject({ open: false, probeActive: false });
  });

  it("releases only the owning probe and ignores outcomes after release or settlement", () => {
    let now = 1_000;
    const circuit = new CodexCircuitBreaker(() => now);
    const failure = acquire(circuit);
    failure.recordFailure();
    failure.recordSuccess();
    expect(circuit.state().open).toBe(true);
    now = circuit.state().nextProbeAt;
    const cancelled = acquire(circuit);
    cancelled.release();
    const probe = acquire(circuit);
    cancelled.release();
    cancelled.recordSuccess();
    cancelled.recordFailure();
    expect(circuit.state().probeActive).toBe(true);
    expect(circuit.acquire()).toMatchObject({ allowed: false });
    probe.recordSuccess();
    expect(circuit.state().open).toBe(false);
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
