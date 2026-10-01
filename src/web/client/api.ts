export const SESSION_EXPIRED_EVENT = "admin-session-expired";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** All private requests share session expiry handling, including downloaded files. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) headers.set("X-Admin-Request", "1");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) {
    if (typeof window !== "undefined" && url !== "/api/auth/login") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError("Your admin session expired. Sign in again to continue.", 401);
  }
  return response;
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error ?? "The request could not be completed. Try again.", response.status);
  return body as T;
}
