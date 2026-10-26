import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { useEffect, useRef, useState } from "react";
import { sharedStrings, useUiLanguage, type UiLanguage } from "../../i18n.js";
import { copyText } from "../../lib/clipboard.js";
import { Button } from "./button.js";

const theme: PrismTheme = {
  plain: { color: "var(--foreground)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--muted-foreground)", fontStyle: "italic" } },
    { types: ["keyword", "selector", "atrule", "important", "tag", "operator"], style: { color: "var(--text-color-kumo-link)" } },
    { types: ["string", "char", "inserted", "url"], style: { color: "var(--text-color-kumo-success)" } },
    { types: ["number", "boolean", "constant", "symbol", "deleted", "regex"], style: { color: "var(--text-color-kumo-danger)" } },
  ],
};

/**
 * `language` is the code's syntax; the interface language comes from context unless `locale` overrides it.
 * `preserveWhitespace` shows and copies raw tool scripts and output exactly instead of trimming Markdown fences.
 */
export function CodeBlock({ code, language, locale, preserveWhitespace = false }: { code: string; language: string; locale?: UiLanguage; preserveWhitespace?: boolean }) {
  const contextLanguage = useUiLanguage();
  const t = sharedStrings(locale ?? contextLanguage);
  const source = preserveWhitespace ? code : code.replace(/^\n+/, "").trimEnd();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    if (!await copyText(source)) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }

  return <div className="code-block">
    <div className="code-block-header"><span>{language}</span><Button variant="ghost" size="icon-sm" aria-label={copied ? t.copied : t.copyCode} title={copied ? t.copied : t.copyCode} onClick={() => void copy()}>{copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}</Button></div>
    <div className="code-block-viewport" role="region" aria-label={t.codeRegion(language)} tabIndex={0}>
      <Highlight code={source} language={language} theme={theme}>
        {({ tokens, getLineProps, getTokenProps }) => <pre>{tokens.map((line, index) => <div key={index} {...getLineProps({ line })}>{line.map((token, key) => <span key={key} {...getTokenProps({ token })} />)}</div>)}</pre>}
      </Highlight>
    </div>
  </div>;
}
