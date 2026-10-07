import names from "@unicode/unicode-16.0.0/Names/index.mjs";
import abbreviations from "@unicode/unicode-16.0.0/Names/Abbreviation/index.mjs";
import alternate from "@unicode/unicode-16.0.0/Names/Alternate/index.mjs";
import controls from "@unicode/unicode-16.0.0/Names/Control/index.mjs";
import corrections from "@unicode/unicode-16.0.0/Names/Correction/index.mjs";
import figments from "@unicode/unicode-16.0.0/Names/Figment/index.mjs";
import commonFolds from "@unicode/unicode-16.0.0/Case_Folding/C/symbols.mjs";
import simpleFolds from "@unicode/unicode-16.0.0/Case_Folding/S/symbols.mjs";
import lowercases from "@unicode/unicode-16.0.0/Simple_Case_Mapping/Lowercase/symbols.mjs";
import letters from "@unicode/unicode-16.0.0/General_Category/Letter/regex.mjs";
import numbers from "@unicode/unicode-16.0.0/General_Category/Number/regex.mjs";
import digits from "@unicode/unicode-16.0.0/General_Category/Decimal_Number/regex.mjs";
import identifierStart from "@unicode/unicode-16.0.0/Binary_Property/XID_Start/regex.mjs";
import identifierContinue from "@unicode/unicode-16.0.0/Binary_Property/XID_Continue/regex.mjs";

// Native implementation of the str-pattern grammar used by Python re.search(re.I).
// Matching uses code points and persistent captures, including captures in assertions.
type Flags = { i: boolean; a: boolean; m: boolean; s: boolean; x: boolean };
type Node =
  | { kind: "character"; accepts: (char: string) => boolean }
  | { kind: "anchor"; accepts: (text: string[], position: number) => boolean }
  | { kind: "sequence"; nodes: Node[] }
  | { kind: "choice"; nodes: Node[] }
  | { kind: "capture"; id: number; node: Node }
  | { kind: "group"; node: Node }
  | { kind: "reference"; id: number; flags: Flags; width: Width }
  | { kind: "repeat"; node: Node; min: number; max: number; greedy: boolean; possessive: boolean }
  | { kind: "atomic"; node: Node }
  | { kind: "assertion"; node: Node; positive: boolean; behind: number }
  | { kind: "conditional"; id: number; yes: Node; no: Node };
type Width = readonly [min: number, max: number];
type Capture = { start: number; end?: number };
type State = { position: number; captures: ReadonlyMap<number, Capture> };
type ClassItem = { kind: "literal"; char: string } | { kind: "predicate"; accepts: (char: string) => boolean };
const EMPTY: Node = { kind: "sequence", nodes: [] };
const SPACE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
let byName: Map<string, string> | undefined;
const HANGUL_L = ["G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H"];
const HANGUL_V = ["A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WEO", "WE", "WI", "YU", "EU", "YI", "I"];
const HANGUL_T = ["", "G", "GG", "GS", "N", "NJ", "NH", "D", "L", "LG", "LM", "LB", "LS", "LT", "LP", "LH", "M", "B", "BS", "S", "SS", "NG", "J", "C", "K", "T", "P", "H"];

function namedCharacter(name: string): string | undefined {
  if (name.startsWith("CJK UNIFIED IDEOGRAPH-")) {
    const hex = name.slice(22);
    if (!/^[0-9A-F]{4,5}$/u.test(hex)) return;
    const code = Number.parseInt(hex, 16);
    return names.get(code)?.startsWith("CJK Ideograph") ? String.fromCodePoint(code) : undefined;
  }
  if (!byName) {
    byName = new Map();
    for (const [code, label] of names) {
      let name = label;
      if (label.startsWith("CJK Ideograph")) name = `CJK UNIFIED IDEOGRAPH-${code.toString(16).toUpperCase()}`;
      else if (label.startsWith("Tangut Ideograph")) name = `TANGUT IDEOGRAPH-${code.toString(16).toUpperCase()}`;
      else if (label === "Hangul Syllable") {
        const index = code - 0xac00;
        name = `HANGUL SYLLABLE ${HANGUL_L[Math.floor(index / 588)]}${HANGUL_V[Math.floor(index / 28) % 21]}${HANGUL_T[index % 28]}`;
      } else if (/[a-z<>]/u.test(label)) continue;
      byName.set(name, String.fromCodePoint(code));
    }
    for (const aliases of [abbreviations, alternate, controls, corrections, figments]) {
      for (const [code, values] of Object.entries(aliases)) for (const name of values) byName.set(name, String.fromCodePoint(Number(code)));
    }
  }
  const upper = name.toUpperCase();
  if ((upper.startsWith("CJK UNIFIED IDEOGRAPH-") || upper.startsWith("HANGUL SYLLABLE ")) && name !== upper) return;
  return byName.get(upper);
}

