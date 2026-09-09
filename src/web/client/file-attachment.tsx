import { useState } from "react";
import { Download, FileText, ImageIcon, Mic } from "lucide-react";
import type { WebAttachment } from "../types.js";
import { attachmentKind, isAudioMime, imageMimeTypes } from "../media.js";
import type { LoadedAttachment } from "./attachments.js";
import { RichText } from "./rich-text.js";
import { Button, buttonVariants } from "./components/ui/button.js";
import { Attachment, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentMedia } from "./components/ui/attachment.js";

const fileSize = (size: number | null) => size === null ? "Unknown size" : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;

export function FileAttachment({ file, state, maxBytes, load }: {
  file: WebAttachment; state?: LoadedAttachment; maxBytes: number; load: (allowSandbox?: boolean) => void;
}) {
  const [decoded, setDecoded] = useState<{ url: string; width: number; height: number }>();
  const [broken, setBroken] = useState<string>();
  const kind = attachmentKind(file);
  const image = kind === "image";
  const audio = kind === "audio";
  const oversized = file.size !== null && file.size > maxBytes;
  const readyImage = state?.url && imageMimeTypes.includes(state.mime ?? "");
  const readyAudio = state?.url && isAudioMime(state.mime ?? "");
  const mediaError = Boolean(state?.url && (broken === state.url || (image && !readyImage) || (audio && !readyAudio)));
  const pending = state?.status === "loading";
  const action = state?.url
    ? <a className={buttonVariants({ variant: "ghost", size: image ? "icon-sm" : "sm" })} href={state.url} download={file.name} aria-label={image ? "Save image" : `Save ${file.name}`} title={image ? "Save image" : undefined}><Download />{!image && "Save"}</a>
    : !oversized && !state?.needsSandbox && <Button variant="outline" size="sm" disabled={pending} onClick={() => load()}>{pending ? "Loading…" : state?.status === "error" ? "Retry" : image ? "Load image" : audio ? "Load audio" : "Load file"}</Button>;
  const placeholder = oversized ? "Exceeds the 20 MiB limit" : state?.needsSandbox ? "Waiting for sandbox approval"
    : state?.status === "error" || mediaError ? "Preview unavailable" : pending ? `Loading ${kind}…` : `${image ? "Image" : "Audio"} preview`;

  return <div className={`file-block ${image ? "image-attachment" : audio ? "audio-attachment" : ""}`}>
    {image && <>
      <div className="image-frame" aria-label={`Image: ${file.caption ?? "Attached photo"}`} aria-busy={pending || Boolean(readyImage && decoded?.url !== state.url && !mediaError)}>
        {readyImage && <img className="attachment-image" src={state.url} alt={file.caption ?? "Attached image"} style={{ visibility: decoded?.url === state.url ? "visible" : "hidden" }} onLoad={e => setDecoded({ url: state.url!, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setBroken(state.url)} />}
        {(!readyImage || decoded?.url !== state?.url) && <div className="image-placeholder" role="status"><ImageIcon className="size-9" /><span>{readyImage && !mediaError ? "Loading image…" : placeholder}</span></div>}
        <div className="image-actions">{action}</div>
      </div>
      <details className="media-details"><summary>Image details</summary><div className="media-details-content">
        {file.description && <RichText text={file.description} />}
        <dl><dt>File</dt><dd>{file.name}</dd><dt>Size</dt><dd>{fileSize(file.size)}</dd>
          {file.mimeType && <><dt>Format</dt><dd>{file.mimeType}</dd></>}
          {decoded?.url === state?.url && decoded && <><dt>Dimensions</dt><dd>{decoded.width} × {decoded.height}</dd></>}
        </dl>
      </div></details>
    </>}
    {audio && <div className="audio-card">
      <div className="audio-heading"><Mic className="size-4" aria-hidden="true" /><span>Audio message</span><small>{fileSize(file.size)}</small>{action}</div>
      {readyAudio && !mediaError
        ? <audio key={state.url} controls preload="auto" src={state.url} aria-label="Audio message" onError={() => setBroken(state.url)}>Your browser cannot play this audio. Use Save to download it.</audio>
        : <div className="audio-placeholder" role="status" aria-busy={pending}><span className="audio-bars" aria-hidden="true">▂ ▅ ▃ ▇ ▄ ▂ ▆ ▅ ▃ ▇ ▄ ▂</span><span>{placeholder}</span></div>}
      {file.transcription && <details className="media-details audio-transcription"><summary>Transcription{file.transcriptionTruncated ? " · Saved preview" : ""}</summary><p className="transcription-text">{file.transcription}</p></details>}
    </div>}
    {!image && !audio && <Attachment state={pending ? "processing" : state?.status === "error" ? "error" : state?.status === "ready" ? "done" : "idle"}>
      <AttachmentMedia><FileText /></AttachmentMedia><AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle><AttachmentDescription>{fileSize(file.size)}{pending ? " · Loading" : oversized ? " · Exceeds 20 MiB limit" : ""}</AttachmentDescription></AttachmentContent><AttachmentActions>{action}</AttachmentActions>
    </Attachment>}
    {state?.needsSandbox && <div className="sandbox-prompt" role="status"><p>Retrieve this file using its sandbox? If paused, it will start temporarily and pause again as soon as the file is loaded.</p><Button variant="outline" size="sm" onClick={() => load(true)}>Start sandbox and load</Button></div>}
    {state?.error && <p role="status" className="file-error">{state.error}</p>}
    {mediaError && <p role="status" className="file-error">This preview could not be opened. You can save the file or <button className="underline" onClick={() => load()}>retry</button>.</p>}
    {state?.text !== undefined && !image && !audio && <details className="text-preview" open><summary>Text preview{file.size !== null && file.size > 65536 ? " · First 64 KiB" : ""}</summary><pre>{state.text}</pre></details>}
    {file.caption && !image && !audio && <p className="file-caption">{file.caption}</p>}
  </div>;
}
