import { Loader } from "@cloudflare/kumo/components/loader";
import {
  IconArrowsVertical, IconBrain, IconBrowser, IconCamera, IconChevronRight, IconClick, IconCode, IconDownload, IconFileCheck,
  IconFileDescription, IconFilePlus, IconFileSearch, IconFileText, IconKeyboard, IconMessageSearch, IconMicrophone, IconPaperclip,
  IconPencil, IconPhoto, IconTerminal2, IconTool, IconWorldSearch, IconWorldUpload, IconWorldWww, type Icon,
} from "@tabler/icons-react";
import { useEffect, useId, useState } from "react";
import type { ToolActivity, ToolCallDetail, ToolPayload } from "../../ai/toolActivity.js";
import type { WebThreadActivity } from "../types.js";
import { CodeBlock } from "./components/ui/code-block.js";
import { RichText } from "./rich-text.js";
import "./tool-details.css";

type Language = "en" | "ru";
const labels = {
  en: {
    region: "Thinking and tool details", args: "Arguments", result: "Result", unavailable: "No details recorded", truncated: "Showing a shortened result",
    omitted: "Additional calls omitted", succeeded: "Completed", error: "Failed", cancelled: "Cancelled", running: "Running", command: "Command",
    stdout: "Output", stderr: "Error output", details: "Details", seconds: "s", ms: "ms",
    thoughts: "Thoughts", thinkingNow: "Thinking", queued: "Waiting to start", finishing: "Finishing up", stopping: "Stopping", interrupted: "Interrupted",
    thoughtFor: (time: string) => `Thought for ${time}`, workedFor: (time: string) => `Worked for ${time}`, answeredIn: (time: string) => `Answered in ${time}`,
    stopped: "Stopped", stoppedAfter: (time: string) => `Stopped after ${time}`, queuedAhead: (count: number) => `${count} ahead`,
  },
  ru: {
    region: "Рассуждения и инструменты", args: "Аргументы", result: "Результат", unavailable: "Подробности не сохранены", truncated: "Показан сокращённый результат",
    omitted: "Другие вызовы не показаны", succeeded: "Выполнено", error: "Ошибка", cancelled: "Отменено", running: "Выполняется", command: "Команда",
    stdout: "Вывод", stderr: "Вывод ошибок", details: "Подробности", seconds: "с", ms: "мс",
    thoughts: "Рассуждения", thinkingNow: "Думаю", queued: "Ожидает очереди", finishing: "Завершаю", stopping: "Останавливаю", interrupted: "Прервано",
    thoughtFor: (time: string) => `Обдумано за ${time}`, workedFor: (time: string) => `Готово за ${time}`, answeredIn: (time: string) => `Ответ за ${time}`,
    stopped: "Остановлено", stoppedAfter: (time: string) => `Остановлено через ${time}`, queuedAhead: (count: number) => `впереди: ${count}`,
  },
};

