import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { defaultHandlers, toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import { gfm } from "micromark-extension-gfm";
import { escapeHtml } from "../util/text.js";

type MarkdownRoot = ReturnType<typeof fromMarkdown>;
type Table = Extract<MarkdownRoot["children"][number], { type: "table" }>;
type Html = Extract<MarkdownRoot["children"][number], { type: "html" }>;
type Replacement = { start: number; end: number; text: string };

/** Replace only tables, keeping the surrounding Telegram Markdown intact. */
export function compactMarkdownTables(markdown: string): string {
  if (!markdown.includes("|") && !/<table\b/i.test(markdown)) return markdown;
  const replacements: Replacement[] = [];
  const htmlState = { codeDepth: 0 };
  let inTable = false;
  const tableFootnotes = new Set<string>();
  const outsideFootnotes: Array<Replacement & { key: string }> = [];
  const replace = (node: { position?: MarkdownRoot["position"] }, text: string) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) replacements.push({ start, end, text });
  };
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = root.children.filter(node => node.type === "definition" || node.type === "footnoteDefinition")
    .map(node => markdown.slice(node.position?.start.offset, node.position?.end.offset)).join("\n\n");
  toHast(root, {
    allowDangerousHtml: true,
    handlers: {
      table(state, node: Table) {
        if (htmlState.codeDepth) return defaultHandlers.table(state, node);
        for (const row of node.children) for (const cell of row.children) {
          const start = cell.children[0]?.position?.start.offset;
          const end = cell.children.at(-1)?.position?.end.offset;
          if (start === undefined || end === undefined) continue;
          const source = markdown.slice(start, end);
          const inline = telegramInlineHtml(source);
          if (inline === source) continue;
          const parsed = fromMarkdown(`${inline}\n\n${definitions}`, {
            extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
          }).children[0];
          if (parsed?.type === "paragraph") cell.children = parsed.children;
        }
        // Telegram allows at most 20 columns. Fold overflow into the last cell
        // instead of letting the HTML renderer silently discard it.
        const width = Math.min(20, node.children[0]?.children.length ?? 0);
        node.align = node.align?.slice(0, width);
        for (const row of node.children) {
          if (row.children.length <= width) continue;
          const overflow = row.children.splice(width - 1);
          row.children.push({ type: "tableCell", children: overflow.flatMap((cell, index) =>
            index ? [{ type: "text" as const, value: " | " }, ...cell.children] : cell.children) });
        }
        inTable = true;
        const table = defaultHandlers.table(state, node);
        inTable = false;
        if (!table || Array.isArray(table) || table.type !== "element") return table;
        table.properties.compact = true;
        // Telegram supports direct rows, without HTML's thead/tbody wrappers.
        const html = toHtml(table, { allowDangerousHtml: true })
          .replace(/<\/?(?:thead|tbody)>/g, "").replace(/\n/g, "");
        replace(node, html);
        return table;
      },
      html(state, node: Html) {
        const html = compactHtmlTables(node.value, htmlState);
        if (!inTable && html !== node.value) replace(node, html);
        return defaultHandlers.html(state, node);
      },
      footnoteReference(state, node) {
        const key = String(node.identifier).toUpperCase();
        const name = `compact-note-${encodeURIComponent(key.toLowerCase())}`;
        const text = `<a href="#${name}">[${escapeHtml(node.label ?? node.identifier)}]</a>`;
        if (inTable && !tableFootnotes.has(key)) {
          tableFootnotes.add(key);
          const definition = state.footnoteById.get(key);
          if (definition) {
            const content = definition.children.map(child => toHtml(state.all(child), { allowDangerousHtml: true })).join("<br>");
            replace(definition, `<tg-reference name="${name}">${content}</tg-reference>`);
          }
        } else if (!inTable && node.position) {
          outsideFootnotes.push({ key, start: node.position.start.offset, end: node.position.end.offset, text });
        }
        return { type: "raw", value: text };
      },
    },
  });
  replacements.push(...outsideFootnotes.filter(reference => tableFootnotes.has(reference.key)));
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  let offset = 0;
  const out: string[] = [];
  for (const replacement of replacements) {
    if (replacement.start < offset) continue;
    out.push(markdown.slice(offset, replacement.start), replacement.text);
    offset = replacement.end;
  }
  out.push(markdown.slice(offset));
  return out.join("");
}

function telegramInlineHtml(markdown: string): string {
  return markdown.replace(/(`+)[\s\S]*?\1|<(code|tg-math)\b[^>]*>[\s\S]*?<\/\2>|<[^>]+>|\\.|(?<!\$)\$((?:\\.|[^$\\\n])+)\$(?!\$)|==([^=\n]+)==/g,
    (match, _ticks, _tag, formula: string | undefined, marked: string | undefined) => {
      if (formula !== undefined) {
        const literal = escapeHtml(formula).replace(/[\\`*_[\]~]/g, "\\$&");
        return `<tg-math>${literal}</tg-math>`;
      }
      return marked === undefined ? match : `<mark>${telegramInlineHtml(marked)}</mark>`;
    });
}

export function compactHtmlTables(html: string, state = { codeDepth: 0 }): string {
  return html.replace(/<!--[\s\S]*?-->|<\/?[a-z][\w-]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*>/gi, tag => {
    if (tag.startsWith("<!--")) return tag;
    if (/^<\/?(?:pre|code|script|style|textarea)\b/i.test(tag)) {
      state.codeDepth = Math.max(0, state.codeDepth + (tag.startsWith("</") ? -1 : 1));
      return tag;
    }
    if (state.codeDepth || !/^<table(?=[\s>])/i.test(tag)) return tag;
    // Set the boolean attribute once, including when the input supplied a value.
    const withoutCompact = tag.replace(/("[^"]*"|'[^']*')|\s+compact(?=[\s=>])(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
      (_match, quoted: string | undefined) => quoted ?? "");
    return withoutCompact.replace(/\s*>$/, " compact>");
  });
}
