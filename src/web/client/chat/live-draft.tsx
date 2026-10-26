import type { ChatHistory } from "../../chat-types.js";
import { useUiLanguage } from "../i18n.js";
import { RichText } from "../rich-text.js";
import { ResponseChain, type LiveChainState } from "../tool-details.js";
import { useChatStrings } from "./strings.js";

export const hasDraftContent = (draft: ChatHistory["draft"]) => Boolean(draft && (draft.text || draft.thinking || draft.toolActivity?.calls.length));

/** The reply being written: a live chain line (state, elapsed time, current step) and the streamed text so far. */
export function LiveDraft({ draft, live = null }: { draft: ChatHistory["draft"]; live?: LiveChainState | null }) {
  const t = useChatStrings();
  const language = useUiLanguage();
  if (!live && !hasDraftContent(draft)) return null;
  // Reasoning travels with the tool snapshot once a call starts; before that only the joined summary exists.
  const thinking = draft?.toolActivity?.calls.length ? null : draft?.thinking;
  return <article className="chat-message" data-role="assistant" data-live="true" aria-label={t.responseInProgress} aria-busy="true">
    <ResponseChain activity={draft?.toolActivity} thinking={thinking} language={language}
      live={live ?? { state: "generating", startedAt: Date.now(), queuedTurns: 0 }} />
    {draft?.text && <div className="chat-prose"><RichText text={draft.text} /></div>}
  </article>;
}
