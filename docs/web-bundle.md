# Website JavaScript bundle

Before this change the website shipped one 1,520,593-byte JavaScript file. Every visitor, including a signed-out visitor who only sees the sign-in button, downloaded and parsed the chat workspace, the admin dashboard, OpenUI, Markdown and syntax highlighting.

## Measurement

`scripts/benchmark-web-bundle.ts <checkout>` builds the checkout's production assets, serves them with the synthetic fixture in `test/web/http-smoke.ts`, and opens each route in a fresh Chromium context with an empty cache. It records every JavaScript response until the route shell is ready, with gzip and brotli sizes computed locally (the app itself does not compress; a reverse proxy may). Four cold runs per route are reported. Raw results are in [`benchmarks/web-bundle.json`](benchmarks/web-bundle.json) (Bun 1.4.4, Chromium 156, loopback, 2026-11-10).

| Route | Before: JS (raw / gzip / brotli) | After: JS (raw / gzip / brotli) | Requests before → after | Time to shell ready, 4 runs (before → after) |
|---|---|---|---|---|
| Signed-out sign-in page | 1,520,593 / 484,271 / 378,488 | 527,389 / 168,744 / 145,420 | 1 → 1 | 219–263 ms → 125–135 ms |
| First sign-in, chat | 1,520,593 / 484,271 / 378,488 | 1,377,995 / 438,901 / 376,623 | 1 → 3 | 395–532 ms → 313–359 ms |
| Returning signed-in chat, cold cache | 1,520,593 / 484,271 / 378,488 | 1,377,995 / 438,901 / 376,623 | 1 → 3 | 255–381 ms → 218–285 ms |
| Admin dashboard | 1,520,593 / 484,271 / 378,488 | 1,094,150 / 350,423 / 302,899 | 1 → 3 | 370–394 ms → 287–323 ms |

The timing landmark is the sign-in link, the New chat button, or the admin navigation. The fixture uses `signInOnlyChat`, so unsupported chat API calls can return errors; the measurement establishes shell rendering, not a working conversation. Separate browser smoke tests cover chat behavior.

Times are loopback wall-clock measurements that include the fixture's sign-in redirects; they show parse and request-waterfall effects, not real network latency. On a slower link the extra requests on signed-in routes cost round trips, which the preloading below overlaps with the session check for returning users. All emitted files together grew from 1,520,593 to 1,551,100 bytes because of chunk boundaries.

## Change

- `scripts/build-web.ts` enables Bun code splitting. The entry contains the sign-in gate; the chat workspace and the admin dashboard are separate hashed chunks, with shared code in a common chunk.
- `src/web/client/app.tsx` loads each route with a dynamic import. Loading state is kept in React state instead of `Suspense`; the first version used `lazy`/`Suspense` and measured about 1 s for the first signed-in chat because React holds a revealed boundary for about 300 ms after its fallback appears.
- The admin chunk starts downloading as soon as `/admin` loads. The chat chunk starts in parallel with the session check when this browser was signed in last time (a `chat-signed-in` flag in local storage that holds no account data and is removed on sign-out or when the session check finds no session).
- While the chat chunk loads, the existing "Loading workspace" screen is shown. If the download fails, the existing "Could not reach the server" message and **Try again** button appear; retrying requests the chunk again without reloading the page.

Hashed chunks are served like the other content-addressed assets: `text/javascript`, `public, max-age=31536000, immutable`, `nosniff`, no cookies. `index.html` stays `no-store`, and API responses are unchanged. Styles are unchanged: the entry stylesheet is byte-identical to the previous build. Bun also emits a small route stylesheet duplicating rules already in the entry stylesheet; nothing references it.

Rich rendering (OpenUI, Markdown and Prism) stays in the chat chunk because history needs it immediately after sign-in; splitting it further was not measured as worthwhile here.
