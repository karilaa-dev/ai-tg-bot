# Chat history polling

The website polls a conversation's history every 1.5 seconds while a reply is active, every 8 seconds otherwise, and every second while a compaction runs. Each poll asks for messages from the start of the last 50 it holds (or an older running action), because messages can change in place: delivery replaces a draft, attachments arrive later, compaction actions update, and the read position moves. Polling only for new IDs would miss those edits.

## Measurement

`scripts/benchmark-history-polling.ts` builds a synthetic thread of 160 messages (6,000-byte replies with six tool calls each, 15 attachments, and a running compaction older than the visible tail) in an in-memory SQLite database or a temporary PostgreSQL schema. It loads an older page so the running action is visible, verifies that every projected reply retains six tool calls, and follows the client's cursor rule for 40 unchanged refreshes and reports SQL statements, response bytes and server time. Results for the target commit and this branch are in [`benchmarks/history-polling.json`](benchmarks/history-polling.json) (Bun 1.4.4, PostgreSQL 18.4, 2026-11-10).

| Per unchanged refresh | Before (SQLite / PostgreSQL) | After (SQLite / PostgreSQL) |
|---|---|---|
| Requests | 2 | 2 |
| SQL statements | 20 | 20 |
| JSON produced | 419,938 bytes | 419,938 bytes |
| Body sent to the browser | 419,938 bytes | 0 bytes (two 304s) |
| Median server time | 9.06 / 21.18 ms | 9.84 / 23.10 ms |

Each refresh returns two pages totaling 100 messages; all 40 refreshes were byte-identical. Server work was small; the repeated cost was the transfer and parsing of identical history: about 16.8 MB per minute while a reply was active and 25.2 MB per minute during compaction in this fixture.

## Change

History responses carry an `ETag` that hashes the full response body after authorization, ownership and account checks. The page keeps the last parsed response for each history URL in memory for the current session and sends `If-None-Match`; the server answers `304 Not Modified` with no body when the hash matches, and the page reuses its copy. Any change to the projected history, including in-place edits, attachment delivery, action progress, read position, live drafts or account details, changes the hash and produces a full `200` response.

The database queries and projection are unchanged, so freshness and privacy follow the existing rules. Responses remain `Cache-Control: no-store`; the browser cache never stores them, and the in-page copies are discarded when the session or account changes. Hashing and conditional-response handling added about 0.8–1.9 ms per refresh in this run; timings vary between runs. A schema-based change token was not added: messages have no update timestamp, and adding one would require covering every writer.