const toolNames: Record<string, Record<Language, string>> = {
  web_search: { en: "Search the web", ru: "Поиск в интернете" },
  web_extract: { en: "Read a web page", ru: "Чтение веб-страницы" },
  bash: { en: "Run a command", ru: "Выполнение команды" },
  codemode: { en: "Run a script", ru: "Выполнение скрипта" },
  read: { en: "Read a file", ru: "Чтение файла" },
  write: { en: "Write a file", ru: "Запись файла" },
  edit: { en: "Edit a file", ru: "Изменение файла" },
  tool_search: { en: "Find tools", ru: "Поиск инструментов" },
  memo: { en: "Use memory", ru: "Работа с памятью" },
  search_thread: { en: "Search this chat", ru: "Поиск по чату" },
  load_message: { en: "Open an earlier message", ru: "Открытие сообщения" },
  search_in_file: { en: "Search a file", ru: "Поиск в файле" },
  read_file_section: { en: "Read part of a file", ru: "Чтение части файла" },
  materialize_chat_files: { en: "Prepare chat files", ru: "Подготовка файлов из чата" },
  render_pdf_pages: { en: "Preview PDF pages", ru: "Просмотр страниц PDF" },
  render_office_preview: { en: "Preview a document", ru: "Предпросмотр документа" },
  validate_office_file: { en: "Check a document", ru: "Проверка документа" },
  inspect_workspace_images: { en: "Look at images", ru: "Просмотр изображений" },
  create_file: { en: "Create a file", ru: "Создание файла" },
  publish_website: { en: "Publish a website", ru: "Публикация сайта" },
  transcribe_audio: { en: "Transcribe audio", ru: "Расшифровка аудио" },
  generate_image: { en: "Generate an image", ru: "Создание изображения" },
  browser_open: { en: "Open a browser tab", ru: "Открытие вкладки браузера" },
  browser_list_tabs: { en: "List browser tabs", ru: "Список вкладок браузера" },
  browser_navigate: { en: "Go to a page", ru: "Переход на страницу" },
  browser_snapshot: { en: "Read the page", ru: "Чтение страницы" },
  browser_click: { en: "Click on the page", ru: "Нажатие на странице" },
  browser_type: { en: "Type on the page", ru: "Ввод текста на странице" },
  browser_press: { en: "Press a key", ru: "Нажатие клавиши" },
  browser_scroll: { en: "Scroll the page", ru: "Прокрутка страницы" },
  browser_screenshot: { en: "Take a screenshot", ru: "Снимок экрана" },
  browser_list_downloads: { en: "List downloads", ru: "Список загрузок" },
  browser_send_file: { en: "Send a downloaded file", ru: "Отправка загруженного файла" },
  browser_close_tab: { en: "Close a browser tab", ru: "Закрытие вкладки браузера" },
  browser_extend_session: { en: "Keep the browser open", ru: "Продление сеанса браузера" },
  browser_close_session: { en: "Close the browser", ru: "Закрытие браузера" },
};

/** Readable action names; unknown tools fall back to their identifier in sentence case. */
export function toolLabel(name: string, language: Language): string {
  const known = Object.hasOwn(toolNames, name) ? toolNames[name]?.[language] : undefined;
  if (known) return known;
  const words = name.replace(/[_.:-]+/g, " ").trim();
  return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : name;
}

const toolIcons: Record<string, Icon> = {
  web_search: IconWorldSearch, web_extract: IconWorldWww, bash: IconTerminal2, codemode: IconCode, read: IconFileText, read_file_section: IconFileText,
  write: IconFilePlus, create_file: IconFilePlus, edit: IconPencil, memo: IconBrain, search_thread: IconMessageSearch, load_message: IconMessageSearch,
  search_in_file: IconFileSearch, materialize_chat_files: IconPaperclip, render_pdf_pages: IconFileDescription, render_office_preview: IconFileDescription,
  validate_office_file: IconFileCheck, inspect_workspace_images: IconPhoto, generate_image: IconPhoto, publish_website: IconWorldUpload,
  transcribe_audio: IconMicrophone, browser_click: IconClick, browser_type: IconKeyboard, browser_press: IconKeyboard, browser_screenshot: IconCamera,
  browser_scroll: IconArrowsVertical, browser_list_downloads: IconDownload, browser_send_file: IconDownload,
};
const toolIcon = (name: string): Icon => (Object.hasOwn(toolIcons, name) ? toolIcons[name] : undefined) ?? (name.startsWith("browser_") ? IconBrowser : IconTool);

function callCount(count: number, language: Language): string {
  if (language === "en") return `${count} tool ${count === 1 ? "call" : "calls"}`;
  const suffix = count % 10 === 1 && count % 100 !== 11 ? "вызов инструмента"
    : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? "вызова инструментов" : "вызовов инструментов";
  return `${count} ${suffix}`;
}

