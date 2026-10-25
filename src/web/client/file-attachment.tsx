import { useEffect, useState } from "react";
import { IconDownload, IconFileText, IconMicrophone, IconPhoto } from "@tabler/icons-react";
import type { WebAttachment } from "../types.js";
import { attachmentKind, isAudioMime, imageMimeTypes } from "../media.js";
import { useFirstVisible } from "./authenticated-image.js";
import type { LoadedAttachment } from "./attachments.js";
import { fileSize, localizeServerError, useSharedStrings, useUiLanguage } from "./i18n.js";
import { RichText } from "./rich-text.js";
import { Button, buttonVariants } from "./components/ui/button.js";

export function FileAttachment({ file, state, maxBytes, load, autoLoad, preview = true, messageText = "", messageAttachments = [file] }: {
  file: WebAttachment; state?: LoadedAttachment; maxBytes: number; load: (allowSandbox?: boolean) => void; messageText?: string; messageAttachments?: WebAttachment[]; autoLoad?: () => void; preview?: boolean;
}) {
  const language = useUiLanguage();
  const t = useSharedStrings();
  const [decoded, setDecoded] = useState<{ url: string; width: number; height: number }>();
  const [broken, setBroken] = useState<string>();
  const size = file.size === null ? t.unknownSize : fileSize(language, file.size);
  const kind = attachmentKind(file);
  const image = kind === "image" && preview;
  const { ref, visible } = useFirstVisible<HTMLDivElement>();
  useEffect(() => { if (visible && preview) autoLoad?.(); }, [visible, preview, autoLoad]);
  const audio = kind === "audio";
  const caption = file.caption?.trim();
  const fallbackNames = messageAttachments.map(f => f.caption?.trim() || f.name).filter(Boolean).join(", ");
  const fallbackCaption = ["Generated image", "Attached file", "Attached files"].some(label => messageText.trim() === `${label}: ${fallbackNames}`);
  const showCaption = caption && !fallbackCaption && !`\n\n${messageText.trim()}\n\n`.includes(`\n\n${caption}\n\n`);
  const oversized = file.size !== null && file.size > maxBytes;
  const readyImage = state?.url && imageMimeTypes.includes(state.mime ?? "");
  const readyAudio = state?.url && isAudioMime(state.mime ?? "");
  const mediaError = Boolean(state?.url && (broken === state.url || (image && !readyImage) || (audio && !readyAudio)));
  const pending = state?.status === "loading";
  const action = state?.url
    ? <a className={buttonVariants({ variant: "ghost", size: image ? "icon-sm" : "sm" })} href={state.url} download={file.name} aria-label={image ? t.saveImage : t.saveFile(file.name)} title={image ? t.saveImage : undefined}><IconDownload aria-hidden="true" />{!image && t.save}</a>
    : !oversized && !state?.needsSandbox && <Button variant="outline" size="sm" disabled={pending} onClick={() => load()}>{pending ? t.loading : state?.status === "error" ? t.retry : image ? t.loadImage : audio ? t.loadAudio : t.loadFile}</Button>;
  const placeholder = oversized ? t.exceedsLimit : state?.needsSandbox ? t.waitingSandbox
    : state?.status === "error" || mediaError ? t.previewUnavailable : pending ? t.loadingKind(kind) : t.mediaPreview(image ? "image" : "audio");

  return <div ref={ref} className={`file-block ${image ? "image-attachment" : audio ? "audio-attachment" : ""}`}>
    {image && <>
      <div className="image-frame" aria-label={t.imageLabel(file.caption ?? t.attachedPhoto)} aria-busy={pending || Boolean(readyImage && decoded?.url !== state.url && !mediaError)}>
        {readyImage && <img className="attachment-image" src={state.url} alt={file.caption ?? t.attachedImage} style={{ visibility: decoded?.url === state.url ? "visible" : "hidden" }} onLoad={e => setDecoded({ url: state.url!, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setBroken(state.url)} />}
        {(!readyImage || decoded?.url !== state?.url) && <div className="image-placeholder" role="status"><IconPhoto className="size-9" aria-hidden="true" /><span>{readyImage && !mediaError ? t.loadingImage : placeholder}</span></div>}
        <div className="image-actions">{action}</div>
      </div>
      <details className="media-details"><summary>{t.imageDetails}</summary><div className="media-details-content">
        {file.description && <RichText text={file.description} />}
        <dl><dt>{t.detailFile}</dt><dd>{file.name}</dd><dt>{t.detailSize}</dt><dd>{size}</dd>
          {file.mimeType && <><dt>{t.detailFormat}</dt><dd>{file.mimeType}</dd></>}
          {decoded?.url === state?.url && decoded && <><dt>{t.detailDimensions}</dt><dd>{decoded.width} × {decoded.height}</dd></>}
        </dl>
      </div></details>
    </>}
    {audio && <div className="audio-card">
      <div className="audio-heading"><IconMicrophone className="size-4" aria-hidden="true" /><span>{t.audioMessage}</span><small>{size}</small>{action}</div>
      {readyAudio && !mediaError
        ? <audio key={state.url} controls preload="auto" src={state.url} aria-label={t.audioMessage} onError={() => setBroken(state.url)}>{t.audioUnsupported}</audio>
        : <div className="audio-placeholder" role="status" aria-busy={pending}><span className="audio-bars" aria-hidden="true">▂ ▅ ▃ ▇ ▄ ▂ ▆ ▅ ▃ ▇ ▄ ▂</span><span>{placeholder}</span></div>}
      {file.transcription && <details className="media-details audio-transcription"><summary>{t.transcription}{file.transcriptionTruncated ? t.savedPreview : ""}</summary><p className="transcription-text">{file.transcription}</p></details>}
    </div>}
    {!image && !audio && <div className="file-card">
      <IconFileText aria-hidden="true" /><div className="file-info"><strong>{file.name}</strong><small>{size}{pending ? t.loadingSuffix : oversized ? t.exceedsLimitShort : ""}</small></div>{action}
    </div>}
    {state?.needsSandbox && <div className="sandbox-prompt" role="status"><p>{t.sandboxPrompt}</p><Button variant="outline" size="sm" onClick={() => load(true)}>{t.sandboxLoad}</Button></div>}
    {state?.error && <p role="status" className="file-error">{localizeServerError(state.error, language)}</p>}
    {mediaError && <p role="status" className="file-error">{t.mediaErrorBefore}<button className="underline" onClick={() => load()}>{t.mediaErrorRetry}</button>{t.mediaErrorAfter}</p>}
    {state?.text !== undefined && !image && !audio && <details className="text-preview" open><summary>{t.textPreview}{file.size !== null && file.size > 65536 ? t.firstKilobytes : ""}</summary><pre>{state.text}</pre></details>}
    {showCaption && <p className="file-caption">{caption}</p>}
  </div>;
}
