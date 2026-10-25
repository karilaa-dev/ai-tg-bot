import { createLibrary, defineComponent, generateSystemPrompt, type PromptOptions } from "@openuidev/lang-core";
import { z } from "zod/v4";

export const OPENUI_MAX_SOURCE_CHARS = 24_000;
export const OpenUiActionText = z.string().trim().min(1).max(2_000);
export const OpenUiImageSource = z.string().regex(/^file:[1-9]\d{0,15}$/u).refine(value => Number.isSafeInteger(Number(value.slice(5))), "Use an existing chat file ID.");
const label = z.string().trim().min(1).max(200);
const chartValue = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/u);

export const UiText = defineComponent({
  name: "Text", description: "Plain text, rendered literally. Use for explanations and summaries.",
  props: z.object({ content: z.string().min(1).max(8_000) }), component: null,
});
export const UiButton = defineComponent({
  name: "Button", description: "Send the action text as a normal user chat message when clicked. No navigation or automatic actions.",
  props: z.object({ label: z.string().trim().min(1).max(120), message: OpenUiActionText }), component: null,
});
export const UiTable = defineComponent({
  name: "Table", description: "A small accessible data table. Each row must have exactly one plain string per column.",
  props: z.object({
    caption: z.string().trim().min(1).max(200),
    columns: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
    rows: z.array(z.array(z.string().max(1_000)).min(1).max(8)).max(40),
  }), component: null,
});
export const UiImage = defineComponent({
  name: "Image", description: "A picture from an existing chat file, using file:ID (not a URL or path). Supply meaningful alt text and a caption; the viewer loads it privately through the authenticated attachment endpoint.",
  props: z.object({ source: OpenUiImageSource, alt: z.string().trim().min(1).max(1_000), caption: z.string().max(1_000) }), component: null,
});
export const UiMetric = defineComponent({
  name: "Metric", description: "A prominent key fact or number with its unit in value and explanatory context in detail. Use real supported values.",
  props: z.object({ label, value: z.string().trim().min(1).max(120), detail: z.string().max(500) }), component: null,
});
export const UiBarChart = defineComponent({
  name: "BarChart", description: "Compare non-negative quantities with horizontal bars starting at zero. Provide matching labels and decimal strings in values, and the shared unit. Use Table for signed values or exact comparisons.",
  props: z.object({ title: label, labels: z.array(label).min(1).max(12), values: z.array(chartValue).min(1).max(12), unit: z.string().max(80) }), component: null,
});
export const UiSteps = defineComponent({
  name: "Steps", description: "A numbered process, itinerary or timeline. Each title has a matching description; include dates/times in titles when useful.",
  props: z.object({ title: label, titles: z.array(label).min(1).max(10), descriptions: z.array(z.string().max(1_000)).min(1).max(10) }), component: null,
});
export const OpenUiTone = z.enum(["default", "issue", "warning", "success"]);
export const OpenUiLinkUrl = z.string().max(2_048).refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".");
}, "Use a complete https:// source URL.");
export const UiFlowStep = defineComponent({
  name: "FlowStep", description: "One cause or event in a Flow. tone is \"default\", \"issue\" (the failure or root cause), \"warning\" (a missed signal or risk) or \"success\" (a fix or safe state).",
  props: z.object({ title: label, detail: z.string().max(600), tone: OpenUiTone }), component: null,
});
export const UiFlow = defineComponent({
  name: "Flow", description: "A connected cause-and-effect chain showing how one event led to the next. Mark the step where things went wrong with tone \"issue\". Add a short takeaway in note, or \"\".",
  props: z.object({ title: label, steps: z.array(UiFlowStep.ref).min(2).max(8), note: z.string().max(600) }), component: null,
});
export const UiStat = defineComponent({
  name: "Stat", description: "One compact number or short value in a StatGrid, with an optional short label (or \"\") and a tone.",
  props: z.object({ value: z.string().trim().min(1).max(40), label: z.string().max(120), tone: OpenUiTone }), component: null,
});
export const UiStatGrid = defineComponent({
  name: "StatGrid", description: "A compact panel of several related real values, such as measured figures, scores or the exact numbers being discussed. Use note to explain what they show together, or \"\".",
  props: z.object({ title: label, stats: z.array(UiStat.ref).min(2).max(12), note: z.string().max(600) }), component: null,
});
export const UiLink = defineComponent({
  name: "Link", description: "A source or action link that opens a real, verified https:// page in a new tab. Use the page or site name as label.",
  props: z.object({ label: z.string().trim().min(1).max(80), url: OpenUiLinkUrl }), component: null,
});
export const UiItem = defineComponent({
  name: "Item", description: "One recommended option (place, product, book, tool) in an ItemList: name, thumbnail image as file:ID or \"\", short facts in meta (such as cuisine, price, area), a description of why it is worth considering, and up to 3 Links to its sources or official pages.",
  props: z.object({
    title: label, image: z.union([z.literal(""), OpenUiImageSource]), meta: z.array(z.string().trim().min(1).max(60)).max(4),
    description: z.string().max(800), links: z.array(UiLink.ref).max(3),
  }), component: null,
});
export const UiItemList = defineComponent({
  name: "ItemList", description: "A list of recommendations with optional thumbnails, short facts, descriptions and source links. Use for places to visit, products or other options the user can choose between.",
  props: z.object({ title: label, items: z.array(UiItem.ref).min(1).max(8) }), component: null,
});
const content = z.union([UiText.ref, UiTable.ref, UiButton.ref, UiImage.ref, UiMetric.ref, UiBarChart.ref, UiSteps.ref, UiFlow.ref, UiStatGrid.ref, UiItemList.ref]);
export const UiCard = defineComponent({
  name: "Card", description: "A titled card grouping related text, pictures, metrics, charts, steps or follow-up buttons. Cards cannot nest.",
  props: z.object({
    title: z.string().trim().min(1).max(200),
    children: z.array(content).min(1).max(12),
  }), component: null,
});
export const UiGrid = defineComponent({
  name: "Grid", description: "Responsive side-by-side cards, pictures or metrics; stacks on narrow screens. Only place directly inside Stack; never nest grids.",
  props: z.object({ children: z.array(z.union([UiCard.ref, UiImage.ref, UiMetric.ref])).min(1).max(6) }), component: null,
});
export const UiStack = defineComponent({
  name: "Stack", description: "The root vertical layout of useful visuals and supporting text.",
  props: z.object({ children: z.array(z.union([UiCard.ref, UiGrid.ref, content])).min(1).max(12) }),
  component: null,
});

