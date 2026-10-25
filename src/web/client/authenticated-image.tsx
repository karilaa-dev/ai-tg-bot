import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, buttonVariants, Text } from "@cloudflare/kumo";
import { IconDownload, IconPhoto, IconRefresh, IconPlayerPlay } from "@tabler/icons-react";
import { AttachmentLoader, type AttachmentSource, type LoadedAttachment } from "./attachments.js";
import { imageMimeTypes } from "../media.js";

export interface OpenUiImageSource { threadId: number; source: AttachmentSource; fileNames?: ReadonlyMap<number, string> }
interface ImageResources {
  loader: AttachmentLoader;
  states: Map<number, LoadedAttachment>;
  rendered: (fileId: number) => () => void;
}
const ImageContext = createContext<ImageResources | null>(null);
const FileNamesContext = createContext<ReadonlyMap<number, string> | undefined>(undefined);

/** Observe the placeholder itself, before a private request or a blob URL exists. */
export function useFirstVisible<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

export function ImageProvider({ imageSource, onImagesRendered, children }: {
  imageSource?: OpenUiImageSource; onImagesRendered?: (ids: ReadonlySet<number>) => void; children: ReactNode;
}) {
  const [resources, setResources] = useState<ImageResources | null>(null);
  const threadId = imageSource?.threadId;
  const source = imageSource?.source;
  useEffect(() => {
    if (threadId === undefined || !source) { setResources(null); return; }
    const mounted = new Map<number, number>();
    const rendered = (fileId: number) => {
      mounted.set(fileId, (mounted.get(fileId) ?? 0) + 1);
      onImagesRendered?.(new Set(mounted.keys()));
      return () => {
        const count = (mounted.get(fileId) ?? 1) - 1;
        if (count) mounted.set(fileId, count); else mounted.delete(fileId);
        onImagesRendered?.(new Set(mounted.keys()));
      };
    };
    const loader = new AttachmentLoader(threadId, states => setResources({ loader, states, rendered }), source);
    setResources({ loader, states: new Map(), rendered });
    return () => { loader.dispose(); onImagesRendered?.(new Set()); };
  }, [threadId, source, onImagesRendered]);
  return <ImageContext.Provider value={resources}><FileNamesContext.Provider value={imageSource?.fileNames}>{children}</FileNamesContext.Provider></ImageContext.Provider>;
}

export function AuthenticatedImage({ source, alt, caption, className = "", language = "en", variant = "default" }: {
  source: string; alt: string; caption?: string; className?: string; language?: "en" | "ru"; variant?: "default" | "thumbnail";
}) {
  const thumbnail = variant === "thumbnail";
  const resources = useContext(ImageContext);
  const fileNames = useContext(FileNamesContext);
  const [failedUrl, setFailedUrl] = useState<string>();
  const { ref, visible } = useFirstVisible<HTMLElement>();
  const fileId = /^file:[1-9]\d*$/.test(source) ? Number(source.slice(5)) : NaN;
  const valid = Number.isSafeInteger(fileId);
  const loader = resources?.loader;
  const rendered = resources?.rendered;
  const file = useMemo(() => ({ id: fileId, name: alt, size: 0, mimeType: null, caption: null }), [fileId, alt]);
  useEffect(() => { if (valid) return rendered?.(fileId); }, [rendered, valid, fileId]);
  useEffect(() => { if (visible && valid) loader?.load(file, "auto"); }, [loader, visible, valid, file]);
  const state = resources?.states.get(fileId);
  const url = state?.status === "ready" && imageMimeTypes.includes(state.mime ?? "") && state.url !== failedUrl ? state.url : undefined;
  const loading = Boolean(loader) && (!state || state.status === "loading");
  const failed = state?.status === "error" || state?.status === "ready" && !url;
  // Bytes that arrived but cannot be previewed (undecodable or not an image type) stay saveable; `download` never opens them.
  const undisplayable = state?.status === "ready" && !url ? state.url : undefined;
  const saveName = fileNames?.get(fileId) ?? alt;
  const saveLabel = language === "ru" ? `Сохранить: ${alt}` : `Save: ${alt}`;
  const saveText = language === "ru" ? "Сохранить" : "Save";
  return <figure ref={ref} className={`${thumbnail ? "m-0 size-full" : "m-0 grid min-w-0 gap-2"} ${className}`} data-file-image={valid ? fileId : undefined}>
    {url ? <a href={url} download={saveName} className={thumbnail ? "block size-full" : undefined} aria-label={saveLabel} title={language === "ru" ? "Сохранить изображение" : "Save image"}>
      <img src={url} alt={alt} decoding="async" referrerPolicy="no-referrer" className={thumbnail ? "block size-full object-cover" : "block max-h-96 w-full rounded-lg object-contain"} onError={() => setFailedUrl(url)} />
    </a> : <div className={thumbnail ? "grid size-full place-content-center justify-items-center gap-1 bg-kumo-tint" : "grid min-h-28 place-content-center justify-items-center gap-2 rounded-lg bg-kumo-tint px-4 py-5 text-center"}>
      <IconPhoto size={thumbnail ? 20 : 24} role="img" aria-label={alt} />{!thumbnail && <Text>{alt}</Text>}
      <span className={thumbnail ? "sr-only" : "text-sm text-kumo-subtle"}>{language === "ru" ? loading ? "Загрузка изображения…" : undisplayable ? "Предпросмотр недоступен" : "Изображение недоступно" : loading ? "Loading picture…" : undisplayable ? "Preview unavailable" : "Picture unavailable"}</span>
      <div className="flex flex-wrap justify-center gap-1">
        {undisplayable && <a href={undisplayable} download={saveName} className={`${buttonVariants({ variant: "secondary", size: "sm", shape: thumbnail ? "square" : "base" })} ${thumbnail ? "size-7 p-0" : ""}`}
          aria-label={saveLabel} title={saveLabel}><IconDownload size={16} aria-hidden="true" />{!thumbnail && saveText}</a>}
        {failed && !state?.needsSandbox && loader && <Button type="button" variant="secondary" size="sm" className={thumbnail ? "size-7 p-0" : undefined} title={language === "ru" ? "Повторить" : "Try again"} aria-label={language === "ru" ? "Повторить" : "Try again"} onClick={() => loader.load(file, "download", true)}>{thumbnail ? <IconRefresh size={16} aria-hidden="true" /> : language === "ru" ? "Повторить" : "Try again"}</Button>}
        {state?.needsSandbox && loader && <Button type="button" variant="secondary" size="sm" className={thumbnail ? "size-7 p-0" : undefined} title={language === "ru" ? "Запустить рабочую среду и загрузить" : "Start sandbox and load"} aria-label={language === "ru" ? "Запустить рабочую среду и загрузить" : "Start sandbox and load"} onClick={() => loader.load(file, "download", true, true)}>{thumbnail ? <IconPlayerPlay size={16} aria-hidden="true" /> : language === "ru" ? "Запустить рабочую среду и загрузить" : "Start sandbox and load"}</Button>}
      </div>
    </div>}
    {caption && <figcaption className="text-sm text-kumo-subtle">{caption}</figcaption>}
  </figure>;
}
