import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const MemoryEnvironmentSchema = z.object({
  OPTMEM_WAKE_LINES: positiveInteger.default(96),
  OPTMEM_ENTRY_CHARS: positiveInteger.max(280).default(280),
  OPTMEM_PART_CHARS: positiveInteger.default(20000),
  OPTMEM_PART_LINES: positiveInteger.default(500),
});
export type MemoryEnvironment = z.infer<typeof MemoryEnvironmentSchema>;
export interface MemorySizes { WAKE_LINES: number; ENTRY_CHARS: number; PART_CHARS: number; PART_LINES: number }
export function memorySizes(config: MemoryEnvironment): MemorySizes {
  return { WAKE_LINES: config.OPTMEM_WAKE_LINES, ENTRY_CHARS: config.OPTMEM_ENTRY_CHARS,
    PART_CHARS: config.OPTMEM_PART_CHARS, PART_LINES: config.OPTMEM_PART_LINES };
}
export const DEFAULT_MEMORY_SIZES = memorySizes(MemoryEnvironmentSchema.parse({}));