/** Whole seconds under a minute, then minutes and seconds: "8s", "1m 12s". */
export function formatElapsed(ms: number, language: Language): string {
  const total = ms > 0 ? Math.max(1, Math.round(ms / 1_000)) : 0;
  const ru = language === "ru";
  if (total < 60) return ru ? `${total} с` : `${total}s`;
  const minutes = Math.floor(total / 60), seconds = total % 60;
  if (minutes < 60) return ru ? `${minutes} мин${seconds ? ` ${seconds} с` : ""}` : `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return ru ? `${hours} ч${rest ? ` ${rest} мин` : ""}` : `${hours}h${rest ? ` ${rest}m` : ""}`;
}

const LEGACY_COUNTERS = /^(?:Tool calls|Вызовы инструментов): (\d+)(?: · (?:Reasoning blocks|Блоков рассуждений): \d+)?(?:\r?\n\r?\n|$)/;

export type ChainStep = { kind: "reasoning"; key: string; text: string } | { kind: "tool"; key: string; call: ToolCallDetail };

/** Reasoning and tool calls in the order they happened. Calls saved before ordering was recorded follow all reasoning. */
export function chainSteps(activity: ToolActivity | undefined, thinking: string | null | undefined): { steps: ChainStep[]; legacyCalls: number } {
  if (activity?.calls.length) {
    const steps: ChainStep[] = [];
    const reasoning = activity.reasoning;
    let used = 0;
    const take = (until: number) => {
      for (; used < Math.min(until, reasoning.length); used++) if (reasoning[used]!.trim()) steps.push({ kind: "reasoning", key: `r${used}`, text: reasoning[used]! });
    };
    for (const call of activity.calls) {
      take(call.reasoningBefore ?? reasoning.length);
      steps.push({ kind: "tool", key: call.id, call });
    }
    take(reasoning.length);
    return { steps, legacyCalls: 0 };
  }
  if (!thinking?.trim()) return { steps: [], legacyCalls: 0 };
  // Older summaries begin with localized counters; their remaining text is one reasoning step.
  const counters = LEGACY_COUNTERS.exec(thinking);
  const content = counters ? thinking.slice(counters[0].length) : thinking;
  return { steps: content.trim() ? [{ kind: "reasoning", key: "r0", text: content }] : [], legacyCalls: counters ? Number(counters[1]) : 0 };
}

/** The first line of a reasoning summary, without Markdown emphasis, as a one-line preview. */
function headline(text: string): string {
  const line = text.trim().split("\n").find(row => row.trim()) ?? "";
  return line.replace(/^#+\s*/, "").replace(/[*_`]+/g, "").trim();
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface LiveChainState {
  state: WebThreadActivity["state"];
  /** When generation started, from the server or when this tab first saw the turn. */
  startedAt: number;
  queuedTurns: number;
}

/**
 * One collapsible line for the assistant's work: "Thought for 12s" when finished, a live
 * "Thinking · 14s" with the current step while generating. Expanding shows reasoning and
 * tool calls as a single chronological chain; each call opens to its arguments and result.
 */
export function ResponseChain({ activity, thinking, language, durationMs = null, stopped = false, live = null, defaultOpen = false }: {
  activity?: ToolActivity;
  thinking?: string | null;
  language: Language;
  durationMs?: number | null;
  stopped?: boolean;
  live?: LiveChainState | null;
  defaultOpen?: boolean;
}) {
  const t = labels[language];
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const ticking = Boolean(live && live.state !== "queued" && live.state !== "interrupted");
  const now = useNow(ticking);
  const { steps, legacyCalls } = chainSteps(activity, thinking);
  const calls = activity?.calls.length ?? 0;
  const omitted = activity?.omittedCalls ?? 0;
  const expandable = steps.length > 0 || omitted > 0;

  let label: string | null;
  let time: string | null = null;
  let preview: string | null = null;
  if (live) {
    const last = steps.at(-1);
    const running = [...steps].reverse().find((step): step is Extract<ChainStep, { kind: "tool" }> => step.kind === "tool" && step.call.status === "running");
    label = live.state === "queued" ? t.queued : live.state === "stopping" ? t.stopping : live.state === "interrupted" ? t.interrupted
      : live.state === "delivering" ? t.finishing : running ? toolLabel(running.call.name, language) : t.thinkingNow;
    if (ticking) time = formatElapsed(Math.max(0, now - live.startedAt), language);
    if (live.state === "queued" && live.queuedTurns > 1) preview = t.queuedAhead(live.queuedTurns - 1);
    else if (live.state === "generating" && !running && last?.kind === "reasoning") preview = headline(last.text) || null;
  } else {
    const elapsed = durationMs !== null && durationMs > 0 ? formatElapsed(durationMs, language) : null;
    label = stopped ? (elapsed ? t.stoppedAfter(elapsed) : t.stopped)
      : calls || legacyCalls ? (elapsed ? t.workedFor(elapsed) : callCount(calls + omitted || legacyCalls, language))
      : steps.length ? (elapsed ? t.thoughtFor(elapsed) : t.thoughts)
      : elapsed ? t.answeredIn(elapsed) : null;
  }
  if (!label) return null;

  const content = <>
    <span className={live && live.state !== "interrupted" ? "chain-label is-live" : "chain-label"}>{label}</span>
    {time && <span className="chain-time">{time}</span>}
    {preview && <span className="chain-preview">{preview}</span>}
  </>;
  return <div className="chain" data-live={live ? live.state : undefined} data-stopped={stopped || undefined}>
    {expandable
      ? <button type="button" className="chain-trigger" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        {content}<IconChevronRight size={14} className="chain-chevron" aria-hidden="true" />
      </button>
      : <p className="chain-trigger is-static">{content}</p>}
    {open && expandable && <div id={panelId} className="chain-panel" role="region" aria-label={t.region}>
      <ol className="chain-steps">
        {steps.map(step => step.kind === "reasoning"
          ? <li key={step.key} className="chain-step" data-kind="reasoning"><span className="chain-marker" aria-hidden="true"><span className="chain-dot" /></span>
            <div className="chain-reasoning"><RichText text={step.text} /></div></li>
          : <li key={step.key} className="chain-step" data-kind="tool"><ToolCall call={step.call} language={language} /></li>)}
      </ol>
      {omitted > 0 && <p className="tool-details-note">{t.omitted}: {omitted}</p>}
    </div>}
  </div>;
}

