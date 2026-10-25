import { createContext } from "react";
import type { OpenUiLanguage } from "../../openui/language.js";

export type { OpenUiLanguage };
/** The answer's language, which can differ from the website locale. */
export const LanguageContext = createContext<OpenUiLanguage>("en");
