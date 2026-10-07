import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cover, type Block } from "./blocks.js";
import { decode, isMissing, MemoError, Store, strip, type Memory } from "./store.js";
import { memoryInstructions } from "./prompt.js";
import { compileRecallPattern } from "./regex.js";
import { decimal } from "./decimal.js";

export const OPTMEM_UPSTREAM_COMMIT = "1fb164cf39028047781f72ac3bb1e5a691c1dcb0";
const KNOBS = {
  WAKE_LINES: [96, "the memory context: how many lines wake prints"],
  ENTRY_CHARS: [280, "the longest one memory may be, in bytes"],
  PART_CHARS: [20000, "output paging: largest part, in bytes"],
  PART_LINES: [500, "output paging: largest part, in lines"],
} satisfies Record<string, readonly [number, string]>;
type Knob = keyof typeof KNOBS;
type Sizes = Record<Knob, number>;
const RAW_MAX = 16;
const COMMANDS = ["init", "wake", "note", "nap", "recall", "zoom", "forget", "config", "import"];
export interface MemoResult { stdout: string; stderr: string; exit_code: 0 | 1 }
export interface MemoInput {
  directory: string;
  args: readonly string[];
  command?: string;
  now?: Date;
}

function pretty(file: string): string {
  const absolute = path.resolve(file), home = os.homedir();
  return absolute.startsWith(home + path.sep) ? "~" + absolute.slice(home.length) : absolute;
}

function plural(n: number, word: string): string {
  if (n === 1) return `1 ${word}`;
  if (word.endsWith("y")) word = word.slice(0, -1) + "ie";
  else if (/[shx]$/u.test(word)) word += "e";
  return `${n} ${word}s`;
}

function isKnob(name: string): name is Knob { return Object.hasOwn(KNOBS, name); }
const knobNames = Object.keys(KNOBS).filter(isKnob);
const formatted = ([id, date, text]: Memory): string => `#${id} ${date} ${text}`;

function precedes(left: string, right: string): boolean {
  const a = Array.from(left, char => char.codePointAt(0)!), b = Array.from(right, char => char.codePointAt(0)!);
  const first = a.findIndex((code, i) => code !== b[i]);
  return first < 0 ? a.length < b.length : a[first] < (b[first] ?? -1);
}

function blockId(value: string): Block {
  const match = /^([^\-]+)-([^\-]+)$/u.exec(value);
  if (!match || decimal(match[1]) === undefined || decimal(match[2]) === undefined) throw new MemoError(`'${value}' is not a block id. Copy it from the prompt.`);
  const lo = decimal(match[1])!, hi = decimal(match[2])! + 1, n = hi - lo;
  if (!Number.isSafeInteger(hi) || n < 2 || (BigInt(n) & (BigInt(n) - 1n)) !== 0n || lo % n) {
    throw new MemoError(`${value} is not a block. Copy the id printed by wake, like 16-31.`);
  }
  return [lo, hi];
}

function size(key: Knob, value: string, where = ""): number {
  const number = decimal(value);
  if (number === undefined || number < 1) {
    throw new MemoError(`${where}${key} must be a positive whole number, not '${value}'.`);
  }
  if (key === "ENTRY_CHARS" && number > 280) {
    throw new MemoError(`${where}ENTRY_CHARS is at most 280: a memory has to fit the fixed-width records.`);
  }
  return number;
}

function usage(command: string): string {
  return `OptMem: a permanent, append-only memory for AI agents.

  ${command} init             create this memory; print the setup block.
  ${command} wake [part [T]]  read your memory. Run first, every session.
  ${command} note "..."       record one memory: one short line.
  ${command} nap [id "..."]   do the pending compressions.
  ${command} recall <regex>   search every memory ever recorded.
  ${command} zoom <lo>-<hi>   open a tree node: its two halves.
  ${command} forget <lo>-<hi> drop a bad summary; nap rebuilds it.
  ${command} config [NAME=N]  show this memory's sizes, or change one.
  ${command} import <file>    bulk-load dated memories (bootstrap only).

The memories live in ~/.optmem/memory, or in $MEMORY_DIR if set.
See github.com/VictorTaelin/OptMem.`;
}

