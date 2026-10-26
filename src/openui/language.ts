import { z } from "zod";

export const OpenUiLanguageSchema = z.enum(["en", "ru"]);
export type OpenUiLanguage = z.infer<typeof OpenUiLanguageSchema>;

/** Saved responses predate language metadata; infer their prose, never the viewer's settings. */
export function resolveOpenUiLanguage(text: string, explicit?: unknown): OpenUiLanguage {
  const saved = OpenUiLanguageSchema.safeParse(explicit);
  if (saved.success) return saved.data;
  const prose = text.slice(0, 32_000)
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ");
  const russian = prose.match(/[\p{Script=Cyrillic}]+/gu)?.length ?? 0;
  const english = prose.match(/[A-Za-z]+/gu)?.length ?? 0;
  return russian > english ? "ru" : "en";
}
