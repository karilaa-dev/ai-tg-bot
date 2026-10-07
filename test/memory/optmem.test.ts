import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMemo, type MemoResult } from "../../src/memory/optmem/index.js";
import { Store } from "../helpers/optmemFileStore.js";
import { DEFAULT_MEMORY_SIZES, type MemorySizes } from "../../src/memory/optmem/settings.js";
import { cover } from "../../src/memory/optmem/blocks.js";
import { recallInWorker } from "../../src/memory/optmem/recall.js";

// Port of the upstream invariant scenarios at 1fb164cf39028047781f72ac3bb1e5a691c1dcb0.
const directories: string[] = [];
const now = new Date(2026, 9, 7, 12);
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "optmem-test-"));
  directories.push(parent);
  const directory = path.join(parent, "memory");
  const store = new Store(directory, "memo");
  const settings = { ...DEFAULT_MEMORY_SIZES };
  const setSettings = (overrides: Partial<MemorySizes>) => Object.assign(settings, overrides);
  const run = (...args: string[]) => runMemo({ store, settings, args, now });
  expect((await run("init")).exit_code).toBe(0);
  return { directory, store, settings, setSettings, run };
}

function nextBlock(result: MemoResult): string | undefined {
  return /^Run: memo nap (\d+-\d+) /mu.exec(result.stdout)?.[1];
}

async function settle(run: (...args: string[]) => Promise<MemoResult>): Promise<number> {
  let result = await run("nap"), count = 0;
  while (nextBlock(result)) {
    const id = nextBlock(result)!;
    result = await run("nap", id, `summary of ${id}`);
    expect(result.stderr).toBe("");
    expect(result.exit_code).toBe(0);
    count++;
    if (count > 5000) throw new Error("nap failed to converge");
  }
  expect(result.stdout).toContain("Nothing left to compress.");
  expect(result.stdout).not.toContain("You are awake");
  return count;
}

async function seed(directory: string, run: (...args: string[]) => Promise<MemoResult>, count: number) {
  const file = path.join(path.dirname(directory), "seed.txt");
  await fs.writeFile(file, Array.from({ length: count }, (_, i) => `2020-01-01 memory number ${i}, ${"an important event ".repeat(10).trim()}`).join("\n"));
  expect((await run("import", file)).stdout).toContain(`Imported ${count} memories`);
}