class Command {
  readonly store: Store;
  readonly name: string;
  private readonly output: string[] = [];
  private sizes: Sizes = { WAKE_LINES: 96, ENTRY_CHARS: 280, PART_CHARS: 20000, PART_LINES: 500 };
  constructor(private readonly input: MemoInput) {
    this.name = input.command ?? "memo";
    this.store = new Store(input.directory, this.name);
  }
  private print(text = ""): void { this.output.push(text + "\n"); }

  async run(): Promise<MemoResult> {
    try {
      const [command, ...args] = this.input.args;
      if (!command) this.print(usage(this.name));
      else if (!COMMANDS.includes(command)) throw new MemoError(`No such command: ${command}\n\n${usage(this.name)}`);
      else if (command === "init") await this.init(args);
      else {
        await this.store.open();
        this.sizes = { ...this.sizes, ...await this.overrides() };
        switch (command) {
          case "wake": return await this.wake(args);
          case "note": await this.note(args); break;
          case "nap": await this.nap(args); break;
          case "recall": await this.recall(args); break;
          case "zoom": await this.zoom(args); break;
          case "forget": await this.forget(args); break;
          case "config": await this.configure(args); break;
          case "import": await this.import(args); break;
        }
      }
      return this.result();
    } catch (error) {
      if (error instanceof MemoError) return this.result(1, error.message);
      if (error instanceof Error && "code" in error) return this.result(1, error.message);
      throw error;
    }
  }

  private result(exit_code: 0 | 1 = 0, stderr = ""): MemoResult {
    return { stdout: this.output.join(""), stderr: stderr ? stderr + "\n" : "", exit_code };
  }

  private async overrides(): Promise<Partial<Sizes>> {
    const file = path.join(this.input.directory, "config");
    let text;
    try { text = decode(await fs.readFile(file)); }
    catch (error) { if (isMissing(error)) return {}; throw error; }
    const out: Partial<Sizes> = {};
    for (const [index, original] of text.split(/\r\n|\r|\n/u).entries()) {
      const line = strip(original.split("#", 1)[0]);
      if (!line.includes("=")) continue;
      const pos = line.indexOf("="), key = strip(line.slice(0, pos)).toUpperCase(), value = strip(line.slice(pos + 1));
      const where = `${pretty(file)} line ${index + 1}: `;
      if (!isKnob(key)) throw new MemoError(`${where}${key} is not a size. Delete the line, or name one of: ${knobNames.join(", ")}.`);
      out[key] = size(key, value, where);
    }
    return out;
  }

  private configText(overrides: Partial<Sizes>): string {
    const lines = ["# OptMem sizes for this memory. A commented line means: follow the",
      `# tool's default. Edit with \`${this.name} config NAME=VALUE\`.`, ""];
    for (const key of knobNames) {
      const [defaultValue, what] = KNOBS[key];
      lines.push(`${(key in overrides ? "" : "# ").padEnd(2)}${key.padEnd(12)} = ${String(overrides[key] ?? defaultValue).padEnd(6)} # ${what}`);
    }
    return lines.join("\n") + "\n";
  }