function folded(char: string, ascii: boolean): string {
  if (ascii) return /^[A-Z]$/u.test(char) ? char.toLowerCase() : char;
  // Python includes all four Turkish I forms in IGNORECASE, without full case folding.
  if (/^[iIİı]$/u.test(char)) return "i";
  return commonFolds.get(char) ?? simpleFolds.get(char) ?? char;
}

const same = (a: string, b: string, flags: Flags): boolean => a === b || (flags.i && folded(a, flags.a) === folded(b, flags.a));
const word = (char: string | undefined, ascii: boolean): boolean => char !== undefined && (ascii ? /^[a-zA-Z0-9_]$/u.test(char) : char === "_" || letters.test(char) || numbers.test(char));
const referenceSame = (a: string, b: string, flags: Flags): boolean => a === b || (flags.i && (flags.a
  ? folded(a, true) === folded(b, true) : (lowercases.get(a) ?? a) === (lowercases.get(b) ?? b)));

function width(node: Node): Width {
  switch (node.kind) {
    case "character": return [1, 1];
    case "anchor": case "assertion": return [0, 0];
    case "capture": case "group": case "atomic": return width(node.node);
    case "reference": return node.width;
    case "repeat": {
      if (node.max === 0) return [0, 0];
      const [lo, hi] = width(node.node);
      return [lo * node.min, hi === 0 ? 0 : hi * node.max];
    }
    case "sequence": return node.nodes.reduce<Width>(([lo, hi], child) => { const w = width(child); return [lo + w[0], hi + w[1]]; }, [0, 0]);
    case "choice": {
      const widths = node.nodes.map(width);
      return [Math.min(...widths.map(w => w[0])), Math.max(...widths.map(w => w[1]))];
    }
    case "conditional": {
      const yes = width(node.yes), no = width(node.no);
      return [Math.min(yes[0], no[0]), Math.max(yes[1], no[1])];
    }
  }
}

class Parser {
  private position = 0;
  private flags: Flags = { i: true, a: false, m: false, s: false, x: false };
  private readonly chars: string[];
  private groups = 0;
  private readonly groupNames = new Map<string, number>();
  private readonly groupWidths = new Map<number, Width>();
  private readonly conditionals: number[] = [];
  private lookbehindGroups?: number;
  private globalFlagsAllowed = true;
  private globalCharacterMode?: "a" | "u";

  constructor(pattern: string) { this.chars = Array.from(pattern); }
  private peek(): string { return this.chars[this.position] ?? ""; }
  private take(): string { return this.chars[this.position++] ?? ""; }
  private error(message: string): never { throw new SyntaxError(`${message} at position ${this.position}`); }
  private until(end: string): string {
    const start = this.position;
    while (this.peek() && this.peek() !== end) this.position++;
    if (!this.peek()) this.error(`missing ${end}`);
    const value = this.chars.slice(start, this.position).join(""); this.position++;
    return value;
  }
  private skip(): void {
    if (!this.flags.x) return;
    while (this.peek()) {
      if (/[ \t\n\r\v\f]/u.test(this.peek())) this.position++;
      else if (this.peek() === "#") { while (this.peek() && this.take() !== "\n") { /* comment */ } }
      else break;
    }
  }

  parse(): Node {
    const node = this.alternatives();
    if (this.peek()) this.error("unbalanced parenthesis");
    for (const id of this.conditionals) if (id > this.groups) this.error(`invalid group reference ${id}`);
    return node;
  }

