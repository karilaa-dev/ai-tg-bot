import { useContext, type CSSProperties, type ReactNode } from "react";
import { Text } from "@cloudflare/kumo";
import { IconAlertTriangle, IconArrowDown, IconCircleCheck, IconExternalLink, IconFlame } from "@tabler/icons-react";
import { defineComponent } from "@openuidev/react-lang";
import type { z } from "zod/v4";
import { OpenUiLinkUrl, UiFlow, UiFlowStep, UiItem, UiItemList, UiLink, UiStat, UiStatGrid, type OpenUiTone } from "../../openui/library.js";
import { AuthenticatedImage } from "./authenticated-image.js";
import { LanguageContext, type OpenUiLanguage } from "./openui-language.js";

type Tone = z.infer<typeof OpenUiTone>;
const toneLabels: Record<OpenUiLanguage, Record<Exclude<Tone, "default">, string>> = {
  en: { issue: "Failure point", warning: "Warning sign", success: "Fix" },
  ru: { issue: "Точка сбоя", warning: "Тревожный сигнал", success: "Исправление" },
};
const toneIcons = { issue: IconFlame, warning: IconAlertTriangle, success: IconCircleCheck } as const;
const toneText = { default: "", issue: "text-kumo-danger", warning: "text-kumo-warning", success: "text-kumo-success" } satisfies Record<Tone, string>;
const toneBox = {
  default: "border-kumo-line bg-kumo-elevated",
  issue: "border-kumo-danger bg-kumo-danger-tint",
  warning: "border-kumo-warning bg-kumo-warning-tint",
  success: "border-kumo-success bg-kumo-success-tint",
} satisfies Record<Tone, string>;

function ToneLabel({ tone }: { tone: Tone }) {
  const language = useContext(LanguageContext);
  if (tone === "default") return null;
  const Icon = toneIcons[tone];
  return <span className={`inline-flex items-center gap-1 text-xs font-medium ${toneText[tone]}`}>
    <Icon size={14} aria-hidden="true" />{toneLabels[language][tone]}
  </span>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm text-kumo-subtle">{children}</p>;
}

const FlowStepComponent = defineComponent({ ...UiFlowStep, component: ({ props }) => <FlowNode {...props} /> });

function FlowNode({ title, detail, tone }: z.infer<typeof UiFlowStep.props>) {
  return <div className={`grid min-w-0 gap-1 rounded-lg border px-4 py-3 ${toneBox[tone]} ${tone === "issue" ? "border-2" : ""}`}>
    <ToneLabel tone={tone} />
    <Text bold>{title}</Text>
    {detail && <p className="m-0 text-sm text-kumo-subtle">{detail}</p>}
  </div>;
}

const FlowComponent = defineComponent({ ...UiFlow, component: ({ props }) => {
  const steps = props.steps.flatMap(step => {
    const parsed = step.typeName === "FlowStep" ? UiFlowStep.props.safeParse(step.props) : undefined;
    return parsed?.success ? [parsed.data] : [];
  });
  return <figure className="m-0 grid min-w-0 gap-3">
    <figcaption><Text as="h4" bold>{props.title}</Text></figcaption>
    <ol className="m-0 grid list-none p-0">{steps.map((step, index) => <li key={index} className="grid min-w-0">
      {index > 0 && <span aria-hidden="true" className={`flex h-7 items-center justify-center ${step.tone === "issue" ? "text-kumo-danger" : "text-kumo-subtle"}`}>
        <IconArrowDown size={16} stroke={step.tone === "issue" ? 2.5 : 1.75} />
      </span>}
      <FlowNode {...step} />
    </li>)}</ol>
    {props.note && <Note>{props.note}</Note>}
  </figure>;
} });

const StatComponent = defineComponent({ ...UiStat, component: ({ props }) => <StatCell {...props} /> });

function StatCell({ value, label, tone }: z.infer<typeof UiStat.props>) {
  const language = useContext(LanguageContext);
  return <div className="grid min-w-0 content-start justify-items-center gap-0.5 px-2 py-2 text-center">
    <span className={`break-words text-xl font-semibold tabular-nums ${toneText[tone]}`}>{value}</span>
    {tone !== "default" && <span className="sr-only">{toneLabels[language][tone]}</span>}
    {label && <span className="text-xs text-kumo-subtle">{label}</span>}
  </div>;
}

