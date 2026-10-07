import digits from "@unicode/unicode-16.0.0/General_Category/Decimal_Number/code-points.mjs";

const VALUES = new Map(digits.map((code, index) => [String.fromCodePoint(code), String(index % 10)]));

export function decimal(value: string): number | undefined {
  if (!value) return;
  let ascii = "";
  for (const char of value) {
    const digit = VALUES.get(char);
    if (digit === undefined) return;
    ascii += digit;
  }
  const number = Number(ascii);
  return Number.isSafeInteger(number) ? number : undefined;
}