describe("OptMem native port", () => {
  it("retains all records and summaries when the filesystem returns short reads", async () => {
    const { run, setSettings } = await fixture();
    await run("note", "first fact");
    await run("note", "second fact");
    const summary = "long summary ".repeat(18).trim();
    await run("nap", "0-1", summary);
    await run("note", "third fact");
    setSettings({ WAKE_LINES: 2 });
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => new Proxy(await open(...args), {
      get: (file, key) => key === "read"
        ? (buffer: Buffer, offset: number, length: number, position: number) => file.read(buffer, offset, Math.min(length, 100), position)
        : typeof Reflect.get(file, key) === "function" ? Reflect.get(file, key).bind(file) : Reflect.get(file, key),
    }));
    try {
      expect((await run("recall", "fact")).stdout).toBe("#0 2026-10-07 first fact\n#1 2026-10-07 second fact\n#2 2026-10-07 third fact\n3 matches.\n");
      expect((await run("zoom", "0-1")).stdout).toBe("#0 2026-10-07 first fact\n#1 2026-10-07 second fact\n");
      expect((await run("wake")).stdout).toBe(`#0-1 ${summary}\n#2 2026-10-07 third fact\nYou are awake.\n`);
    } finally { spy.mockRestore(); }
  });

  it("preserves literal empty, note, compression, wake and zoom transcripts", async () => {
    const { directory, run } = await fixture();
    expect(await run("wake")).toEqual({ stdout: 'No memories yet. Record the first with: memo note "<one line>"\nYou are awake.\n', stderr: "", exit_code: 0 });
    expect((await run("note", "first fact")).stdout).toBe("Saved as #0.\n");
    expect((await run("note", "second fact")).stdout).toBe(
      'Saved as #1.\n\nCompress memories #0-1 into one line of at most 280 bytes.\nKeep what has lasting effect, drop what does not. Invent nothing.\n\n  #0 2026-10-07 first fact\n  #1 2026-10-07 second fact\n\nRun: memo nap 0-1 "<your line>"\n',
    );
    expect((await run("nap", "0-1", "both facts")).stdout).toBe("0-1 saved.\nNothing left to compress.\n");
    expect((await run("wake")).stdout).toBe("#0 2026-10-07 first fact\n#1 2026-10-07 second fact\nYou are awake.\n");
    expect((await run("zoom", "0-1")).stdout).toBe("#0 2026-10-07 first fact\n#1 2026-10-07 second fact\n");
    const log = await fs.readFile(path.join(directory, "LOG.txt"));
    expect(log).toEqual(Buffer.from("#0 2026-10-07 first fact".padEnd(319) + "\n" + "#1 2026-10-07 second fact".padEnd(319) + "\n"));
    expect(await fs.readFile(path.join(directory, "TREE", "2"))).toEqual(Buffer.from("both facts".padEnd(287) + "\n"));
  });

  it("does not create a missing identity except through init and preserves existing bytes on re-init", async () => {
    const { directory, run, setSettings } = await fixture();
    const ghost = path.join(directory, "typo");
    expect(await runMemo({ store: new Store(ghost, "memo"), args: ["wake"] })).toMatchObject({ exit_code: 1, stderr: expect.stringContaining("No memory at") });
    await expect(fs.stat(ghost)).rejects.toMatchObject({ code: "ENOENT" });
    await run("note", "remembered");
    await run("note", "forever");
    await settle(run);
    setSettings({ WAKE_LINES: 12 });
    const names = ["LOG.txt", "TREE/2"];
    const before = await Promise.all(names.map(name => fs.readFile(path.join(directory, name))));
    for (let i = 0; i < 3; i++) expect((await run("init")).stdout).toContain("Found");
    expect(await Promise.all(names.map(name => fs.readFile(path.join(directory, name))))).toEqual(before);
  });

  it("validates UTF-8 byte lengths and single lines with Python whitespace semantics", async () => {
    const { directory, run } = await fixture();
    for (const value of ["", " \t\n", "two\nlines", "two\rlines", "x".repeat(281), "ã".repeat(150)]) {
      expect((await run("note", value)).exit_code).toBe(1);
    }
    expect((await fs.stat(path.join(directory, "LOG.txt"))).size).toBe(0);
    expect((await run("note", "ã".repeat(150))).stderr).toContain("300 bytes, limit 280");
    await run("note", "\u0085reunião com João: ação aprovada → OK\u0085");
    await run("note", "plain ascii after accents");
    expect((await run("recall", "JOÃO")).stdout).toBe("#0 2026-10-07 reunião com João: ação aprovada → OK\n1 match.\n");
    expect((await run("recall", "^#1 ")).stdout).toBe("#1 2026-10-07 plain ascii after accents\n1 match.\n");
  });

  it("builds all levels smallest first, using raw inputs through 16 and two summaries above 16", async () => {
    const { directory, run } = await fixture();
    await seed(directory, run, 32);
    const expected: string[] = [];
    for (let size = 2; size <= 32; size *= 2) for (let lo = 0; lo < 32; lo += size) expected.push(`${lo}-${lo + size - 1}`);
    let result = await run("nap");
    for (const id of expected) {
      expect(nextBlock(result)).toBe(id);
      const [lo, hi] = id.split("-").map(Number);
      const body = result.stdout.split("\n").filter(line => line.startsWith("  #"));
      if (hi - lo + 1 <= 16) {
        expect(body).toHaveLength(hi - lo + 1);
        expect(body[0]).toContain(`  #${lo} 2020-01-01 memory number ${lo},`);
      } else expect(body).toEqual(["  #0-15 summary of 0-15", "  #16-31 summary of 16-31"]);
      result = await run("nap", id, `summary of ${id}`);
    }
    expect(result.stdout).toBe("0-31 saved.\nNothing left to compress.\n");
    expect((await run("nap", "0-1", "attempted overwrite")).stdout).toBe("Nothing left to compress.\n");
  });

  it("ports the large-life, pagination, snapshot and navigation invariants", async () => {
    const { directory, run, setSettings } = await fixture();
    await seed(directory, run, 2000);
    expect(await run("wake")).toMatchObject({ exit_code: 1, stdout: expect.stringContaining("Cannot wake:"), stderr: "" });
    expect((await run("wake")).stdout).toContain("then run memo wake again");
    expect(await settle(run)).toBe(1994);
    setSettings({ PART_LINES: 24 });
    const lines: string[] = [];
    const first = await run("wake", "1", "2000");
    for (let part = 1; part <= 4; part++) {
      const result = await run("wake", String(part), "2000");
      expect(result.exit_code).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(30000);
      lines.push(...result.stdout.split("\n").filter(line => line.startsWith("#")));
      expect(result.stdout).toContain(part === 4 ? "You are awake." : `Not awake yet. Run: memo wake ${part + 1} 2000`);
    }
    expect(lines).toHaveLength(96);
    expect(lines[0]).toMatch(/^#0-/u);
    expect(lines.at(-1)).toMatch(/^#1999 /u);
    expect((await run("wake", "5", "2000")).exit_code).toBe(1);
    await run("note", "a note between wake pages");
    await settle(run);
    expect(await run("wake", "1", "2000")).toEqual(first);
    expect((await run("wake", "1", "2099")).exit_code).toBe(1);
    expect((await run("zoom", "776-777")).stdout).toContain("#777 2020-01-01 memory number 777,");
    expect((await run("zoom", "1024-2047")).stdout).toContain("#1536-2047 not compressed yet");
    expect((await run("zoom", "2000-2001")).stdout).toBe("#2000 2026-10-07 a note between wake pages\n");
    const broad = await run("recall", "memory number");
    expect(broad.stdout).toContain("of 2000 matches. Narrow the regex.");
    expect(Buffer.byteLength(broad.stdout)).toBeLessThan(20100);
    expect((await run("recall", "memory number 7,")).stdout).toContain("1 match.");
  }, 30000);

  it("wakes when only unnecessary compressions are pending and hands them over after the read", async () => {
    const { run } = await fixture();
    await run("note", "one"); await run("note", "two");
    const result = await run("wake");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("You are awake.\n\nCompress memories #0-1");
  });

  it("forgets a summary and all later dependent prefixes without changing the log", async () => {
    const { directory, run } = await fixture();
    await seed(directory, run, 32); await settle(run);
    const before = await fs.readFile(path.join(directory, "LOG.txt"));
    expect((await run("forget", "16-31")).stdout).toBe("Forgot 2 summaries, from 16-31 up. Run: memo nap\n");
    expect((await fs.stat(path.join(directory, "TREE", "16"))).size).toBe(288);
    expect((await fs.stat(path.join(directory, "TREE", "32"))).size).toBe(0);
    expect(await fs.readFile(path.join(directory, "LOG.txt"))).toEqual(before);
    expect((await run("nap", "0-1", "overwrite")).stdout).toContain("0-1 is already settled.");
    expect((await run("nap", "0-31", "out of order")).stderr).toContain("Wrong block:");
    expect((await run("zoom", "0-31")).stdout).toContain("#16-31 not compressed yet");
    expect(await settle(run)).toBe(2);
    expect((await run("forget", "2-3")).stdout).toBe("Forgot 30 summaries, from 2-3 up. Run: memo nap\n");
    expect(await settle(run)).toBe(30);
    expect(await fs.readFile(path.join(directory, "LOG.txt"))).toEqual(before);
  });

  it("validates block identity, command arity and past-the-end navigation", async () => {
    const { run } = await fixture();
    for (const command of ["zoom", "forget", "nap"]) for (const id of ["3-9", "9-3", "5-6", "0-0", "-1-2", "x", "1-9007199254740992", "0-562949953421310"]) {
      expect((await run(command, id, ...(command === "nap" ? ["summary"] : []))).exit_code).toBe(1);
    }
    for (const command of ["zoom", "forget", "note", "import", "recall"]) expect((await run(command)).stderr).toContain("usage:");
    expect((await run("zoom", "1048576-2097151")).stderr).toContain("beyond the memory");
    expect((await run("forget", "1048576-1048577")).exit_code).toBe(1);
    expect((await run("recall", "[")).stderr).toContain("bad regex:");
    expect((await run("recall", "missing")).stdout).toBe("No match.\n");
    expect((await run("unknown")).stderr).toContain("No such command: unknown");
  });

  it("accepts Unicode decimal arguments like upstream", async () => {
    const { run, setSettings } = await fixture();
    await run("note", "one"); await run("note", "two");
    expect((await run("wake", "١", "٢")).exit_code).toBe(0);
    expect((await run("nap", "٠-١", "both")).stdout).toContain("0-1 saved.");
    setSettings({ WAKE_LINES: 1 });
    expect((await run("wake")).stdout).toBe("#0-1 both\nYou are awake.\n");
  });

  it("runs recall off the bot event loop and can cancel a costly pattern", async () => {
    const { run, store, settings } = await fixture();
    await run("note", "a".repeat(260) + "!");
    expect(await recallInWorker({ store, settings }, "^#0 ")).toEqual(await run("recall", "^#0 "));
    const abort = new AbortController();
    const pending = recallInWorker({ store, settings }, "(a+)+$", abort.signal);
    const rejection = expect(pending).rejects.toThrow("cancelled search");
    await delay(100);
    abort.abort(new Error("cancelled search"));
    await rejection;
    expect((await run("note", "event loop still serves writes")).stdout).toContain("Saved as #1.");
  });

  it.skipIf(process.platform === "win32")("keeps a suspended writer's lock and releases a killed writer's lock", async () => {
    const { directory, run } = await fixture();
    const program = 'import {openLock,Lock} from "@lickle/lock"; const guard=await openLock(process.argv[1]+"/.lock",Lock.Exclusive); process.stdout.write("locked\\n"); await new Promise(resolve=>setTimeout(resolve,300)); await guard.drop();';
    const owner = spawn("bun", ["-e", program, directory], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(owner.stdout, "data");
      owner.kill("SIGSTOP");
      let completed = false;
      const pending = run("note", "after suspended writer").then(result => { completed = true; return result; });
      await delay(10_500);
      expect(completed).toBe(false);
      expect((await fs.stat(path.join(directory, "LOG.txt"))).size).toBe(0);
      owner.kill("SIGCONT");
      expect((await pending).stdout).toBe("Saved as #0.\n");
    } finally { owner.kill("SIGKILL"); }
    const killed = spawn("bun", ["-e", program.replace("300", "60000"), directory], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(killed.stdout, "data");
      const pending = run("note", "after killed writer");
      killed.kill("SIGKILL");
      expect((await pending).stdout).toContain("Saved as #1.");
    } finally { killed.kill("SIGKILL"); }
  }, 20000);

  it("only displays global settings and rejects per-user overrides", async () => {
    const { run, setSettings } = await fixture();
    expect((await run("config")).stdout).toContain("WAKE_LINES   96");
    setSettings({ ENTRY_CHARS: 4 });
    expect((await run("config")).stdout).toContain("default 280");
    expect((await run("note", "longer")).stderr).toContain("limit 4");
    for (const value of ["WAKE_LINES=12", "ENTRY_CHARS=", "WAKE_LINES=１"]) {
      expect((await run("config", value)).stderr).toContain("global and read-only");
    }
  });

  it("pages by UTF-8 bytes and caps recall by bytes rather than lines", async () => {
    const { run, setSettings } = await fixture();
    await run("note", "é".repeat(140)); await run("note", "é".repeat(140)); await settle(run);
    setSettings({ PART_CHARS: 350, PART_LINES: 1 });
    expect((await run("wake")).stdout).toContain("Not awake yet. Run: memo wake 2 2");
    expect((await run("recall", "é")).stdout).toContain("Newest 1 of 2 matches.");
    setSettings({ PART_CHARS: 1 });
    expect((await run("recall", "é")).stdout).toBe("\nNewest 0 of 2 matches. Narrow the regex.\n");
  });

  it("repairs partial appends and gives actionable errors for blank/corrupt summaries", async () => {
    const { directory, run, setSettings } = await fixture();
    await run("note", "before crash");
    await fs.appendFile(path.join(directory, "LOG.txt"), "#99 half written");
    expect((await run("note", "after crash")).stdout).toContain("Saved as #1.");
    expect((await fs.stat(path.join(directory, "LOG.txt"))).size).toBe(640);
    await fs.writeFile(path.join(directory, "TREE", "2"), "torn summary");
    expect((await run("nap", "0-1", "recovered")).stdout).toContain("0-1 saved.");
    expect((await fs.stat(path.join(directory, "TREE", "2"))).size).toBe(288);
    setSettings({ WAKE_LINES: 1 });
    await fs.writeFile(path.join(directory, "TREE", "2"), " ".repeat(287) + "\n");
    expect((await run("wake")).stderr).toBe("The summary of #0-1 is blank. Run: memo forget 0-1\n");
    await fs.writeFile(path.join(directory, "TREE", "2"), Buffer.alloc(288, 0xff));
    expect((await run("wake")).stderr).toContain("is corrupt. Run: memo forget 0-1");
    await run("forget", "0-1"); await settle(run);
    expect((await run("wake")).exit_code).toBe(0);
  });

  it("names a corrupt child summary when compressing a large block", async () => {
    const { directory, run } = await fixture();
    await seed(directory, run, 32);
    let result = await run("nap");
    while (nextBlock(result) !== "0-31") result = await run("nap", nextBlock(result)!, "settled");
    const file = await fs.open(path.join(directory, "TREE", "16"), "r+");
    await file.write(Buffer.from(" ".repeat(287) + "\n"), 0, 288, 0); await file.close();
    expect((await run("nap")).stderr).toContain("blank. Run: memo forget 0-15");
  });

  it("preserves Unicode decimal dates and code-point ordering from Python imports", async () => {
    const { directory, run } = await fixture();
    const file = path.join(directory, "history.txt");
    await fs.writeFile(file, "٢٠٢٤-02-2٩ leap day\n２０２４-03-01 fullwidth year\n𝟚𝟘𝟚𝟜-03-01 astral year\n");
    expect((await run("import", file)).stdout).toContain("Imported 3 memories, #0 to #2.");
    expect((await run("recall", "leap day")).stdout).toBe("#0 ٢٠٢٤-02-2٩ leap day\n1 match.\n");
    await fs.writeFile(file, "２０２５-03-01 earlier code points\n");
    expect((await run("import", file)).stderr).toContain("precedes the previous memory");
    for (const date of ["٢٠٢٤-٠٢-29", "٢٠٢٤-02-٢٩", "٢٠٢٤-02-0٩", "٠٠٠٠-01-01"]) {
      await fs.writeFile(file, `${date} invalid strptime date\n`);
      expect((await run("import", file)).stderr).toContain("is not a real date");
    }
  });

  it("validates the entire historical import before appending and rejects invalid UTF-8/dates", async () => {
    const { directory, run } = await fixture();
    const file = path.join(directory, "input.txt");
    for (const text of ["2020-01-01 valid\n2020-02-30 invalid", "0000-01-01 invalid", "2020-01-01 valid\n2019-01-01 backwards", "invalid format", "2020-01-01 ", ""]) {
      await fs.writeFile(file, text);
      expect((await run("import", file)).exit_code).toBe(1);
      expect((await fs.stat(path.join(directory, "LOG.txt"))).size).toBe(0);
    }
    await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
    expect((await run("import", file)).stderr).toContain("is not UTF-8 text");
    await fs.writeFile(file, "2020-02-29 leap day\r\n\r\n2020-03-01 next day\r\n");
    expect((await run("import", file)).stdout).toBe("Imported 2 memories, #0 to #1.\n1 compression pending. Run: memo nap\n");
    await fs.writeFile(file, "2020-01-01 too old");
    expect((await run("import", file)).stderr).toContain("precedes the previous memory (2020-03-01)");
  });

  it("reads upstream-format files", async () => {
    const { directory, run } = await fixture();
    await fs.writeFile(path.join(directory, "LOG.txt"), "#0 2020-01-01 upstream memory".padEnd(319) + "\n");
    expect((await run("wake")).stdout).toBe("#0 2020-01-01 upstream memory\nYou are awake.\n");
  });
});

describe("OptMem cover", () => {
  it("matches literal layouts, including upstream's irreducible budget overflow", () => {
    expect(cover(0, 96)).toEqual([]);
    expect(cover(4, 4)).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(cover(8, 4)).toEqual([[0, 4], [4, 6], [6, 7], [7, 8]]);
    expect(cover(7, 1)).toEqual([[0, 4], [4, 6], [6, 7]]);
  });
  it("tiles the log with aligned binary blocks and increasing recent detail", () => {
    for (const total of [...Array.from({ length: 399 }, (_, i) => i + 1), 1000, 4096, 10000, 65536, 100003]) {
      const blocks = cover(total, 96);
      expect(blocks.length).toBeLessThanOrEqual(96);
      expect(blocks[0][0]).toBe(0); expect(blocks.at(-1)![1]).toBe(total);
      for (const [i, [lo, hi]] of blocks.entries()) {
        const size = hi - lo;
        expect(Number.isInteger(Math.log2(size))).toBe(true);
        expect(lo % size).toBe(0);
        if (i) { expect(blocks[i - 1][1]).toBe(lo); expect(size).toBeLessThanOrEqual(blocks[i - 1][1] - blocks[i - 1][0]); }
      }
    }
  });
});