function ToolCall({ call, language }: { call: ToolCallDetail; language: Language }) {
  const [open, setOpen] = useState(false);
  const t = labels[language];
  const ToolIcon = toolIcon(call.name);
  const duration = call.durationMs === null || call.status === "running" ? null : call.durationMs < 1_000 ? `${Math.round(call.durationMs)} ${t.ms}` : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(call.durationMs / 1_000)} ${t.seconds}`;
  return <details className="tool-call" data-status={call.status} data-tool={call.name} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="chain-marker tool-call-status-icon" aria-hidden="true">{call.status === "running" ? <Loader size={14} /> : <ToolIcon size={16} />}</span>
      <span className="tool-call-name">{toolLabel(call.name, language)}</span>
      {call.status === "succeeded" ? <span className="sr-only">{t.succeeded}</span> : <span className="tool-call-status">{t[call.status]}</span>}
      {duration && <span className="tool-call-duration">{duration}</span>}
      <IconChevronRight size={14} className="tool-details-chevron" aria-hidden="true" />
    </summary>
    {open && <div className="tool-call-body">
      <ToolPayloadView payload={call.args} name={call.name} section="args" language={language} />
      <ToolPayloadView payload={call.result} name={call.name} section="result" language={language} />
    </div>}
  </details>;
}

/** JSON is parsed exactly once; text results and code are never interpreted as HTML or Markdown. */
export function ToolPayloadView({ payload, name, section, language }: { payload: ToolPayload | null; name: string; section: "args" | "result"; language: Language }) {
  const t = labels[language];
  let value: unknown;
  if (payload?.format === "json") {
    try { value = JSON.parse(payload.text); } catch { /* Malformed stored JSON remains readable as plain text. */ }
  }
  const blocks: Array<{ label: string; language: string; code: string }> = [];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rest: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && section === "args" && name === "bash" && (key === "script" || key === "command")) {
        blocks.push({ label: t.command, language: "bash", code: item });
      } else if (typeof item === "string" && section === "args" && name === "codemode" && key === "code") {
        blocks.push({ label: t.command, language: "javascript", code: item });
      } else if (typeof item === "string" && section === "result" && name === "codemode" && key === "output") {
        blocks.push({ label: t.stdout, language: "text", code: item });
      } else if (typeof item === "string" && section === "result" && (key === "stdout" || key === "stderr") && item.length > 0) {
        blocks.push({ label: t[key], language: "text", code: item });
      } else rest[key] = item;
    }
    if (Object.keys(rest).length) blocks.push({ label: blocks.length ? t.details : t[section], language: "json", code: JSON.stringify(rest, null, 2) });
  }
  if (!blocks.length && payload) blocks.push({ label: t[section], language: payload.format === "json" && value !== undefined ? "json" : "text", code: payload.text });
  return <section className="tool-payload" aria-label={t[section]}>
    {!payload ? <p className="tool-details-note">{t[section]}: {t.unavailable}</p> : blocks.map((block, index) => <div className="tool-payload-part" key={index}><h4>{block.label}</h4><CodeBlock code={block.code} language={block.language} locale={language} preserveWhitespace /></div>)}
    {payload?.truncated && <p className="tool-details-note">{t.truncated}</p>}
  </section>;
}
