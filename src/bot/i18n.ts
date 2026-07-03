import path from "node:path";
import { I18n } from "@grammyjs/i18n";
import type { Locale } from "../db/types.js";

export type { Locale } from "../db/types.js";

export class Localizer {
  private readonly i18n: I18n;

  constructor(root = process.cwd()) {
    this.i18n = new I18n({ defaultLocale: "en", fluentBundleOptions: { useIsolating: false } });
    this.i18n.loadLocalesDirSync(path.join(root, "locales"));
  }

  t(locale: string | undefined, key: string, params: Record<string, string | number> = {}): string {
    const lang: Locale = locale === "ru" ? "ru" : "en";
    return this.i18n.t(lang, key, params);
  }
}
