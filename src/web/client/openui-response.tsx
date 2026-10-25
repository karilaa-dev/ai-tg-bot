import { Component, createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Button, LayerCard, Table, Text } from "@cloudflare/kumo";
import { createLibrary, defineComponent, Renderer } from "@openuidev/react-lang";
import { OpenUiActionText, UiBarChart, UiButton, UiCard, UiGrid, UiImage, UiMetric, UiStack, UiSteps, UiTable, UiText } from "../../openui/library.js";
import { safeOpenUi } from "../../openui/validate.js";
import { AuthenticatedImage, ImageProvider, type OpenUiImageSource } from "./authenticated-image.js";
import { LanguageContext, type OpenUiLanguage } from "./openui-language.js";
import { visualComponents } from "./openui-visuals.js";

const ActionContext = createContext<((text: string) => void) | undefined>(undefined);
const TextComponent = defineComponent({ ...UiText, component: ({ props }) => <Text as="p">{props.content}</Text> });
const ButtonComponent = defineComponent({ ...UiButton, component: function FollowUp({ props }) {
  const onAction = useContext(ActionContext);
  return <Button type="button" variant="secondary" disabled={!onAction} onClick={() => {
    const message = OpenUiActionText.safeParse(props.message);
    if (message.success) onAction?.(message.data);
  }}>{props.label}</Button>;
} });
const TableComponent = defineComponent({ ...UiTable, component: ({ props }) => (
  <div className="max-w-full overflow-x-auto">
    <Table>
      <caption className="mb-2 text-left text-sm font-medium">{props.caption}</caption>
      <Table.Header><Table.Row>{props.columns.map((column, index) => <Table.Head key={index}>{column}</Table.Head>)}</Table.Row></Table.Header>
      <Table.Body>{props.rows.map((row, index) => <Table.Row key={index}>{row.map((cell, cellIndex) => <Table.Cell key={cellIndex}>{cell}</Table.Cell>)}</Table.Row>)}</Table.Body>
    </Table>
  </div>
) });
const ImageComponent = defineComponent({ ...UiImage, component: function Picture({ props }) {
  return <AuthenticatedImage {...props} language={useContext(LanguageContext)} />;
} });
const MetricComponent = defineComponent({ ...UiMetric, component: ({ props }) => (
  <dl className="m-0 grid min-w-0 content-start gap-1.5 rounded-lg bg-kumo-tint px-4 py-3">
    <dt className="text-sm text-kumo-subtle">{props.label}</dt>
    <dd className="m-0 break-words text-2xl font-semibold tabular-nums">{props.value}</dd>
    {props.detail && <dd className="m-0 text-sm text-kumo-subtle">{props.detail}</dd>}
  </dl>
) });
const BarChartComponent = defineComponent({ ...UiBarChart, component: ({ props }) => {
  const values = props.values.map(Number);
  const max = Math.max(...values);
  return <figure className="m-0 grid min-w-0 gap-3">
    <figcaption className="text-sm font-medium">{props.title}</figcaption>
    <ul className="m-0 grid list-none gap-3 p-0">{props.labels.map((label, index) => <li key={index} className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm"><span>{label}</span><span className="font-medium tabular-nums">{props.values[index]}{props.unit ? ` ${props.unit}` : ""}</span></div>
      <div aria-hidden="true" className="h-3 overflow-hidden rounded-full bg-kumo-tint"><div className="h-full rounded-full bg-kumo-brand" style={{ width: `${max > 0 ? values[index] / max * 100 : 0}%` }} /></div>
    </li>)}</ul>
  </figure>;
} });
const StepsComponent = defineComponent({ ...UiSteps, component: ({ props }) => (
  <section className="grid min-w-0 gap-3" aria-label={props.title}>
    <Text as="h4" bold>{props.title}</Text>
    <ol className="m-0 grid list-none gap-4 p-0">{props.titles.map((title, index) => <li key={index} className="flex min-w-0 items-start gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-sm font-medium tabular-nums" aria-hidden="true">{index + 1}</span>
      <div className="grid min-w-0 gap-1"><Text bold>{title}</Text>{props.descriptions[index] && <Text as="p" variant="secondary">{props.descriptions[index]}</Text>}</div>
    </li>)}</ol>
  </section>
) });
const CardComponent = defineComponent({ ...UiCard, component: ({ props, renderNode }) => (
  <LayerCard className="min-w-0 px-5 py-4">
    <div className="grid gap-3"><Text as="h3" variant="heading">{props.title}</Text>{renderNode(props.children)}</div>
  </LayerCard>
) });
const StackComponent = defineComponent({ ...UiStack, component: ({ props, renderNode }) => <div className="grid min-w-0 gap-4">{renderNode(props.children)}</div> });
const GridComponent = defineComponent({ ...UiGrid, component: ({ props, renderNode }) => <div className="grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" }}>{renderNode(props.children)}</div> });

const library = createLibrary({ components: [StackComponent, CardComponent, TextComponent, TableComponent, ButtonComponent, ImageComponent, MetricComponent, BarChartComponent, StepsComponent, GridComponent, ...visualComponents], root: "Stack" });

interface GenerativeResponseProps { source: string; onAction?: (text: string) => void; imageSource?: OpenUiImageSource; language?: OpenUiLanguage; onImagesRendered?: (ids: ReadonlySet<number>) => void }

/** The message's accessible text fallback lives outside this optional renderer. */
export function GenerativeResponse({ source, onAction, imageSource, language = "en", onImagesRendered }: GenerativeResponseProps) {
  const validated = useMemo(() => safeOpenUi(source), [source]);
  if (!validated) return null;
  return <RenderBoundary key={`${imageSource?.threadId ?? ""}:${validated}`}><LanguageContext.Provider value={language}>
    <ImageProvider imageSource={imageSource} onImagesRendered={onImagesRendered}><ValidatedResponse source={validated} onAction={onAction} /></ImageProvider>
  </LanguageContext.Provider></RenderBoundary>;
}

function ValidatedResponse({ source, onAction }: { source: string; onAction?: (text: string) => void }) {
  const [failed, setFailed] = useState(false);
  const language = useContext(LanguageContext);
  if (failed) return null;
  return <ActionContext.Provider value={onAction}>
    <div className="my-3 min-w-0 break-words text-sm" aria-label={language === "ru" ? "Интерактивный ответ" : "Interactive response"}>
      <Renderer response={source} library={library} isStreaming={false} toolProvider={null} publishObservability={false}
        onError={errors => { if (errors.length) setFailed(true); }} />
    </div>
  </ActionContext.Provider>;
}

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}
