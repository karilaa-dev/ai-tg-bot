# Browser download identity

Browser Use sessions are shared by all of a user's threads, while each tab belongs to one thread. A download must therefore be attributed to the tab that started it before `browser_send_file` can deliver it.

## What the contracts provide

- **Browser Use Cloud, API v3, "List browser session downloads"** (`GET browsers/{session_id}/downloads`): each file has only `path` (the basename relative to the session's downloads prefix), `size`, `lastModified` (the S3 modification time) and, with `includeUrls=true`, a presigned `url` that expires after 15 minutes. Pagination uses `nextCursor` and `hasMore`. The documentation defines no download or event ID, no ordering, no link to CDP or Playwright download events, and no rule for repeated file names. Checked 2026-11-10 against the published API v3 reference.
- **Playwright 1.64.1** (`playwright-core`, connected with `chromium.connectOverCDP`): `page.on("download")` gives a `Download` with `suggestedFilename()`, `url()` and `page()`. `download.path()` throws when the browser is remote, and the file name Playwright assigns is a private GUID. Over CDP, Playwright points the browser's download directory at a temporary folder on the bot host, so `saveAs()` and `createReadStream()` cannot be relied on for a remote browser either.

Neither side exposes a stable identity that maps a download event to a listed file. The bot does not call private Playwright fields or assume how the provider names files.

## Rule

A listed file is attributed to a tab only when both hold:

1. every download event in the current session with that file name came from this tab, and
2. the listing has no more files with that name than this tab's download events.

Files older than the first matching event (with a 10-second clock allowance) are ignored, as before. Everything else is reported in `ambiguous_downloads` with no `download_index`, so the model cannot send it. Time order is not treated as ownership proof.

`browser_send_file` repeats the check against a fresh listing. If a same-named download started in another tab after the listing, delivery fails with `ambiguous_download` instead of sending a file that may belong to another thread. An expired or missing presigned URL fails with `download_unavailable`.

## Consequences and limits

- Downloads with distinct names, and repeated downloads of one name within a single tab, work as before.
- When two tabs download the same name, neither tab can send it. Closing the other tab does not make its downloads attributable; a new session (for example after `browser_close_session` or a rollover) starts with no events.
- Indexes from the last listing keep pointing at the same files when the provider reorders or pages its results.
- A download started by a page the bot never registered as a tab produces no event. Such a file can only be attributed to a tab when that tab has a same-named event and the count rule still holds.
