import { afterEach, expect, it, vi } from "vitest";
import { Api } from "grammy";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { MAX_FILE_BYTES, TG_DOWNLOAD_MAX_BYTES } from "../../src/files/limits.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { OUTGOING_BUFFER_BYTES } from "../../src/files/outgoingBuffers.js";
import { downloadTelegramFile } from "../../src/files/telegram.js";

afterEach(() => vi.unstubAllGlobals());

it("prepares maximum-sized generated files, spills older bytes, and rejects one byte over the send limit", async () => {
  const config = loadTestConfig();
  const db = createDatabase(config);
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9101 });
  const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
  const outgoing = new OutgoingFiles({ config, repos, user, thread });
  try {
    const bytes = Buffer.alloc(MAX_FILE_BYTES, 0xa5);
    for (const name of ["first.bin", "second.bin", "third.bin"]) {
      const attachment = await outgoing.bytes(async () => ({ name, bytes }));
      expect(attachment.size).toBe(MAX_FILE_BYTES);
    }
    const first = outgoing.items[0]!;
    expect(first.data).toBeUndefined();
    await outgoing.buffers.load(first, async () => { throw new Error("Must reload from the spool"); });
    expect(first.data?.equals(bytes)).toBe(true);
    outgoing.buffers.release(first);
    expect(outgoing.buffers.snapshot().peakBufferedBytes).toBe(OUTGOING_BUFFER_BYTES);
    await expect(outgoing.bytes(async () => ({ name: "too-large.bin", bytes: Buffer.alloc(MAX_FILE_BYTES + 1) })))
      .rejects.toThrow("size limit");
    expect(outgoing.items).toHaveLength(3);
  } finally {
    await outgoing.dispose();
    await db.destroy();
  }
}, 30_000);

it("keeps Telegram getFile capped at 20 MiB even when its caller permits 50 MiB", async () => {
  const config = loadTestConfig();
  const api = new Api("123:local-only");
  vi.spyOn(api, "getFile").mockResolvedValue({
    file_id: "large", file_unique_id: "large", file_size: TG_DOWNLOAD_MAX_BYTES + 1, file_path: "large.bin",
  });
  const fetch = vi.fn(async () => { throw new Error("Must reject before download"); });
  vi.stubGlobal("fetch", fetch);
  await expect(downloadTelegramFile({ api, config, fileId: "large", maxBytes: MAX_FILE_BYTES }))
    .rejects.toThrow("size limit");
  expect(fetch).not.toHaveBeenCalled();
});

it("checks actual Telegram response bytes when the file size is missing", async () => {
  const config = loadTestConfig();
  const api = new Api("123:local-only");
  vi.spyOn(api, "getFile").mockResolvedValue({
    file_id: "large", file_unique_id: "large", file_path: "large.bin",
  });
  const cancelled = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(TG_DOWNLOAD_MAX_BYTES + 1)); },
    cancel: cancelled,
  }))));
  await expect(downloadTelegramFile({ api, config, fileId: "large", maxBytes: MAX_FILE_BYTES }))
    .rejects.toThrow("size limit");
  expect(cancelled).toHaveBeenCalledOnce();
});
