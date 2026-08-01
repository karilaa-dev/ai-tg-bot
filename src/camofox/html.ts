import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlParentNode = DefaultTreeAdapterMap["parentNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];

const ACTIVE_HTML_ELEMENTS = new Set([
  "applet",
  "base",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "object",
  "script",
]);
const RESOURCE_URL_ATTRIBUTES = new Set([
  "action",
  "archive",
  "background",
  "cite",
  "codebase",
  "data",
  "formaction",
  "href",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "usemap",
  "xlink:href",
]);
const SAFE_INLINE_RESOURCE_PATTERN = /^(?:#[^\s]*|data:image\/(?:avif|gif|jpeg|png|webp)(?:;[^,]*)?,)/i;

export function sanitizeOfficeHtml(html: string): string {
  const document = parse(html);
  sanitizeChildren(document);
  return serialize(document);
}

function sanitizeChildren(parent: HtmlParentNode): void {
  for (const child of [...parent.childNodes]) {
    if (!isHtmlElement(child)) continue;
    if (isActiveElement(child)) {
      parent.childNodes.splice(parent.childNodes.indexOf(child), 1);
      continue;
    }
    child.attrs = child.attrs.filter((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "srcset" || name === "imagesrcset") return false;
      if (name === "style" && containsCssResourceLoad(attribute.value)) return false;
      return !RESOURCE_URL_ATTRIBUTES.has(name) || isSafeInlineResource(attribute.value);
    });
    sanitizeChildren(child);
    if ("content" in child) sanitizeChildren(child.content);
  }
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function isActiveElement(element: HtmlElement): boolean {
  if (ACTIVE_HTML_ELEMENTS.has(element.tagName)) return true;
  if (element.tagName === "style") {
    return element.childNodes.some((child) =>
      "value" in child && containsCssResourceLoad(child.value)
    );
  }
  if (element.tagName !== "meta") return false;
  return element.attrs.some((attribute) =>
    attribute.name.toLowerCase() === "http-equiv" && attribute.value.trim().toLowerCase() === "refresh"
  );
}

function isSafeInlineResource(value: string): boolean {
  return SAFE_INLINE_RESOURCE_PATTERN.test(value.trim());
}

function containsCssResourceLoad(css: string): boolean {
  const normalized = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6}\s?|[\s\S])/gi, (_match, escaped: string) => {
      const hex = escaped.trim();
      if (/^[0-9a-f]+$/i.test(hex)) {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10_FFFF ? String.fromCodePoint(codePoint) : "\uFFFD";
      }
      return escaped;
    });
  return /@import\b|url\s*\(/i.test(normalized);
}