  private alternatives(): Node {
    const nodes = [this.sequence()];
    while (this.peek() === "|") { this.position++; this.globalFlagsAllowed = false; nodes.push(this.sequence()); }
    return nodes.length === 1 ? nodes[0] : { kind: "choice", nodes };
  }

  private sequence(): Node {
    const nodes: Node[] = [];
    while (true) {
      this.skip();
      if (!this.peek() || this.peek() === ")" || this.peek() === "|") break;
      const repetition = this.quantifier();
      if (repetition) {
        const atom = nodes.pop();
        if (!atom || atom.kind === "anchor") this.error("nothing to repeat");
        if (atom.kind === "repeat") this.error("multiple repeat");
        let greedy = true, possessive = false;
        if (this.peek() === "?") { greedy = false; this.position++; }
        else if (this.peek() === "+") { possessive = true; this.position++; }
        nodes.push({ kind: "repeat", node: atom, ...repetition, greedy, possessive });
      } else {
        const atom = this.atom();
        if (!atom) continue;
        this.globalFlagsAllowed = false;
        nodes.push(atom);
      }
    }
    return nodes.length === 1 ? nodes[0] : { kind: "sequence", nodes };
  }

  private quantifier(): { min: number; max: number } | undefined {
    const char = this.peek();
    if (char === "*" || char === "+" || char === "?") {
      this.position++;
      return { min: char === "+" ? 1 : 0, max: char === "?" ? 1 : Infinity };
    }
    if (char !== "{") return;
    const match = /^\{(?:(\d+)|(\d*),(\d*))\}/u.exec(this.chars.slice(this.position).join(""));
    if (!match) return;
    const min = Number(match[1] ?? (match[2] || 0)), max = match[1] ? min : match[3] ? Number(match[3]) : Infinity;
    if (max < min) this.error("min repeat greater than max repeat");
    if (min >= 4294967295 || (max !== Infinity && max >= 4294967295)) this.error("the repetition number is too large");
    this.position += match[0].length;
    return { min, max };
  }

  private literal(char: string): Node {
    const flags = this.flags;
    return { kind: "character", accepts: candidate => same(candidate, char, flags) };
  }

  private atom(): Node | undefined {
    const char = this.take(), flags = this.flags;
    if (char === "(") return this.group();
    if (char === "[") return this.characterClass();
    if (char === "\\") {
      const escaped = this.escape(false);
      return "kind" in escaped && escaped.kind === "literal" ? this.literal(escaped.char)
        : escaped.kind === "predicate" ? { kind: "character", accepts: escaped.accepts } : escaped;
    }
    if (char === ".") return { kind: "character", accepts: value => flags.s || value !== "\n" };
    if (char === "^") return { kind: "anchor", accepts: (text, pos) => pos === 0 || (flags.m && text[pos - 1] === "\n") };
    if (char === "$") return { kind: "anchor", accepts: (text, pos) => pos === text.length || (text[pos] === "\n" && (flags.m || pos === text.length - 1)) };
    return this.literal(char);
  }

  private reference(id: number): Node {
    const saved = this.groupWidths.get(id);
    if (!saved) this.error(id <= this.groups ? "cannot refer to an open group" : `invalid group reference ${id}`);
    if (this.lookbehindGroups !== undefined && id > this.lookbehindGroups) this.error("cannot refer to group defined in the same lookbehind subpattern");
    return { kind: "reference", id, flags: this.flags, width: saved };
  }

