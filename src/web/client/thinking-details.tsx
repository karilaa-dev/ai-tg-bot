import { Collapsible } from "@base-ui/react/collapsible";
import { IconBrain, IconChevronDown } from "@tabler/icons-react";
import { useSharedStrings } from "./i18n.js";
import { RichText } from "./rich-text.js";

export function ThinkingDetails({ text }: { text: string }) {
  const t = useSharedStrings();
  // Final summaries use these localized counters; older free-form records stay intact.
  const counters = /^(?:Tool calls|Вызовы инструментов): (\d+)(?: · (?:Reasoning blocks|Блоков рассуждений): \d+)?(?:\r?\n\r?\n|$)/.exec(text);
  const count = counters ? Number(counters[1]) : 0;
  const label = count > 0 ? t.toolCalls(count) : t.thinking;
  const content = counters ? text.slice(counters[0].length) : text;
  if (!content.trim()) return <div className="thinking">{label}</div>;
  return <Collapsible.Root className="thinking">
    <Collapsible.Trigger className="disclosure-trigger"><IconBrain size={15} aria-hidden="true" />{label}<IconChevronDown size={15} aria-hidden="true" /></Collapsible.Trigger>
    <Collapsible.Panel hiddenUntilFound>
      <div className="thinking-content detail-scroll" tabIndex={0} role="region" aria-label={t.thinkingRegion}><RichText text={content} /></div>
    </Collapsible.Panel>
  </Collapsible.Root>;
}
