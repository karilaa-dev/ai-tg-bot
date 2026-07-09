import type { AppConfig } from "../config.js";
import { relayAbort, throwIfAborted } from "./cancel.js";

const DOCLING_HEALTHCHECK_TIMEOUT_MS = 5_000;

export async function checkDocling(config: Pick<AppConfig, "DOCLING_URL">): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCLING_HEALTHCHECK_TIMEOUT_MS);
  const endpoint = doclingEndpoint(config.DOCLING_URL, "/docs");
  try {
    const res = await fetch(endpoint, { method: "GET", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`Docling healthcheck failed at ${endpoint}: ${errorDetail(err)}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export async function convertWithDocling(input: {
  config: Pick<AppConfig, "DOCLING_URL" | "DOCLING_TIMEOUT_MS">;
  filename: string;
  bytes: Buffer;
  signal?: AbortSignal;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.config.DOCLING_TIMEOUT_MS);
  const cleanupAbortRelay = relayAbort(input.signal, () => controller.abort());
  try {
    throwIfAborted(input.signal);
    const endpoint = doclingEndpoint(input.config.DOCLING_URL, "/v1/convert/source");
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ kind: "file", base64_string: input.bytes.toString("base64"), filename: input.filename }],
          options: { to_formats: ["md"], table_mode: "accurate", image_export_mode: "placeholder" },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throwIfAborted(input.signal);
      throw new Error(`Docling request failed at ${endpoint}: ${errorDetail(err)}`, { cause: err });
    }
    if (!res.ok) throw new Error(`docling HTTP ${res.status}`);
    throwIfAborted(input.signal);
    const json = await res.json() as Record<string, unknown>;
    throwIfAborted(input.signal);
    return findMarkdown(json) ?? "";
  } finally {
    clearTimeout(timer);
    cleanupAbortRelay();
  }
}

function doclingEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`;
  return err.message;
}

function findMarkdown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.md_content === "string") return obj.md_content;
  if (typeof obj.markdown === "string") return obj.markdown;
  if (obj.document) return findMarkdown(obj.document);
  for (const child of Object.values(obj)) {
    const found = findMarkdown(child);
    if (found) return found;
  }
  return undefined;
}
