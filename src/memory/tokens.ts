import { getEncoding } from "js-tiktoken";

let encoder: ReturnType<typeof getEncoding> | undefined;

export function estimateTokens(text: string): number {
  encoder ??= getEncoding("o200k_base");
  return encoder.encode(text).length;
}