export const openUiComponents = { Stack: UiStack, Card: UiCard, Text: UiText, Table: UiTable, Button: UiButton, Image: UiImage, Metric: UiMetric, BarChart: UiBarChart, Steps: UiSteps, Grid: UiGrid,
  Flow: UiFlow, FlowStep: UiFlowStep, StatGrid: UiStatGrid, Stat: UiStat, ItemList: UiItemList, Item: UiItem, Link: UiLink };
export const openUiLibrary = createLibrary({
  components: Object.values(openUiComponents), root: "Stack",
  componentGroups: [
    { name: "Layout", components: ["Stack", "Grid", "Card", "Text"] },
    { name: "Pictures and data", components: ["Image", "Metric", "StatGrid", "Stat", "BarChart", "Table", "Steps"] },
    { name: "Explanations", components: ["Flow", "FlowStep"] },
    { name: "Recommendations", components: ["ItemList", "Item", "Link"] },
    { name: "Follow-up", components: ["Button"] },
  ],
});

export const openUiExamples = [
  'root = Stack([chain, evidence])\nchain = Flow("How one expired certificate caused an outage", [FlowStep("Certificate expires", "The automatic renewal failed, leaving the service with an expired certificate.", "issue"), FlowStep("Clients reject the connection", "The certificate check fails before clients can send a request.", "warning"), FlowStep("Renewal restores access", "A valid certificate lets the same clients connect again.", "success")], "The failed renewal caused the outage; the application itself was still running.")\nevidence = StatGrid("Observed impact", [Stat("12 min", "Connection failures", "issue"), Stat("0", "Lost records", "default")], "Use only measurements established by the investigation.")',
  'root = Stack([picks, next])\npicks = ItemList("Two different evenings", [Item("Example dumpling kitchen", "file:123", ["Dumplings", "Casual", "Near the station"], "A good fit for a quick shared meal; the photograph shows the dining room.", [Link("Restaurant website", "https://example.com/dumplings")]), Item("Example garden restaurant", "file:124", ["Seasonal menu", "Reservations"], "A quieter option for a longer dinner; the photograph shows its garden terrace.", [Link("Restaurant website", "https://example.org/garden")])])\nnext = Button("Compare vegetarian options", "Compare the vegetarian options at these restaurants.")',
  'root = Stack([chart, next])\nchart = BarChart("Walking distance", ["Valley", "Ridge"], ["9", "14"], "km")\nnext = Button("Compare the climbs", "Compare the elevation gain of these routes.")',
];

