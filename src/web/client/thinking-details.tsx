import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronDown } from "lucide-react";
import { RichText } from "./rich-text.js";

export function ThinkingDetails({ text }: { text: string }) {
  // Final summaries use these localized counters; older free-form records stay intact.
  const counters = /^(?:Tool calls|Вызовы инструментов): (\d+)(?: · (?:Reasoning blocks|Блоков рассуждений): \d+)?(?:\r?\n\r?\n|$)/.exec(text);
  const count = counters ? Number(counters[1]) : 0;
  const label = count > 0 ? `${count} tool ${count === 1 ? "call" : "calls"}` : "Thinking";
  const content = counters ? text.slice(counters[0].length) : text;
  if (!content.trim()) return <div className="thinking">{label}</div>;
  return <Collapsible.Root className="thinking">
    <Collapsible.Trigger className="disclosure-trigger"><Brain size={15} aria-hidden="true" />{label}<ChevronDown size={15} aria-hidden="true" /></Collapsible.Trigger>
    <Collapsible.Panel hiddenUntilFound>
      <div className="thinking-content detail-scroll" tabIndex={0} role="region" aria-label="Thinking and tool details"><RichText text={content} /></div>
    </Collapsible.Panel>
  </Collapsible.Root>;
}