  private async init(args: string[]): Promise<void> {
    if (args.length) throw new MemoError(`usage: ${this.name} init`);
    const fresh = await this.store.initialize();
    try { await fs.writeFile(path.join(this.input.directory, "config"), this.configText({}), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    this.sizes = { ...this.sizes, ...await this.overrides() };
    const directory = pretty(this.input.directory);
    this.print(fresh ? `Created ${directory}: this machine's memory, one identity, forever.` : `Found ${directory}: ${plural(await this.store.length(), "memory")}.`);
    this.print(`Sizes live in ${directory}/config; the defaults are fine.`);
    this.print();
    this.print("Paste this at the top of your agent's AGENTS.md (or CLAUDE.md), done:");
    this.print();
    this.print(memoryInstructions(this.name, directory, this.sizes.ENTRY_CHARS));
  }

  private check(value: string): string {
    const text = strip(value);
    if (!text) throw new MemoError("Empty. A memory is one line of text.");
    if (text.includes("\n") || text.includes("\r")) throw new MemoError(`${text.split("\n").length} lines. A memory is one line: merge them, or note them separately.`);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.sizes.ENTRY_CHARS) throw new MemoError(`Too long: ${bytes} bytes, limit ${this.sizes.ENTRY_CHARS}. Accented characters cost 2 bytes. Compress it further.`);
    return text;
  }

  private async nextNap(total: number): Promise<string | undefined> {
    const [block] = await this.store.pending(total, 1);
    if (!block) return;
    const [lo, hi] = block, left = await this.store.pendingCount(total) - 1;
    const body: string[] = [];
    if (hi - lo <= RAW_MAX) body.push(...(await this.store.slice(lo, hi)).map(entry => "  " + formatted(entry)));
    else {
      const mid = (lo + hi) / 2;
      for (const [a, b] of [[lo, mid], [mid, hi]]) {
        const summary = await this.store.summary(a, b);
        if (summary === undefined) throw new MemoError(`The summary of #${a}-${b - 1} is blank. Run: ${this.name} forget ${a}-${b - 1}`);
        body.push(`  #${a}-${b - 1} ${summary}`);
      }
    }
    const tail = !left ? "" : `\n${left === 1 ? "1 compression remains" : `${left} compressions remain`} after this one.`;
    return `Compress memories #${lo}-${hi - 1} into one line of at most ${this.sizes.ENTRY_CHARS} bytes.\nKeep what has lasting effect, drop what does not. Invent nothing.\n\n${body.join("\n")}\n${tail}\nRun: ${this.name} nap ${lo}-${hi - 1} "<your line>"`;
  }

  private paginate(lines: string[]): string[][] {
    const parts: string[][] = [];
    let current: string[] = [], bytes = 0;
    for (const line of lines) {
      const n = Buffer.byteLength(line) + 1;
      if (current.length && (current.length >= this.sizes.PART_LINES || bytes + n > this.sizes.PART_CHARS)) {
        parts.push(current); current = []; bytes = 0;
      }
      current.push(line); bytes += n;
    }
    if (current.length) parts.push(current);
    return parts;
  }

  private async wake(args: string[]): Promise<MemoResult> {
    const now = await this.store.length();
    let part = 1, total = now;
    if (args.length) {
      if (args.length > 2 || args.some(arg => decimal(arg) === undefined)) throw new MemoError(`usage: ${this.name} wake [part [T]]`);
      part = decimal(args[0])!;
      if (args.length === 2) {
        total = decimal(args[1])!;
        if (total > now) throw new MemoError(`T=${total}, but the log holds ${plural(now, "memory")}. Run: ${this.name} wake`);
      }
    }
    if (!total) {
      this.print(`No memories yet. Record the first with: ${this.name} note "<one line>"`);
      this.print("You are awake.");
      return this.result();
    }
    const lines: string[] = [];
    for (const [lo, hi] of cover(total, this.sizes.WAKE_LINES)) {
      if (hi - lo === 1) lines.push(formatted(await this.store.get(lo)));
      else {
        let summary = await this.store.summary(lo, hi);
        if (summary === undefined) {
          const nap = await this.nextNap(total);
          if (nap) {
            this.print(`Cannot wake: the memory context needs #${lo}-${hi - 1}, which is not compressed yet.\nDo the ${plural(await this.store.pendingCount(total), "compression")} below, then run ${this.name} wake again.\n`);
            this.print(nap);
            return this.result(1);
          }
          summary = await this.store.summary(lo, hi);
        }
        if (summary === undefined) throw new MemoError(`The summary of #${lo}-${hi - 1} is blank. Run: ${this.name} forget ${lo}-${hi - 1}`);
        lines.push(`#${lo}-${hi - 1} ${summary}`);
      }
    }
    const parts = this.paginate(lines);
    if (part < 1 || part > parts.length) throw new MemoError(`No part ${part}: the memory has ${plural(parts.length, "part")}. Run: ${this.name} wake`);
    if (parts.length > 1) this.print(`Your memory, part ${part} of ${parts.length}, oldest first (${plural(total, "memory")}).`);
    this.print(parts[part - 1].join("\n"));
    if (part < parts.length) this.print(`Not awake yet. Run: ${this.name} wake ${part + 1} ${total}`);
    else {
      this.print("You are awake.");
      const nap = await this.nextNap(total);
      if (nap) this.print("\n" + nap);
    }
    return this.result();
  }

  private async note(args: string[]): Promise<void> {
    if (args.length !== 1) throw new MemoError(`usage: ${this.name} note "<one line, at most ${this.sizes.ENTRY_CHARS} bytes>"`);
    const text = this.check(args[0]), now = this.input.now ?? new Date();
    const date = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const id = await this.store.append([[date, text]]);
    this.print(`Saved as #${id}.`);
    const nap = await this.nextNap(id + 1);
    if (nap) this.print("\n" + nap);
  }

  private async nap(args: string[]): Promise<void> {
    const total = await this.store.length();
    if (args.length) {
      if (args.length !== 2) throw new MemoError(`usage: ${this.name} nap <lo>-<hi> "<one line>"`);
      const [lo, hi] = blockId(args[0]), [next] = await this.store.pending(total, 1);
      if (!next) { this.print("Nothing left to compress."); return; }
      if (lo !== next[0] || hi !== next[1]) {
        if (await this.store.summary(lo, hi) !== undefined) this.print(`${lo}-${hi - 1} is already settled.`);
        else throw new MemoError(`Wrong block: ${args[0]}. Blocks are built in order; the next is ${next[0]}-${next[1] - 1}. Run: ${this.name} nap`);
      } else if (!await this.store.put(lo, hi, this.check(args[1]))) this.print(`${lo}-${hi - 1} was settled or forgotten meanwhile.`);
      else this.print(`${lo}-${hi - 1} saved.`);
    }
    const nap = await this.nextNap(total);
    if (!nap) { this.print("Nothing left to compress."); return; }
    this.print((args.length ? "\n" : "") + nap);
  }

  private async configure(args: string[]): Promise<void> {
    await this.store.locked(async () => {
      const overrides = await this.overrides();
      for (const arg of args) {
        const pos = arg.indexOf("="), key = strip(pos < 0 ? arg : arg.slice(0, pos)).toUpperCase(), value = strip(arg.slice(pos + 1));
        if (pos < 0 || !isKnob(key)) throw new MemoError(`usage: ${this.name} config [NAME=VALUE ...]   # NAME one of ${knobNames.join(", ")}`);
        if (value) overrides[key] = size(key, value);
        else delete overrides[key];
      }
      if (args.length) await fs.writeFile(path.join(this.input.directory, "config"), this.configText(overrides));
      for (const key of knobNames) {
        const [defaultValue, what] = KNOBS[key];
        this.print(`${key.padEnd(12)} ${String(overrides[key] ?? defaultValue).padEnd(7)} ${what}${key in overrides ? ` (default ${defaultValue})` : ""}`);
      }
    });
  }

  private async forget(args: string[]): Promise<void> {
    if (args.length !== 1) throw new MemoError(`usage: ${this.name} forget <lo>-<hi>`);
    const gone = await this.store.drop(...blockId(args[0]));
    if (!gone.length) throw new MemoError(`No summary at ${args[0]}.`);
    this.print(`Forgot ${plural(gone.length, "summary")}, from ${gone[0][0]}-${gone[0][1] - 1} up. Run: ${this.name} nap`);
  }

  private async recall(args: string[]): Promise<void> {
    if (args.length !== 1) throw new MemoError(`usage: ${this.name} recall <regex>`);
    let pattern;
    try { pattern = compileRecallPattern(args[0]); }
    catch (error) { throw new MemoError(`bad regex: ${error instanceof Error ? error.message : String(error)}`); }
    let hits = 0, bytes = 0;
    const out: string[] = [];
    for await (const entry of this.store.scan()) {
      const line = formatted(entry);
      if (!pattern.test(line)) continue;
      hits++; out.push(line); bytes += Buffer.byteLength(line) + 1;
      while (bytes > this.sizes.PART_CHARS) bytes -= Buffer.byteLength(out.shift()!) + 1;
    }
    if (!hits) { this.print("No match."); return; }
    this.print(out.join("\n"));
    this.print(out.length < hits ? `Newest ${out.length} of ${plural(hits, "match")}. Narrow the regex.` : `${plural(hits, "match")}.`);
  }

  private async zoom(args: string[]): Promise<void> {
    if (args.length !== 1) throw new MemoError(`usage: ${this.name} zoom <lo>-<hi>   # a block id, as wake prints them`);
    const [lo, hi] = blockId(args[0]), total = await this.store.length();
    if (lo >= total) throw new MemoError(`#${args[0]} is beyond the memory: it holds ${plural(total, "memory")}. Run: ${this.name} wake`);
    const mid = (lo + hi) / 2;
    for (const [a, b] of [[lo, mid], [mid, hi]]) {
      if (a >= total) continue;
      this.print(b - a === 1 ? formatted(await this.store.get(a)) : `#${a}-${b - 1} ${await this.store.summary(a, b) || "not compressed yet"}`);
    }
  }

  private async import(args: string[]): Promise<void> {
    if (args.length !== 1) throw new MemoError(`usage: ${this.name} import <file>   # lines of 'YYYY-MM-DD <text>'`);
    const bytes = await fs.readFile(args[0]);
    let source;
    try { source = decode(bytes); }
    catch { throw new MemoError(`${pretty(args[0])} is not UTF-8 text. Convert it, then import again.`); }
    const length = await this.store.length();
    let last = length ? (await this.store.get(length - 1))[1] : "0000-00-00";
    const out: Array<readonly [string, string]> = [];
    for (const [i, line] of source.split(/\r\n|\r|\n/u).entries()) {
      if (!strip(line)) continue;
      const pos = line.indexOf(" "), date = pos < 0 ? line : line.slice(0, pos);
      const fields = date.split("-");
      if (fields.length !== 3 || [4, 2, 2].some((length, n) => Array.from(fields[n]).length !== length || decimal(fields[n]) === undefined)) {
        throw new MemoError(`line ${i + 1}: expected 'YYYY-MM-DD <text>', got: ${line}`);
      }
      const [year, month, day] = fields.map(field => decimal(field)!);
      const normalized = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const parsed = new Date(`${normalized}T00:00:00Z`);
      // Match strptime's numeric directives, including its mixed Unicode/ASCII rules.
      const validMonth = /^(?:0[1-9]|1[0-2])$/u.test(fields[1]);
      const validDay = /^(?:0[1-9]|3[01])$/u.test(fields[2]) || /^[12]/u.test(fields[2]);
      if (!year || !validMonth || !validDay || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
        throw new MemoError(`line ${i + 1}: ${date} is not a real date.`);
      }
      if (precedes(date, last)) throw new MemoError(`line ${i + 1}: date ${date} precedes the previous memory (${last}).`);
      const text = strip(pos < 0 ? "" : line.slice(pos + 1)), n = Buffer.byteLength(text);
      if (!text || n > this.sizes.ENTRY_CHARS) throw new MemoError(`line ${i + 1}: ${n} bytes, limit ${this.sizes.ENTRY_CHARS}.`);
      out.push([date, text]); last = date;
    }
    if (!out.length) throw new MemoError(`${args[0]} has no memories.`);
    const base = await this.store.append(out);
    this.print(`Imported ${plural(out.length, "memory")}, #${base} to #${base + out.length - 1}.`);
    const n = await this.store.pendingCount(await this.store.length());
    if (n) this.print(`${plural(n, "compression")} pending. Run: ${this.name} nap`);
  }
}

export async function runMemo(input: MemoInput): Promise<MemoResult> {
  return new Command(input).run();
}