const StatGridComponent = defineComponent({ ...UiStatGrid, component: ({ props }) => {
  const stats = props.stats.flatMap(stat => {
    const parsed = stat.typeName === "Stat" ? UiStat.props.safeParse(stat.props) : undefined;
    return parsed?.success ? [parsed.data] : [];
  });
  const columns = stats.length <= 4 ? stats.length : stats.length % 3 === 0 && stats.length < 12 ? 3 : 4;
  const narrow = columns % 2 === 0 ? 2 : Math.min(columns, 3);
  return <figure className="m-0 grid min-w-0 gap-2 rounded-lg border border-kumo-line px-4 py-3">
    <figcaption className="text-sm font-medium text-kumo-subtle">{props.title}</figcaption>
    <ul className="m-0 grid list-none grid-cols-[repeat(var(--stat-narrow),minmax(0,1fr))] gap-1 p-0 sm:grid-cols-[repeat(var(--stat-columns),minmax(0,1fr))]"
      style={{ "--stat-columns": columns, "--stat-narrow": narrow } as CSSProperties}>
      {stats.map((stat, index) => <li key={index} className="min-w-0"><StatCell {...stat} /></li>)}
    </ul>
    {props.note && <p className="m-0 text-xs text-kumo-subtle">{props.note}</p>}
  </figure>;
} });

function SourceLink({ label, url }: z.infer<typeof UiLink.props>) {
  const language = useContext(LanguageContext);
  const parsed = OpenUiLinkUrl.safeParse(url);
  if (!parsed.success) return <span className="text-xs text-kumo-subtle">{label}</span>;
  const target = new URL(parsed.data);
  const host = target.hostname.replace(/^www\./u, "");
  return <a href={target.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={host}
    className="inline-flex max-w-full items-center gap-1 rounded-full bg-kumo-tint px-2 py-0.5 text-xs text-kumo-link no-underline hover:underline focus-visible:outline-2 focus-visible:outline-kumo-focus">
    <span className="truncate">{label}</span>
    {label.toLowerCase() !== host.toLowerCase() && <span className="truncate text-kumo-subtle">· {host}</span>}
    <IconExternalLink size={12} aria-hidden="true" className="shrink-0" />
    <span className="sr-only">{language === "ru" ? "(откроется в новой вкладке)" : "(opens in a new tab)"}</span>
  </a>;
}

const LinkComponent = defineComponent({ ...UiLink, component: ({ props }) => <SourceLink {...props} /> });

function ItemRow({ title, image, meta, description, links }: z.infer<typeof UiItem.props>) {
  const language = useContext(LanguageContext);
  const sources = links.flatMap(link => {
    const parsed = link.typeName === "Link" ? UiLink.props.safeParse(link.props) : undefined;
    return parsed?.success ? [parsed.data] : [];
  });
  return <article className="flex min-w-0 items-start gap-3 py-3">
    {image && <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-kumo-tint sm:size-24">
      <AuthenticatedImage source={image} alt={title} variant="thumbnail" language={language} />
    </div>}
    <div className="grid min-w-0 flex-1 gap-1">
      <p className="m-0 min-w-0">
        <Text as="span" bold>{title}</Text>
        {meta.length > 0 && <span className="text-kumo-subtle">{meta.map(fact => ` · ${fact}`).join("")}</span>}
      </p>
      {description && <p className="m-0 text-sm">{description}</p>}
      {sources.length > 0 && <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0 pt-1">
        {sources.map((source, index) => <li key={index} className="min-w-0 max-w-full"><SourceLink {...source} /></li>)}
      </ul>}
    </div>
  </article>;
}

const ItemFields = UiItem.props.omit({ links: true });
const ItemComponent = defineComponent({ ...UiItem, component: ({ props }) => <ItemRow {...props} /> });

const ItemListComponent = defineComponent({ ...UiItemList, component: ({ props }) => {
  const items = props.items.flatMap(item => {
    const parsed = item.typeName === "Item" ? ItemFields.safeParse(item.props) : undefined;
    return parsed?.success ? [{ ...parsed.data, links: item.props.links }] : [];
  });
  return <section className="grid min-w-0 gap-1" aria-label={props.title}>
    <Text as="h4" bold>{props.title}</Text>
    <ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
      {items.map((item, index) => <li key={index} className="min-w-0"><ItemRow {...item} /></li>)}
    </ul>
  </section>;
} });

export const visualComponents = [FlowComponent, FlowStepComponent, StatGridComponent, StatComponent, ItemListComponent, ItemComponent, LinkComponent];