export const openUiPromptOptions = {
  preamble: "The following OpenUI language and output rules apply ONLY to the string in finish_response.openui, never to ordinary assistant text or the normal tool workflow.",
  toolCalls: false, bindings: false, builtinFunctions: false, editMode: false, inlineMode: false,
  additionalRules: [
    "Use one complete assignment per line, with root = Stack([...]). Use JSON double-quoted strings, static arrays, components, and named references only; all arguments are required, in the documented order.",
    "No expressions, reactive variables, functions, Query, Mutation, Action, HTML, CSS, SVG markup, executable URL actions or scripts. Despite the general language reference below, only strings, static arrays, named component references and component calls are accepted; no number/boolean/null literals or objects. Buttons only submit plain chat messages when clicked. Link is the sole navigation component: use a verified public https source or place page, never invent a URL or include credentials or private tokens.",
    "No markdown fences. At most 64 statements, 12 root items, 12 items per card, 6 grid items, 12 images including Item thumbnails, 8 table columns and 40 rows. FlowStep belongs only inside Flow, Stat only inside StatGrid, Item only inside ItemList, and Link only inside Item. Every named statement must be reachable from root; no cycles.",
    "Image source and nonempty Item image MUST be file: followed by a real file ID already returned by tools or listed in this thread's context. Never invent file IDs, copy example IDs unless they actually exist, or use remote URLs, API paths, data URLs or sandbox paths. Reuse relevant existing images when available. For retrieved or generated pictures saved in the workspace, call create_file BEFORE finish_response and use its returned file_id; keep the image attached. generate_image saves paths, not chat file IDs, and still requires the user's explicit synthesis/editing intent under the normal image rules. For web-sourced pictures, retrieve a suitable real image, inspect it and attach it first. An Item without a verified suitable picture uses image \"\". Never show the same photo in both an Image gallery and an Item thumbnail in one answer.",
    "BarChart values are quoted non-negative decimal strings (up to 12 integer and 6 fractional digits), with exactly one value per label. Steps titles and descriptions must have equal lengths. Table rows must match columns. Include units and avoid invented quantities; use a table when a bar chart would mislead.",
    "Compose text and UI as one website answer. Use text for the introduction, conclusions and essential qualifications; let the visualization carry structured detail, source links and image descriptions without repeating them as a second prose list. Do not duplicate visual content merely for Telegram compatibility. Keep a short meaningful answer in text so the conclusion remains readable if the visualization cannot render. All labels, captions and button messages must follow the language of the AI response, not the account or website language. Set finish_response.openui_language to en or ru to match the answer. The UI is rendered only after successful finish_response, never while streaming. Examples below are fictional syntax demonstrations, not factual evidence; use the actual facts, links and files from the current task.",
  ],
  examples: openUiExamples,
} satisfies PromptOptions;

const generatedInstructions = generateSystemPrompt({ library: openUiLibrary.toSpec(), promptOptions: openUiPromptOptions });

export function openUiInstructions(): string {
  return [
    "This thread was created on the website; its creation origin is immutable, even when a later message arrives through Telegram. Proactively compose useful OpenUI when the answer benefits from a visual explanation or visual choices. Do not wait for the user to request a visualization. Before choosing components, identify what the reader should SEE: a causal connection, a meaningful magnitude, a comparison, or the appearance of an option. A numbered list restyled as Steps is not a visualization. Omit OpenUI for ordinary lists, acknowledgments and short factual answers when it adds no information or useful interaction.",
    "For explanations of how or why something happened, use Flow to connect causes to consequences. Put the causal mechanism in each step, and mark the actual failure point with tone issue and any evidenced missed warning with warning. Use StatGrid to reveal significant real values together, with a note explaining what their pattern or scale means. Do not convert every paragraph or numbered heading into a card or FlowStep. Use BarChart for quantities on a meaningful common scale and Table for precise multi-attribute comparisons. Combine only complementary visuals; do not restate the same data in several components.",
    "For restaurant, travel, product and other recommendations, prefer ItemList rows with recognizable photographs, concise distinguishing facts in meta, why each option fits, and verified official/source links. Proactively find, inspect and attach a small set of relevant real photos when they materially help the choice; do not wait for a separate request for pictures. Prefer genuine location-specific photos over brand or stock photos; label uncertainty, source and age where relevant. Include a verified place/map link when useful, without inventing addresses, coordinates, ratings, prices, opening hours or availability. If photos cannot be verified, omit thumbnails and still present useful choices. For a direct request for pictures, use a captioned Image grid. Follow-up buttons should offer a specific useful next question, not generic filler.",
    "Prioritize the website experience in this web-created thread. UI must ONLY be sent in the openui string argument of finish_response, with accompanying narrative in text. Telegram is a secondary record: it receives the text, important attached images/files and a placeholder linking to the website visualization. Do not flatten or duplicate a rich website answer to make it look complete in Telegram. Never emit UI source in ordinary assistant text, reasoning, captions or files. Keep referenced photos attached for durable storage; the website displays them in the visualization without extra file rows below it.",
    generatedInstructions,
    "Finish by calling finish_response with text and optional openui plus openui_language. The UI syntax rules above do not replace the normal tool workflow. Answer in the conversation's requested language even when the account settings use another language.",
  ].join("\n\n");
}
