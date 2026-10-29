import { expect, it } from "vitest";
import { DownloadPool } from "../../src/web/download-pool.js";

it("admits three users, rejects monopolization, and queues distinct users fairly", async () => {
  const pool = new DownloadPool();
  const signal = new AbortController().signal;
  const first = await pool.acquire(1, signal);
  const second = await pool.acquire(2, signal);
  const third = await pool.acquire(3, signal);
  await expect(pool.acquire(1, signal)).rejects.toMatchObject({ status: 429 });
  const order: number[] = [];
  const fourth = pool.acquire(4, signal).then(release => { order.push(4); return release; });
  const fifth = pool.acquire(5, signal).then(release => { order.push(5); return release; });
  first(); first();
  const releaseFourth = await fourth;
  expect(order).toEqual([4]);
  second();
  const releaseFifth = await fifth;
  expect(order).toEqual([4, 5]);
  third(); releaseFourth(); releaseFifth();
  (await pool.acquire(1, signal))();
});

it("bounds the queue and removes cancelled users without leaking slots", async () => {
  const pool = new DownloadPool();
  const signal = new AbortController().signal;
  const active = await Promise.all([1, 2, 3].map(id => pool.acquire(id, signal)));
  const controller = new AbortController();
  const cancelled = pool.acquire(4, controller.signal);
  const rejection = expect(cancelled).rejects.toThrow();
  const waiting = Array.from({ length: 23 }, (_, index) => pool.acquire(index + 5, signal));
  await expect(pool.acquire(99, signal)).rejects.toMatchObject({ status: 503 });
  controller.abort();
  await rejection;
  const replacement = pool.acquire(4, signal);
  active.forEach(release => release());
  for (const ready of [...waiting, replacement]) (await ready)();
  (await pool.acquire(4, signal))();
});
