export const RICH_MESSAGE_BYTE_LIMIT = 32768;

const allowedHtmlTags = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "mark",
  "sub",
  "sup",
  "tg-spoiler",
  "a",
  "img",
  "video",
  "audio",
  "figure",
  "figcaption",
  "cite",
  "blockquote",
  "aside",
  "details",
  "summary",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "footer",
  "hr",
  "ul",
  "ol",
  "li",
  "table",
  "caption",
  "tr",
  "th",
  "td",
  "tg-emoji",
  "tg-time",
  "tg-math",
  "tg-math-block",
  "tg-map",
  "tg-collage",
  "tg-slideshow",
  "tg-reference",
  "br",
  "tg-thinking",
]);

export function closeOpenStructures(md: string): string {
  let out = balanceFences(md);
  out = trimIncompleteTableLine(out);
  out = closeTag(out, "summary");
  out = closeTag(out, "details");
  return out;
}

export function sanitize(md: string, options: { allowThinking?: boolean; enforceLimit?: boolean } = {}): string {
  let out = md.replace(/\r\n/g, "\n");
  if (!options.allowThinking) {
    out = out.replace(/<\/?tg-thinking[^>]*>/gi, "");
  }
  out = escapeUnknownHtml(out);
  out = normalizeTables(out);
  out = escapeOrphanFootnoteRefs(out);
  out = flattenDeepNesting(out);
  out = closeOpenStructures(out);
  return options.enforceLimit === false ? out : enforceRichLimit(out);
}

export function repairLadder(md: string): string[] {
  const sanitized = sanitize(md);
  const escaped = escapeAllHtml(md);
  return [
    sanitized,
    escaped,
    neutralizeExotics(escaped),
    fenceWholeBlocks(md),
  ];
}

export function escapeAllHtml(md: string): string {
  return md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function neutralizeExotics(md: string): string {
  return md
    .replace(/\$\$([\s\S]*?)\$\$/g, "```math\n$1\n```")
    .replace(/\$([^$\n]+)\$/g, "`$1`")
    .replace(/==([^=\n]+)==/g, "**$1**")
    .replace(/\[\^([^\]]+)\]:\s*(.+)$/gm, "($1: $2)");
}

export function fenceWholeBlocks(md: string): string {
  return md
    .split(/\n{2,}/)
    .map((block) => (block.startsWith("```") ? block : `\`\`\`\n${block}\n\`\`\``))
    .join("\n\n");
}

function balanceFences(md: string): string {
  const count = md.match(/^```/gm)?.length ?? 0;
  return count % 2 === 1 ? `${md}\n\`\`\`` : md;
}

function trimIncompleteTableLine(md: string): string {
  const lines = md.split("\n");
  const last = lines.at(-1);
  if (last && last.includes("|") && !last.trim().endsWith("|")) {
    lines.pop();
    return lines.join("\n");
  }
  return md;
}

function closeTag(md: string, tag: string): string {
  const open = (md.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "gi")) ?? []).length;
  const close = (md.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
  return open > close ? `${md}${`</${tag}>`.repeat(open - close)}` : md;
}

function escapeUnknownHtml(md: string): string {
  return md.replace(/<\/?([a-zA-Z][\w-]*)(\s[^>]*)?>/g, (tag, name: string) => {
    return allowedHtmlTags.has(name.toLowerCase()) ? tag : escapeAllHtml(tag);
  });
}

function normalizeTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      const headerCells = splitRow(line).slice(0, 20);
      const width = headerCells.length;
      out.push(formatRow(headerCells, width));
      out.push(formatRow(Array.from({ length: width }, () => "---"), width));
      i += 1;
      while (i + 1 < lines.length && lines[i + 1]?.includes("|")) {
        i += 1;
        out.push(formatRow(splitRow(lines[i] ?? ""), width));
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function escapeOrphanFootnoteRefs(md: string): string {
  const definitions = new Set<string>();
  for (const match of md.matchAll(/^\[\^([^\]]+)\]:/gm)) {
    definitions.add(match[1]!);
  }
  return md.replace(/\[\^([^\]]+)\](?!:)/g, (ref, id: string) => (definitions.has(id) ? ref : `\\[\\^${id}\\]`));
}

function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function formatRow(cells: string[], width: number): string {
  const capped = cells.length > width ? [...cells.slice(0, width - 1), cells.slice(width - 1).join(" | ")] : cells;
  while (capped.length < width) capped.push("");
  return `| ${capped.join(" | ")} |`;
}

function flattenDeepNesting(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*(?:>\s*){17,})(.*)$/);
      return match ? `${"> ".repeat(16)}${match[2]}` : line;
    })
    .join("\n");
}

function enforceRichLimit(md: string): string {
  const limit = RICH_MESSAGE_BYTE_LIMIT;
  if (Buffer.byteLength(md, "utf8") <= limit) return md;
  const bytes = Buffer.from(md, "utf8");
  let end = limit - 32;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + "\n\n[truncated]";
}