  private group(): Node | undefined {
    const outer = this.flags;
    let capture: number | undefined, atomic = false;
    let assertion: { positive: boolean; behind: boolean } | undefined;
    let conditional: number | undefined;
    const previousLookbehind = this.lookbehindGroups;
    if (this.peek() !== "?") capture = ++this.groups;
    else {
      this.position++;
      const kind = this.take();
      if (kind === "#") {
        while (this.peek()) {
          const char = this.take();
          if (char === ")") return;
          if (char === "\\") this.take();
        }
        this.error("missing ), unterminated comment");
      }
      if (kind === "P") {
        const form = this.take();
        if (form === "=") {
          const name = this.until(")"), id = this.groupNames.get(name);
          if (!id) this.error(`unknown group name '${name}'`);
          return this.reference(id);
        }
        if (form !== "<") this.error("unknown extension ?P");
        const name = this.until(">");
        const [first, ...rest] = Array.from(name);
        if (!first || (first !== "_" && !identifierStart.test(first)) || rest.some(char => !identifierContinue.test(char))) this.error(`bad character in group name '${name}'`);
        if (this.groupNames.has(name)) this.error(`redefinition of group name '${name}'`);
        capture = ++this.groups; this.groupNames.set(name, capture);
      } else if (kind === ">") atomic = true;
      else if (kind === "=" || kind === "!") assertion = { positive: kind === "=", behind: false };
      else if (kind === "<") {
        const sign = this.take();
        if (sign !== "=" && sign !== "!") this.error("unknown extension ?<");
        assertion = { positive: sign === "=", behind: true };
        this.lookbehindGroups ??= this.groups;
      } else if (kind === "(") {
        const id = this.until(")");
        conditional = /^\d+$/u.test(id) ? Number(id) : this.groupNames.get(id);
        if (!conditional) this.error(`unknown group name '${id}'`);
        if (this.lookbehindGroups !== undefined && (!this.groupWidths.has(conditional) || conditional > this.lookbehindGroups)) this.error("cannot refer to group defined in the same lookbehind subpattern");
        this.conditionals.push(conditional);
      } else if (kind !== ":") {
        if (!/^[aiLmsux-]$/u.test(kind)) this.error(`unknown extension ?${kind}`);
        let spec = kind;
        while (this.peek() && this.peek() !== ":" && this.peek() !== ")") spec += this.take();
        const end = this.take();
        if (end !== ":" && end !== ")") this.error("missing ), unterminated subpattern");
        this.flags = this.modifiedFlags(spec);
        if (end === ")") {
          if (!this.globalFlagsAllowed || spec.includes("-")) this.error("global flags not at the start of the expression");
          const mode = spec.includes("a") ? "a" : spec.includes("u") ? "u" : undefined;
          if (mode && this.globalCharacterMode && mode !== this.globalCharacterMode) this.error("ASCII and UNICODE flags are incompatible");
          this.globalCharacterMode ??= mode;
          return;
        }
      }
    }
    this.globalFlagsAllowed = false;
    let node: Node;
    if (conditional !== undefined) {
      const yes = this.sequence(); let no = EMPTY;
      if (this.peek() === "|") { this.position++; no = this.sequence(); }
      if (this.peek() === "|") this.error("conditional backref with more than two branches");
      node = { kind: "conditional", id: conditional, yes, no };
    } else node = this.alternatives();
    if (this.take() !== ")") this.error("missing ), unterminated subpattern");
    this.flags = outer; this.lookbehindGroups = previousLookbehind;
    if (capture !== undefined) { this.groupWidths.set(capture, width(node)); return { kind: "capture", id: capture, node }; }
    if (atomic) return { kind: "atomic", node };
    if (assertion) {
      const w = width(node);
      if (assertion.behind && w[0] !== w[1]) this.error("look-behind requires fixed-width pattern");
      return { kind: "assertion", node, positive: assertion.positive, behind: assertion.behind ? w[0] : 0 };
    }
    return { kind: "group", node };
  }

  private modifiedFlags(spec: string): Flags {
    if (!/^[aimsux]*(?:-[imsx]+)?$/u.test(spec)) this.error("bad inline flags");
    const [on, off = ""] = spec.split("-");
    if (on.includes("a") && on.includes("u")) this.error("flags 'a', 'u' and 'L' are incompatible");
    if ([...off].some(char => on.includes(char))) this.error("flag turned on and off");
    const flags = { ...this.flags };
    for (const key of ["i", "m", "s", "x"] as const) { if (on.includes(key)) flags[key] = true; if (off.includes(key)) flags[key] = false; }
    if (on.includes("a")) flags.a = true;
    if (on.includes("u")) flags.a = false;
    return flags;
  }

