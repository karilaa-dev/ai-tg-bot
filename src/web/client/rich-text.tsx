import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "./components/ui/code-block.js";

export function RichText({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="text-muted-foreground">[External image{alt ? `: ${alt}` : ""}]</span>,
    a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
    pre: ({ children }) => <div className="code-container">{children}</div>,
    code: ({ className, children, node }) => {
      const source = String(children).replace(/\n$/, "");
      const block = className?.startsWith("language-") || (node?.position && node.position.end.line > node.position.start.line);
      return block ? <CodeBlock code={source} language={className?.replace("language-", "") ?? "text"} mode="auto" accent="#2563eb" showLineNumbers={false} /> : <code>{children}</code>;
    },
  }}>{text}</Markdown></div>;
}

