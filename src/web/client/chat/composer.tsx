import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { IconArrowUp, IconFile, IconPaperclip, IconPhoto, IconPlayerStopFilled, IconX } from "@tabler/icons-react";
import { fileSize, useUiLanguage, type UiLanguage } from "../i18n.js";
import { cn } from "../lib/utils.js";
import { isEmptyDraft, type Draft } from "./drafts.js";
import { chatStrings, useChatStrings } from "./strings.js";
import { MAX_CHAT_UPLOAD_BYTES, MAX_CHAT_UPLOAD_FILES } from "../../../files/limits.js";

export const MAX_FILES = MAX_CHAT_UPLOAD_FILES;
const coarsePointer = () => matchMedia("(pointer: coarse)").matches;
const MAX_INPUT_HEIGHT = 240;

export type FileProblem = { kind: "too-large" | "total-too-large"; names: string[]; maxBytes: number } | { kind: "too-many" };

export function fileProblemText(problem: FileProblem, language: UiLanguage): string {
  const t = chatStrings(language);
  switch (problem.kind) {
    case "too-large": return t.filesTooLarge(problem.names, fileSize(language, problem.maxBytes, 0));
    case "total-too-large": return t.filesTotalTooLarge(problem.names, fileSize(language, problem.maxBytes, 0));
    case "too-many": return t.tooManyFiles(MAX_FILES);
    default: {
      const _exhaustive: never = problem;
      return _exhaustive;
    }
  }
}

/** Any file type is accepted within the server's separate per-file and message limits.
 * Returns the files that fit, plus the reason any were left out. */
export function acceptFiles(current: File[], incoming: File[], maxBytes: number, maxTotalBytes = MAX_CHAT_UPLOAD_BYTES): { files: File[]; problem: FileProblem | null } {
  const tooLarge = incoming.filter(file => file.size > maxBytes);
  const fitting = incoming.filter(file => file.size <= maxBytes);
  const files = [...current];
  let total = current.reduce((sum, file) => sum + file.size, 0);
  const overTotal: File[] = [];
  let overCount = false;
  for (const file of fitting) {
    if (files.length >= MAX_FILES) { overCount = true; continue; }
    if (total + file.size > maxTotalBytes) { overTotal.push(file); continue; }
    files.push(file);
    total += file.size;
  }
  const problem: FileProblem | null = tooLarge.length ? { kind: "too-large", names: tooLarge.map(file => file.name), maxBytes }
    : overTotal.length ? { kind: "total-too-large", names: overTotal.map(file => file.name), maxBytes: maxTotalBytes }
    : overCount ? { kind: "too-many" } : null;
  return { files, problem };
}

export function Composer({ draft, onDraftChange, onSubmit, maxFileBytes, placeholder, stop, disabled = false, autoFocus = false }: {
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  onSubmit: (draft: Draft) => void;
  maxFileBytes: number;
  placeholder?: string;
  stop?: { visible: boolean; busy: boolean; onStop: () => void };
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const t = useChatStrings();
  const language = useUiLanguage();
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [problem, setProblem] = useState<FileProblem | null>(null);
  const empty = isEmptyDraft(draft);
  const stopping = Boolean(stop?.visible);

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    node.style.overflowY = node.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
  }, [draft.text]);
  useEffect(() => { if (autoFocus && !disabled && !coarsePointer()) input.current?.focus({ preventScroll: true }); }, [autoFocus, disabled]);

  const addFiles = (incoming: File[]) => {
    if (!incoming.length) return;
    const result = acceptFiles(draft.files, incoming, maxFileBytes);
    setProblem(result.problem);
    onDraftChange({ ...draft, files: result.files, requestId: null });
  };
  const submit = () => {
    if (disabled || empty) return;
    setProblem(null);
    onSubmit(draft);
    input.current?.focus({ preventScroll: true });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
    // Touch keyboards have no Shift+Enter, so Return inserts a line there and the button sends.
    if (coarsePointer() && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    submit();
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };

  // Clicking the padding around the text still places the caret in the field.
  return <form className={cn("chat-composer", disabled && "is-disabled")} onSubmit={event => { event.preventDefault(); submit(); }} aria-label={t.composerLabel}
    onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } }}>
    {draft.files.length > 0 && <ul className="chat-composer-files" aria-label={t.attachedFiles}>
      {draft.files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="chat-file-chip">
        <span className="chat-file-chip-icon" aria-hidden="true">{file.type.startsWith("image/") ? <IconPhoto size={16} /> : <IconFile size={16} />}</span>
        <span className="chat-file-chip-copy"><span className="chat-file-chip-name">{file.name}</span><span className="chat-muted">{fileSize(language, file.size, 0)}</span></span>
        <Button variant="ghost" size="sm" shape="circle" className="chat-file-chip-remove" aria-label={t.removeFile(file.name)} onClick={() => onDraftChange({ ...draft, files: draft.files.filter((_, i) => i !== index), requestId: null })}><IconX size={14} aria-hidden="true" /></Button>
      </li>)}
    </ul>}
    <textarea ref={input} className="chat-composer-input" rows={1} value={draft.text} placeholder={placeholder ?? t.messagePlaceholder} aria-label={t.messageLabel} aria-describedby={hintId}
      disabled={disabled} onKeyDown={keyDown} onPaste={paste} enterKeyHint={coarsePointer() ? "enter" : "send"}
      onChange={event => onDraftChange({ ...draft, text: event.target.value, requestId: null })} />
    {problem && <p className="chat-composer-problem" role="alert">{fileProblemText(problem, language)}</p>}
    <div className="chat-composer-bar">
      <input ref={picker} type="file" multiple hidden tabIndex={-1} onChange={event => { addFiles([...event.target.files ?? []]); event.target.value = ""; }} />
      <Button variant="ghost" shape="circle" className="chat-composer-tool" aria-label={t.attachFiles} title={t.attachFiles} disabled={disabled || draft.files.length >= MAX_FILES} onClick={() => picker.current?.click()}><IconPaperclip size={18} aria-hidden="true" /></Button>
      <span id={hintId} className="sr-only">{t.composerHint}</span>
      <span className="chat-composer-actions">
      {stopping && <Button variant={empty ? "primary" : "secondary"} shape="circle" className="chat-composer-send chat-composer-stop" aria-label={t.stop} title={t.stop} loading={stop!.busy} disabled={stop!.busy} onClick={stop!.onStop}>
        {!stop!.busy && <IconPlayerStopFilled size={14} aria-hidden="true" />}</Button>}
      {(!stopping || !empty) && <Button type="submit" variant="primary" shape="circle" className="chat-composer-send" aria-label={t.sendMessage} title={t.sendMessage} disabled={disabled || empty}><IconArrowUp size={18} stroke={2.25} aria-hidden="true" /></Button>}
      </span>
    </div>
  </form>;
}