  private escape(inClass: boolean): ClassItem | Node {
    const char = this.take(), flags = this.flags;
    if (!char) this.error("bad escape (end of pattern)");
    if (/[dDsSwW]/u.test(char)) {
      const lower = char.toLowerCase();
      const accepts = (value: string) => lower === "w" ? word(value, flags.a)
        : lower === "s" ? (flags.a ? /^[ \t\n\r\v\f]$/u.test(value) : SPACE.test(value))
        : (flags.a ? /^[0-9]$/u.test(value) : digits.test(value));
      return { kind: "predicate", accepts: value => char === lower ? accepts(value) : !accepts(value) };
    }
    if (!inClass && /[AbBZz]/u.test(char)) {
      return { kind: "anchor", accepts: (text, pos) => char === "A" ? pos === 0 : char === "Z" || char === "z" ? pos === text.length
        : (word(text[pos - 1], flags.a) !== word(text[pos], flags.a)) === (char === "b") };
    }
    const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
    if (char in escapes) return { kind: "literal", char: escapes[char] };
    if (char === "x" || char === "u" || char === "U") {
      const count = char === "x" ? 2 : char === "u" ? 4 : 8;
      const value = this.chars.slice(this.position, this.position + count).join("");
      if (value.length !== count || !/^[\da-f]+$/iu.test(value) || Number.parseInt(value, 16) > 0x10ffff) this.error(`incomplete escape \\${char}${value}`);
      this.position += count;
      return { kind: "literal", char: String.fromCodePoint(Number.parseInt(value, 16)) };
    }
    if (char === "N") {
      if (this.take() !== "{") this.error("missing { in character name");
      const name = this.until("}"), value = namedCharacter(name);
      if (value === undefined) this.error(`undefined character name '${name}'`);
      return { kind: "literal", char: value };
    }
    if (/^[0-9]$/u.test(char)) {
      let number = char;
      if (inClass || char === "0" || (/^[0-7]$/u.test(char) && /^[0-7]$/u.test(this.peek()) && /^[0-7]$/u.test(this.chars[this.position + 1] ?? ""))) {
        if (!/^[0-7]$/u.test(char)) this.error(`bad escape \\${char}`);
        while (number.length < 3 && /^[0-7]$/u.test(this.peek())) number += this.take();
        const code = Number.parseInt(number, 8);
        if (code > 255) this.error(`octal escape value \\${number} outside of range 0-0o377`);
        return { kind: "literal", char: String.fromCodePoint(code) };
      }
      if (/^[0-9]$/u.test(this.peek())) number += this.take();
      return this.reference(Number(number));
    }
    if (/^[a-zA-Z]$/u.test(char)) this.error(`bad escape \\${char}`);
    return { kind: "literal", char };
  }

  private classItem(): ClassItem {
    const char = this.take();
    if (char !== "\\") return { kind: "literal", char };
    const item = this.escape(true);
    if (item.kind !== "literal" && item.kind !== "predicate") this.error("bad escape in character set");
    return item;
  }

  private characterClass(): Node {
    const flags = this.flags, predicates: Array<(char: string) => boolean> = [];
    const negate = this.peek() === "^";
    if (negate) this.position++;
    let first = true, closed = false;
    while (this.peek()) {
      if (this.peek() === "]" && !first) { this.position++; closed = true; break; }
      first = false;
      const item = this.classItem();
      if (this.peek() === "-" && this.chars[this.position + 1] !== "]") {
        this.position++;
        const end = this.classItem();
        if (item.kind !== "literal" || end.kind !== "literal") this.error("bad character range");
        const low = item.char.codePointAt(0)!, high = end.char.codePointAt(0)!;
        if (low > high) this.error("bad character range");
        const range = new Set<string>();
        if (flags.i) for (let code = low; code <= high; code++) range.add(folded(String.fromCodePoint(code), flags.a));
        predicates.push(char => { const code = char.codePointAt(0)!; return (code >= low && code <= high) || (flags.i && range.has(folded(char, flags.a))); });
      } else if (item.kind === "predicate") predicates.push(item.accepts);
      else predicates.push(char => same(char, item.char, flags));
    }
    if (!closed) this.error("unterminated character set");
    return { kind: "character", accepts: char => predicates.some(test => test(char)) !== negate };
  }
}

