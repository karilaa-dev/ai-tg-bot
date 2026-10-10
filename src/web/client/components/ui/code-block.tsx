import { Check, Copy } from "lucide-react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { useEffect, useRef, useState } from "react";
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

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const source = code.replace(/^\n+/, "").trimEnd();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source);
      } else {
        const area = document.createElement("textarea");
        area.value = source;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        try {
          area.select();
          if (!document.execCommand("copy")) return;
        } finally { area.remove(); }
      }
    } catch { return; }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }

  return <div className="code-block">
    <div className="code-block-header"><span>{language}</span><Button variant="ghost" size="icon-sm" aria-label={copied ? "Copied" : "Copy code"} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button></div>
    <div className="code-block-viewport" role="region" aria-label={`${language} code`} tabIndex={0}>
      <Highlight code={source} language={language} theme={theme}>
        {({ tokens, getLineProps, getTokenProps }) => <pre>{tokens.map((line, index) => <div key={index} {...getLineProps({ line })}>{line.map((token, key) => <span key={key} {...getTokenProps({ token })} />)}</div>)}</pre>}
      </Highlight>
    </div>
  </div>;
}
