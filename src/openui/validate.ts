import { createParser, parseExpression, tokenize, type ASTNode, type ElementNode } from "@openuidev/lang-core";
import { z } from "zod/v4";
import { OPENUI_MAX_SOURCE_CHARS, openUiComponents, openUiLibrary, UiBarChart, UiButton, UiCard, UiFlow, UiFlowStep, UiGrid, UiImage, UiItem, UiItemList, UiLink, UiMetric, UiStack, UiStat, UiStatGrid, UiSteps, UiTable, UiText } from "./library.js";

const parser = createParser(openUiLibrary.toJSONSchema(), "Stack");
const MAX_NODES = 200;
const MAX_DEPTH = 12;
const ComponentName = z.enum(["Stack", "Card", "Text", "Table", "Button", "Image", "Metric", "BarChart", "Steps", "Grid", "Flow", "FlowStep", "StatGrid", "Stat", "ItemList", "Item", "Link"]);
const Element = z.object({ type: z.literal("element"), typeName: ComponentName, props: z.record(z.string(), z.unknown()), partial: z.literal(false) });
const Children = z.array(Element).min(1).max(12);
const CardProps = UiCard.props.omit({ children: true }).extend({ children: Children });
const StackProps = UiStack.props.omit({ children: true }).extend({ children: Children });
const GridProps = UiGrid.props.omit({ children: true }).extend({ children: Children.max(6) });
const FlowProps = UiFlow.props.omit({ steps: true }).extend({ steps: Children.min(2).max(8) });
const StatGridProps = UiStatGrid.props.omit({ stats: true }).extend({ stats: Children.min(2) });
const ItemListProps = UiItemList.props.omit({ items: true }).extend({ items: Children.max(8) });
const ItemProps = UiItem.props.omit({ links: true }).extend({ links: z.array(Element).max(3) });

/** Validate the static subset before the SDK resolves references or evaluates anything. */
export function validateOpenUi(source: string): string {
  return inspectOpenUi(source).source;
}

export function inspectOpenUi(source: string): { source: string; fileIds: string[] } {
  if (!source.trim() || source.length > OPENUI_MAX_SOURCE_CHARS) throw new Error("OpenUI source is empty or too large.");
  const lines = source.trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length > 64) throw new Error("OpenUI has too many statements.");
  const statements = new Map<string, ASTNode>();
  const canonical: string[] = [];
  let syntaxNodes = 0;
  for (const line of lines) {
    const match = /^([a-z][a-zA-Z0-9_]{0,63})\s*=\s*(.+)$/u.exec(line);
    if (!match) throw new Error("Use one complete OpenUI assignment per line.");
    const [, id = "", expression = ""] = match;
    if (Object.hasOwn(Object.prototype, id)) throw new Error("Reserved OpenUI statement name.");
    if (statements.has(id)) throw new Error("OpenUI statement names must be unique.");
    // JSON strings are opaque data. Outside them only the static grammar is admitted.
    const syntax = expression.replace(/"(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/gu, "");
    if (!/^[a-zA-Z0-9_,()[\]\s]*$/u.test(syntax)) throw new Error("OpenUI supports only static components and strings.");
    const brackets: string[] = [];
    for (const character of syntax) {
      if (character === "(" || character === "[") brackets.push(character);
      if (brackets.length > MAX_DEPTH) throw new Error("OpenUI nesting is too deep.");
      if (character === ")" || character === "]") {
        if (brackets.pop() !== (character === ")" ? "(" : "[")) throw new Error("OpenUI has unbalanced brackets.");
      }
    }
    if (brackets.length) throw new Error("OpenUI is incomplete.");
    const tokens = tokenize(expression);
    const ast = parseExpression(tokens);
    if (ast.k !== "Comp") throw new Error("Every OpenUI statement must define a component.");
    const render = (node: ASTNode): string => {
      if (++syntaxNodes > 2_000) throw new Error("OpenUI is too complex.");
      switch (node.k) {
        case "Str": return JSON.stringify(node.v);
        case "Ref": return node.n;
        case "Arr": return `[${node.els.map(render).join(",")}]`;
        case "Comp": {
          const name = ComponentName.safeParse(node.name);
          if (node.fn || !name.success) throw new Error("Unsupported OpenUI component.");
          if (node.args.length !== Object.keys(openUiComponents[name.data].props.shape).length) throw new Error("OpenUI component arguments must match its signature.");
          return `${node.name}(${node.args.map(render).join(",")})`;
        }
        default: throw new Error("OpenUI expressions and executable actions are not supported.");
      }
    };
    const normalized = render(ast);
    // The permissive SDK parser may ignore trailing/incomplete syntax; require a full round trip.
    if (JSON.stringify(tokenize(normalized)) !== JSON.stringify(tokens)) throw new Error("Malformed OpenUI expression.");
    statements.set(id, ast);
    canonical.push(`${id} = ${normalized}`);
  }
  const root = statements.get("root");
  if (root?.k !== "Comp" || root.name !== "Stack") throw new Error("OpenUI root must be Stack.");
  let expandedNodes = 0;
  const reached = new Set(["root"]);
  const visit = (node: ASTNode, path: Set<string>, depth: number): void => {
    if (++expandedNodes > 2_000 || depth > MAX_DEPTH) throw new Error("OpenUI expansion is too large.");
    if (node.k === "Ref") {
      const target = statements.get(node.n);
      if (!target || path.has(node.n)) throw new Error("OpenUI has a missing or cyclic reference.");
      reached.add(node.n);
      visit(target, new Set([...path, node.n]), depth + 1);
    } else if (node.k === "Comp") {
      node.args.forEach(child => visit(child, path, depth + 1));
    } else if (node.k === "Arr") {
      node.els.forEach(child => visit(child, path, depth + 1));
    }
  };
  visit(root, new Set(["root"]), 0);
  if (reached.size !== statements.size) throw new Error("OpenUI contains unused statements.");
  const normalized = canonical.join("\n");
  const parsed = parser.parse(normalized);
  if (!parsed.root || parsed.meta.incomplete || parsed.meta.errors.length || parsed.meta.unresolved.length
    || parsed.rootExpression || parsed.queryStatements.length || parsed.mutationStatements.length
    || Object.keys(parsed.stateDeclarations).length) throw new Error("OpenUI does not match the component library.");
  return { source: normalized, fileIds: validateTree(parsed.root) };
}

