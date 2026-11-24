/** The browser may reuse bytes only after this request's authorization and visibility checks. */
export function privateMediaHeaders(tag: string) {
  return {
    "Cache-Control": "private, no-cache, must-revalidate",
    Vary: "Cookie, X-Chat-User",
    ETag: `"${tag}"`,
  };
}

/** GET and HEAD compare entity tags weakly. Quoted opaque tags can themselves contain commas. */
export function matchesIfNoneMatch(condition: string | null, etag: string): boolean {
  if (!condition) return false;
  if (condition.trim() === "*") return true;
  return condition.match(/"[^"]*"/g)?.includes(etag) ?? false;
}
