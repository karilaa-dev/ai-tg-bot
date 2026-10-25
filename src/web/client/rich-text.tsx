import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./components/ui/code-block.js";
import { useSharedStrings } from "./i18n.js";

function ExternalImage({ alt }: { alt?: string }) {
  return <span className="text-(--muted-foreground)">{useSharedStrings().externalImage(alt ?? "")}</span>;
}

const components: Components = {
  img: ({ alt }) => <ExternalImage alt={alt} />,
  a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
  pre: ({ children }) => <div className="code-container">{children}</div>,
  code: ({ className, children, node }) => {
    const source = String(children).replace(/\n$/, "");
    const block = className?.startsWith("language-") || (node?.position && node.position.end.line > node.position.start.line);
    return block ? <CodeBlock code={source} language={className?.replace("language-", "") ?? "text"} /> : <code>{children}</code>;
  },
};

export function RichText({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown></div>;
}
