// Ported from VictorTaelin/OptMem, commit 1fb164cf39028047781f72ac3bb1e5a691c1dcb0.
export type Block = readonly [lo: number, hi: number];

function coverAt(total: number, alpha: number): Block[] {
  let root = 1;
  while (root < total) root *= 2;
  const out: Block[] = [];
  const stack: Block[] = [[0, root]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (lo >= total) continue;
    const size = hi - lo;
    if (size > 1 && (hi > total || size > alpha * (total - lo))) {
      const mid = (lo + hi) / 2;
      stack.push([mid, hi], [lo, mid]);
    } else out.push([lo, hi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function cover(total: number, budget: number): Block[] {
  if (total <= 0) return [];
  if (total <= budget) return Array.from({ length: total }, (_, i) => [i, i + 1]);
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (coverAt(total, mid).length > budget) lo = mid;
    else hi = mid;
  }
  const out = coverAt(total, hi);
  while (out.length < budget) {
    const i = out.findLastIndex(([a, b]) => b - a > 1);
    if (i < 0) break;
    const [a, b] = out[i];
    const mid = (a + b) / 2;
    out.splice(i, 1, [a, mid], [mid, b]);
  }
  return out;
}