function* sequence(nodes: Node[], text: string[], state: State): Generator<State> {
  if (!nodes.length) { yield state; return; }
  const stack = [match(nodes[0], text, state)];
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) stack.pop();
    else if (stack.length === nodes.length) yield next.value;
    else stack.push(match(nodes[stack.length], text, next.value));
  }
}

function* repeat(node: Extract<Node, { kind: "repeat" }>, text: string[], initial: State): Generator<State> {
  if (node.possessive) {
    let state = initial, count = 0;
    for (; count < node.min; count++) {
      const next = match(node.node, text, state).next();
      if (next.done) return;
      state = next.value;
    }
    for (; count < node.max; count++) {
      const next = match(node.node, text, state).next();
      if (next.done) break;
      const previous = state.position;
      state = next.value;
      if (state.position === previous) break;
    }
    yield state;
    return;
  }
  type Frame = { count: number; state: State; matches: Generator<State>; entered: boolean };
  const frame = (count: number, state: State): Frame => ({ count, state, matches: match(node.node, text, state), entered: false });
  const stack = [frame(0, initial)];
  while (stack.length) {
    const current = stack[stack.length - 1];
    const { count, state } = current;
    if (!current.entered) {
      current.entered = true;
      if (!node.greedy && count >= node.min) yield state;
    }
    const next = count < node.max ? current.matches.next() : undefined;
    if (next && !next.done) {
      // Retain captures from a successful empty iteration, but never spin on it.
      if (next.value.position === state.position && count >= node.min) yield next.value;
      else stack.push(frame(count + 1, next.value));
    } else {
      stack.pop();
      if (node.greedy && count >= node.min) yield state;
    }
  }
}

const closed = (capture: Capture | undefined): capture is Capture & { end: number } =>
  capture !== undefined && capture.end !== undefined && capture.end >= capture.start;

function* match(node: Node, text: string[], state: State): Generator<State> {
  const { position, captures } = state;
  switch (node.kind) {
    case "character": if (position < text.length && node.accepts(text[position])) yield { position: position + 1, captures }; return;
    case "anchor": if (node.accepts(text, position)) yield state; return;
    case "sequence": yield* sequence(node.nodes, text, state); return;
    case "group": yield* match(node.node, text, state); return;
    case "choice": for (const child of node.nodes) yield* match(child, text, state); return;
    case "capture": {
      const entered = new Map(captures).set(node.id, { start: position, end: captures.get(node.id)?.end });
      for (const next of match(node.node, text, { position, captures: entered })) {
        yield { position: next.position, captures: new Map(next.captures).set(node.id, { start: position, end: next.position }) };
      }
      return;
    }
    case "reference": {
      const capture = captures.get(node.id);
      if (!closed(capture)) return;
      const value = text.slice(capture.start, capture.end);
      if (value.every((char, i) => position + i < text.length && referenceSame(char, text[position + i], node.flags))) yield { position: position + value.length, captures };
      return;
    }
    case "repeat": yield* repeat(node, text, state); return;
    case "atomic": { const first = match(node.node, text, state).next(); if (!first.done) yield first.value; return; }
    case "assertion": {
      const start = position - node.behind;
      const first = start < 0 ? undefined : match(node.node, text, { position: start, captures }).next();
      if (node.positive && first && !first.done) yield { position, captures: first.value.captures };
      if (!node.positive && (!first || first.done)) yield state;
      return;
    }
    case "conditional": yield* match(closed(captures.get(node.id)) ? node.yes : node.no, text, state); return;
  }
}

export function compileRecallPattern(pattern: string): { test: (value: string) => boolean } {
  const node = new Parser(pattern).parse();
  return { test(value) {
    const text = Array.from(value);
    for (let position = 0; position <= text.length; position++) if (!match(node, text, { position, captures: new Map() }).next().done) return true;
    return false;
  } };
}
