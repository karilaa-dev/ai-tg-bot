export class WebHttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

/** Forwarding can only enable HTTPS, never downgrade an HTTPS request. */
function isHttps(request: Request) {
  return new URL(request.url).protocol === "https:" || request.headers.get("X-Forwarded-Proto")?.toLowerCase() === "https";
}

export function requireAdminMutation(request: Request) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (request.headers.get("X-Admin-Request") !== "1" || (site !== null && site !== "same-origin")) {
    throw new WebHttpError(403, "This action must come from this website.");
  }
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    const expected = new URL(request.url);
    if (isHttps(request)) expected.protocol = "https:";
    // Reverse proxies must preserve Host; forwarded host is not an authority for CSRF.
    if (origin !== expected.origin) throw new WebHttpError(403, "This action must come from this website.");
  }
}