function validateTree(root: ElementNode): string[] {
  type Name = z.infer<typeof ComponentName>;
  const pending: { value: unknown; parent?: Name }[] = [{ value: root }];
  let nodes = 0;
  let images = 0;
  const fileIds = new Set<string>();
  const countImage = (source: string) => {
    if (++images > 12) throw new Error("OpenUI has too many images.");
    fileIds.add(source.slice(5));
  };
  while (pending.length) {
    if (++nodes > MAX_NODES) throw new Error("OpenUI has too many components.");
    const entry = pending.pop()!;
    const node = Element.parse(entry.value);
    const push = (children: z.infer<typeof Element>[], required?: Name) => {
      if (required && children.some(child => child.typeName !== required)) throw new Error(`OpenUI ${node.typeName} accepts only ${required} children.`);
      pending.push(...children.map(value => ({ value, parent: node.typeName })));
    };
    const requireParent = (parent: Name) => {
      if (entry.parent !== parent) throw new Error(`OpenUI ${node.typeName} must be inside ${parent}.`);
    };
    switch (node.typeName) {
      case "Text": UiText.props.parse(node.props); break;
      case "Button": UiButton.props.parse(node.props); break;
      case "Image":
        countImage(UiImage.props.parse(node.props).source);
        break;
      case "Flow": push(FlowProps.parse(node.props).steps, "FlowStep"); break;
      case "FlowStep": requireParent("Flow"); UiFlowStep.props.parse(node.props); break;
      case "StatGrid": push(StatGridProps.parse(node.props).stats, "Stat"); break;
      case "Stat": requireParent("StatGrid"); UiStat.props.parse(node.props); break;
      case "ItemList": push(ItemListProps.parse(node.props).items, "Item"); break;
      case "Item": {
        requireParent("ItemList");
        const props = ItemProps.parse(node.props);
        if (props.image) countImage(props.image);
        push(props.links, "Link");
        break;
      }
      case "Link": requireParent("Item"); UiLink.props.parse(node.props); break;
      case "Metric": UiMetric.props.parse(node.props); break;
      case "BarChart": {
        const props = UiBarChart.props.parse(node.props);
        if (props.labels.length !== props.values.length) throw new Error("OpenUI chart values must match labels.");
        break;
      }
      case "Steps": {
        const props = UiSteps.props.parse(node.props);
        if (props.titles.length !== props.descriptions.length) throw new Error("OpenUI step descriptions must match titles.");
        break;
      }
      case "Table": {
        const props = UiTable.props.parse(node.props);
        if (props.rows.some(row => row.length !== props.columns.length)) throw new Error("OpenUI table rows must match the columns.");
        break;
      }
      case "Card": {
        const props = CardProps.parse(node.props);
        if (props.children.some(child => child.typeName === "Stack" || child.typeName === "Card" || child.typeName === "Grid")) throw new Error("OpenUI cards cannot contain layout containers.");
        push(props.children);
        break;
      }
      case "Grid": {
        const props = GridProps.parse(node.props);
        if (props.children.some(child => child.typeName !== "Card" && child.typeName !== "Image" && child.typeName !== "Metric")) throw new Error("OpenUI grids contain only cards, images or metrics.");
        push(props.children);
        break;
      }
      case "Stack": {
        if (nodes !== 1) throw new Error("OpenUI Stack is only allowed at the root.");
        const props = StackProps.parse(node.props);
        if (props.children.some(child => child.typeName === "Stack")) throw new Error("OpenUI stacks cannot nest.");
        push(props.children);
        break;
      }
      default: {
        const exhaustive: never = node.typeName;
        throw new Error(`Unsupported OpenUI component: ${exhaustive}`);
      }
    }
  }
  return [...fileIds];
}

export function safeOpenUi(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  try { return validateOpenUi(source); } catch { return undefined; }
}
