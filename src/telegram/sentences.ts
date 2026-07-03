const abbreviations = new Set(["e.g.", "i.e.", "т.д.", "т.п."]);

export class SentenceAssembler {
  completed: string[] = [];
  remainder = "";

  push(delta: string): void {
    this.remainder += delta;
    this.scan();
  }

  private scan(): void {
    for (;;) {
      const boundary = this.findBoundary();
      if (boundary <= 0) return;
      this.completed.push(this.remainder.slice(0, boundary));
      this.remainder = this.remainder.slice(boundary);
    }
  }

  private findBoundary(): number {
    let inFence = false;
    let inMathBlock = false;
    for (let i = 0; i < this.remainder.length; i += 1) {
      if (this.remainder.startsWith("```", i)) {
        inFence = !inFence;
        i += 2;
        if (!inFence) return i + 1;
        continue;
      }
      if (this.remainder.startsWith("$$", i)) {
        inMathBlock = !inMathBlock;
        i += 1;
        continue;
      }
      if (inFence || inMathBlock) continue;
      if (this.remainder[i] === "\n" && this.remainder[i + 1] === "\n") return i + 2;
      if (/[.!?…]/u.test(this.remainder[i] ?? "") && this.isSentenceEnd(i)) return i + 1;
    }
    return -1;
  }

  private isSentenceEnd(index: number): boolean {
    const char = this.remainder[index];
    const next = this.remainder[index + 1] ?? "";
    if (char === "." && /\d/.test(this.remainder[index - 1] ?? "") && /\d/.test(next)) {
      return false;
    }
    const word = this.remainder.slice(Math.max(0, index - 5), index + 1).toLowerCase();
    for (const abbr of abbreviations) {
      if (word.endsWith(abbr)) return false;
    }
    if (char === "." && /^[A-Za-zА-Яа-я]$/.test(this.remainder[index - 1] ?? "")) {
      const prevPrev = this.remainder[index - 2] ?? " ";
      if (/\s/.test(prevPrev)) return false;
    }
    const urlStart = this.remainder.lastIndexOf("http", index);
    const lastSpace = Math.max(
      this.remainder.lastIndexOf(" ", index),
      this.remainder.lastIndexOf("\n", index),
    );
    if (urlStart > lastSpace) return false;
    return next === "" || /\s/.test(next);
  }
}
