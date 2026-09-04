import { describe, expect, it } from "vitest";
import { OutgoingBuffers, OUTGOING_BUFFER_BYTES } from "../../src/files/outgoingBuffers.js";
import type { CreatedFileAttachment } from "../../src/ai/tools/types.js";

describe("outgoing buffers", () => {
  it("evicts cached exports under pressure, preserves non-durable bytes on disk, and releases reservations", async () => {
    expect(OUTGOING_BUFFER_BYTES).toBe(40 * 1024 * 1024);
    const buffers = new OutgoingBuffers(40);
    const file = { fileId: 1, size: 30 } as CreatedFileAttachment;
    try {
      const reservation = await buffers.reserve(30);
      const bytes = Buffer.alloc(30, 9);
      await buffers.spool(file, bytes);
      reservation.commit(file, bytes);
      const next = await buffers.reserve(20);
      expect(file.data).toBeUndefined();
      expect(buffers.snapshot().bufferedBytes).toBe(20);
      next.release();
      await buffers.load(file, async () => { throw new Error("must use spooled bytes"); });
      expect(file.data).toEqual(bytes);
      expect(buffers.snapshot().peakBufferedBytes).toBeLessThanOrEqual(40);
    } finally { await buffers.dispose(); }
    expect(file.data).toBeUndefined();
    expect(buffers.snapshot().bufferedBytes).toBe(0);
  });

  it("rejects oversized output without exceeding the reservation", async () => {
    const buffers = new OutgoingBuffers(40);
    const file = { fileId: 1, size: 10 } as CreatedFileAttachment;
    try {
      await expect(buffers.load(file, async () => Buffer.alloc(11))).rejects.toThrow("reserved");
      await expect(buffers.reserve(41)).rejects.toThrow("budget");
      expect(buffers.snapshot().bufferedBytes).toBe(0);
      expect(file.data).toBeUndefined();
    } finally { await buffers.dispose(); }
  });
});
