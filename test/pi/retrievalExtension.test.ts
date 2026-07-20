import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { embedForRetrieval } from "../../src/pi/retrievalExtension.js";

describe("Pi retrieval embedding extension", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves one-to-one input and vector ordering", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
    })));

    const vectors = await embedForRetrieval(["first", "second"], loadTestConfig());
    expect(vectors.map((vector) => [...vector])).toEqual([[1, 0], [0, 1]]);
  });

  it("rejects non-ok and misaligned embedding responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid", { status: 400 })));
    await expect(embedForRetrieval(["one"], loadTestConfig())).rejects.toThrow("HTTP 400");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ embedding: [1] }] })));
    await expect(embedForRetrieval(["one", "two"], loadTestConfig())).rejects.toThrow(
      "returned 1 vectors for 2 inputs",
    );
  });

  it("times out stalled attempts and includes the final retryable response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota depleted", { status: 429 })));
    const quota = embedForRetrieval(["one"], loadTestConfig());
    const quotaRejection = expect(quota).rejects.toThrow("HTTP 429: quota depleted");
    await vi.runAllTimersAsync();
    await quotaRejection;
    expect(fetch).toHaveBeenCalledTimes(3);

    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    const stalled = embedForRetrieval(["stalled"], loadTestConfig());
    const stalledRejection = expect(stalled).rejects.toThrow("timed out after 30000 ms");
    await vi.runAllTimersAsync();
    await stalledRejection;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight embedding request without retrying", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const request = embedForRetrieval(["cancel me"], loadTestConfig(), undefined, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(request).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
