# AI Telegram Bot — Implementation Spec (TypeScript + grammY + Codex App Server)

This document is a complete implementation spec, written to be executed by an AI agent without further research. All Telegram Bot API 10.1 facts below were verified against core.telegram.org on 2026-06-11/12 (they are newer than typical model knowledge — trust this doc over memory).

## 1. Context & Goals

Build a personal AI assistant Telegram bot:

- **Streaming** via Bot API 10.1 `sendRichMessageDraft` with native `<tg-thinking>` block; a 2-sentence delay buffer demotes pre-tool-call text into thinking; toggleable (`/stream`) to wait-then-send mode.
- **Full Telegram markdown**: final answers and streamed drafts use Rich Messages (GFM: headings, tables, task lists, footnotes, LaTeX, spoilers, 32,768-char limit). Long answers collapse the tail in a `<details>` "Show more" block. Markdown errors are **repaired and retried**, never silently degraded.
- **Memory**: hierarchical hybrid memory — rolling summarization + retrieval-augmented context (OpenRouter embeddings + DB full-text search). Context-limit UX with a [Compact] button; clean new threads are created through Telegram topics. Tools let the model search the thread and reload any past message even after compaction.
- **Files**: txt, csv, pdf, docx, images only. pdf/docx extracted by docling-serve (Docker). Small files inline; big files get chunked + in-file search tools. Images stay in context until compaction, then short descriptions only (reloadable via tool).
- **Web search** tool via Tavily.
- **Threads**: Telegram topics in the private bot chat; `/fork` opens a new topic carrying context.
- **Onboarding**: invite codes (single admin via env), deep-link start, language picker (ru/en), `/lang`, `/timezone` (12/24h time → UTC offset).
- **DB**: PostgreSQL in production, SQLite for development — same codebase, switched by `DB_URL`.

## 2. Verified Telegram Bot API 10.1 facts (do not re-research; trust these)

1. **`sendMessageDraft`** (since 9.3): params `chat_id` (Integer, private chats only), `message_thread_id?`, `draft_id` (Integer, required, non-zero; updates with the same id are animated), `text` (0–4096 chars; empty string ⇒ native "Thinking…" placeholder), `parse_mode?`, `entities?`. Returns `True`. **A draft is an ephemeral ~30-second preview overlay in the chat; it is NOT a message. To persist content you call normal `sendMessage`/`sendRichMessage`; the draft disappears on its own.** There is no editMessage/delete involved.
2. **`sendRichMessageDraft`** (10.1): params `chat_id` (private), `message_thread_id?`, `draft_id` (same semantics), `rich_message` (InputRichMessage). Returns `True`. Same ephemeral lifecycle; finalize with `sendRichMessage`.
3. **`sendRichMessage`** (10.1): params `business_connection_id?`, `chat_id`, `message_thread_id?`, `direct_messages_topic_id?` (channels only — do not use), `rich_message` (InputRichMessage), `disable_notification?`, `protect_content?`, `message_effect_id?`, `suggested_post_parameters?`, `reply_parameters?`, `reply_markup?`. Returns the sent `Message`.
4. **`InputRichMessage`**: `{ markdown?: string; html?: string; is_rtl?: boolean; skip_entity_detection?: boolean }` — exactly one of `markdown`/`html`. Telegram parses the string server-side into blocks. **Rich Markdown is GFM-compatible** and may embed whitelisted HTML tags.
   - Markdown syntax verified: `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strike~~`, `` `code` ``, ```` ```lang ```` fences, `==marked==`, `||spoiler||`, `[text](url)`, `![](media-url "caption")` (separate block only), `# … ######` headings, `---`, `-`/`*`/`+` lists, `1.` lists, `- [ ]`/`- [x]` task lists, `>` blockquotes, GFM pipe tables (cells: inline formatting only, ≤20 cols), footnotes `[^id]` + `[^id]: def`, `$inline$` and `$$block$$` LaTeX, custom emoji `![](tg://emoji?id=…)`, time `![label](tg://time?unix=…&format=wDT)`.
   - Embeddable HTML (whitelist, used by mdRepair): `b strong i em u ins s strike del code pre mark sub sup tg-spoiler a img video audio figure figcaption cite blockquote aside details summary h1..h6 p footer hr ul ol li table caption tr th td tg-emoji tg-time tg-math tg-math-block tg-map tg-collage tg-slideshow tg-reference br` (+ `<a name="x">` anchors). Named entities limited to `&lt; &gt; &amp; &quot; &apos; &nbsp; &hellip; &mdash; &ndash; &lsquo; &rsquo; &ldquo; &rdquo;`; numeric entities OK.
5. **Thinking block**: `<tg-thinking>…</tg-thinking>` (`RichBlockThinking{type:'thinking', text:RichText}`) — **valid ONLY inside `sendRichMessageDraft` content; never in final messages** (API rejects/cannot receive it). Renders the native AI "Thinking…" UI. Custom emoji from `t.me/addemoji/AIActions` recommended inside.
6. **"Show More" / expandable**: `<details><summary>Title</summary>…rich blocks…</details>` (`RichBlockDetails{summary, blocks, is_open?}`) — collapsed by default; `<details open>` to expand. Body may contain full rich markdown (blank line after `<summary>` line, then markdown, then `</details>`). This is the Bot API 10.1 expandable mechanism (legacy alternative for plain messages: `expandable_blockquote` entity / `**>` MarkdownV2 syntax — not needed here).
7. **Rich limits**: 32,768 UTF-8 chars total, ≤500 blocks, ≤16 nesting levels, ≤50 media, ≤20 table columns. Plain `sendMessage` remains 4,096 chars.
8. **Topics in private bot chats** (9.3/9.4): enable "topic mode" for the bot in **@BotFather** (verify via `getMe().has_topics_enabled`; also `allows_users_to_create_topics`). `createForumTopic(chat_id=<user id>, name, icon_color?, icon_custom_emoji_id?)` works in the private chat and returns `ForumTopic{message_thread_id}`. All send methods + `sendChatAction` accept `message_thread_id` in private chats. Incoming `Message.message_thread_id` (absent = General) and `is_topic_message`. Community-reported 10.0 regression ("message thread not found" 400 in private chats) — wrap thread sends in defensive handling and verify live during E2E.
9. **grammY 1.43.0** targets Bot API 10.0: `sendMessageDraft` is in `@grammyjs/types` 3.27.3; `sendRichMessage*` are NOT (10.1). Call 10.1 methods via `bot.api.raw.<method>(payload as any)` behind our own typed wrapper (`src/telegram/richApi.ts`). When grammY ships 10.1 types, the wrapper body shrinks. Deep-link payload (`/start CODE`): charset `[A-Za-z0-9_-]`, ≤64 chars.
10. **Codex app-server inference**: the bot starts ephemeral Codex app-server threads, sends the rendered system prompt plus conversation transcript, and exposes bot-local tools as dynamic tools. Stream notifications are normalized into text/reasoning/tool events in `normalizeStreamPart()`. OpenRouter REST is used only for embeddings: `POST https://openrouter.ai/api/v1/embeddings` `{model, input: string[]}` → `{data: [{embedding: number[]}]}`.
11. **docling-serve**: Docker `quay.io/docling-project/docling-serve`, port 5001. `POST /v1/convert/source` JSON `{sources:[{kind:'base64', value, filename?} | {kind:'http', url}], options:{to_formats:['md'], table_mode:'accurate', image_export_mode:'placeholder'}}` → JSON containing markdown output (`document.md_content` — confirm exact response field via one curl at implementation time; Swagger at `/docs`). First conversion is slow (model download) — healthcheck + friendly notice.

## 3. Stack, dependencies, scripts

- Node ≥ 22, TypeScript strict (`"type": "module"`, NodeNext), npm.
- **Always install the LATEST available versions** — run `npm install <pkg>@latest` for every dependency at implementation time; do NOT copy version numbers from this document. After install, grep installed `@grammyjs/types` for `sendRichMessage`; if grammY now targets Bot API ≥10.1, use the native typed methods and shrink `richApi.ts` to thin re-exports. Re-run `dev:streamdump` when the Codex app-server event shape changes.
- Runtime: `grammy`, `@grammyjs/conversations`, `@grammyjs/i18n`, `@grammyjs/auto-retry`, `ai` (tool/schema helpers), `@tavily/core`, `zod`, `drizzle-orm`, `pg`, `js-tiktoken`, `csv-parse`, `nanoid`, `date-fns`, `dotenv`.
- Dev: `typescript`, `tsx`, `vitest`, `@types/pg`, `@types/node`.
- `package.json` scripts: `dev` = `tsx watch src/main.ts`; `start` = `node dist/main.js`; `build` = `tsc -p tsconfig.json`; `typecheck` = `tsc --noEmit`; `test` = `vitest run`; `migrate` = `tsx src/db/migrate-cli.ts`; `dev:streamdump` = `tsx scripts/dump-stream-parts.ts` (dev aid for §2.10).
- `docker-compose.yml`: service `docling` (`quay.io/docling-project/docling-serve`, ports 5001:5001, restart unless-stopped) + service `postgres` (image `postgres:17-alpine`, env POSTGRES_DB=aibot/POSTGRES_USER=aibot/POSTGRES_PASSWORD from env, port 5432, named volume) under profile `pg` so SQLite-dev users run only docling: `docker compose up -d docling`.
- `.gitignore`: `node_modules dist data .env`.

## 4. Repository layout

```
ai-tele-bot/
  package.json tsconfig.json .env.example docker-compose.yml .gitignore
  system_prompt.md
  locales/en.ftl locales/ru.ftl
  data/                          # gitignored: sqlite db, downloaded files
  scripts/dump-stream-parts.ts
  src/
    main.ts config.ts logger.ts
    db/{index.ts,types.ts,migrate-cli.ts,migrations/0001_init.ts,
        search.ts,search-sqlite.ts,search-pg.ts,
        repos/{users,invites,threads,messages,files,summaries,embeddings}.ts}
    telegram/{richApi.ts,mdRepair.ts,render.ts,draftStreamer.ts,sentences.ts}
    bot/{router.ts,callbacks.ts,middleware/auth.ts,
         commands/{start,lang,timezone,stream,fork,compact,invite,invites,help}.ts}
    ai/{provider.ts,run.ts,shaper.ts,prompt.ts,
        tools/{index.ts,searchThread.ts,loadMessage.ts,searchInFile.ts,readFileSection.ts,webSearch.ts}}
    memory/{contextBuilder.ts,compactor.ts,retrieval.ts,tokens.ts}
    files/{ingest.ts,docling.ts,chunker.ts}
  test/  (mirrors src; vitest)
```

## 5. Configuration (`src/config.ts`, zod-validated; `.env.example` with all keys)

| Var | Default | Meaning |
|---|---|---|
| `BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_ADMIN_ID` | required | **single** admin user id (number) |
| `DB_URL` | `sqlite:./data/bot.db` | or `postgres://user:pass@host:5432/db` |
| `CODEX_MODEL` | `gpt-5.6-terra` | normal chat model |
| `CODEX_COMPACTION_MODEL` | `gpt-5.4-mini` | compaction summaries and image descriptions |
| `CODEX_SPEED_MODE` | `fast` | `standard|fast`; `fast` maps to Codex `priority` service tier |
| `REASONING_EFFORT` | `low` | Codex effort: `none|minimal|low|medium|high|xhigh` |
| `OPENROUTER_API_KEY` | required | embeddings only |
| `OPENROUTER_EMBEDDING_MODEL` | `perplexity/pplx-embed-v1-0.6b` | retrieval vectors |
| `TAVILY_API_KEY` | required | web search tool |
| `CONTEXT_WARN_RATIO` | `0.85` | limit-UX trigger |
| `DOCLING_URL` | `http://localhost:5001` | Docling server base URL |
| `DOCLING_TIMEOUT_MS` | `300000` | Docling conversion timeout |
| `FILE_INLINE_TOKENS` | `6000` | inline-vs-search threshold |
| `DRAFT_UPDATE_MS` | `0` | draft frame min interval; `0` disables throttling |
| `RECENT_WINDOW_MESSAGES` | `20` | verbatim tail kept after compaction |
| `LOG_LEVEL` | `info` | |

## 6. Database — dual dialect (Postgres prod / SQLite dev)

**Approach**: Drizzle ORM with one small `SqlExecutor` interface; dialect chosen from `DB_URL` (`drizzle-orm/node-sqlite` over Node's built-in `node:sqlite`, or `drizzle-orm/node-postgres` over `pg`). At pg startup run `pg.types.setTypeParser(20, Number)` (int8→number). Portability rules: ids = autoincrement integer pk (sqlite `integer primary key autoincrement`; pg `bigserial` — branch inside migration on dialect); timestamps = epoch **ms** stored as `bigint`(pg)/`integer`(sqlite), typed `number`; booleans = integer 0/1; JSON = `text` columns, (de)serialized in repos. Migrations are explicit SQL in `migrations/0001_init.ts` receiving the dialect name; `npm run migrate` CLI + auto-migrate on boot.

**Tables** (columns abbreviated; all have `created_at`):

- `users(tg_id PK bigint, first_name text, username text NULL, lang text 'en'|'ru', tz_offset_min int NULL, stream_mode int 1, invited_with text NULL)` — admin is NOT a row flag; admin = `tg_id === config.TELEGRAM_ADMIN_ID`. Multi-step dialog state lives in the conversations plugin (in-memory storage is acceptable for these short flows) — no state column.
- `invites(code PK text, max_uses int, used_count int 0, expires_at bigint NULL, revoked int 0, created_by bigint)`
- `threads(id PK, user_id, topic_id int NULL /* telegram message_thread_id; NULL = General */, parent_thread_id NULL, fork_point_message_id NULL, title text, meta_summary text NULL, compacted_upto_message_id NULL, archived int 0)` — *(chat history container; a manually created Telegram topic gets a fresh row, while `/fork` creates a child row carrying context)*
- `messages(id PK, thread_id, role text 'user'|'assistant', kind text 'text'|'image'|'file'|'system', content_json text /* ModelMessage-shaped parts */, text_plain text /* for search/snippets */, thinking text NULL /* assistant: final thinking log */, tg_message_id bigint NULL, tokens_est int)`
- `files(id PK, user_id, thread_id, message_id, type 'txt'|'csv'|'pdf'|'docx'|'image', name, path /* data/files/<uuid>.<ext> */, size int, content_md text NULL, summary text NULL, outline_json text NULL, is_inline int)`
- `file_chunks(id PK, file_id, idx int, heading_path text, content text)`
- `summaries(id PK, thread_id, level int 0|1, from_message_id, to_message_id, content text)`
- `embeddings(id PK, kind 'message'|'chunk'|'summary', ref_id bigint, dim int, vector bytea/blob /* Float32 LE */)` + unique(kind, ref_id)

**Full-text search abstraction** (`db/search.ts`):
```ts
interface TextSearch {
  indexMessage(id: number, threadId: number, text: string): Promise<void>;
  indexChunk(id: number, fileId: number, text: string): Promise<void>;
  removeMessage(id: number): Promise<void>;
  searchMessages(threadIds: number[], q: string, limit: number): Promise<Array<{id: number; snippet: string; rank: number}>>;
  searchChunks(fileIds: number[], q: string, limit: number): Promise<Array<{id: number; snippet: string; rank: number}>>;
}
```
- SQLite impl: standalone FTS5 tables `messages_fts(text, message_id UNINDEXED, thread_id UNINDEXED)` / `chunks_fts(text, chunk_id UNINDEXED, file_id UNINDEXED)`; rank `bm25()`, snippets via `snippet(…, '…', 24)`; sanitize query (wrap terms in double quotes, OR-join) to avoid FTS syntax errors.
- PG impl: side tables `message_search(message_id PK, thread_id, ts tsvector)` / `chunk_search(chunk_id PK, file_id, ts tsvector)` with GIN index; `to_tsvector('simple', text)` (language-neutral for ru/en), query `websearch_to_tsquery('simple', q)`, rank `ts_rank`, snippet `ts_headline('simple', …)`.
- Indexing is called explicitly by repos after inserts (no triggers — keeps dialects symmetric).

**Embeddings**: Float32Array → Buffer (LE) blobs; cosine similarity computed in JS over candidate sets (a personal bot's scale — thousands of rows — is fine brute-force; do NOT require pgvector/sqlite-vec).

## 7. Telegram layer

### 7.1 `richApi.ts`
TS types for `InputRichMessage`, `SendRichMessageParams`, `SendRichMessageDraftParams` (per §2). Functions: `sendRich(api, params): Promise<Message>`, `sendRichDraft(api, params): Promise<boolean>` calling `api.raw.sendRichMessage(...)` / `api.raw.sendRichMessageDraft(...)` (cast; grammY raw passes unknown methods through). Also `isThreadNotFound(err)`, `isRichParseError(err)` helpers reading `GrammyError.description`.

### 7.2 `mdRepair.ts` — fix markdown, never drop content
Pure functions, heavily unit-tested:
- `closeOpenStructures(md): string` — for draft frames: append missing ``` for an odd number of fences; close unclosed `<details>`/`<summary>`; if the text ends inside a table row, trim the incomplete trailing line; never leave a dangling unclosed inline tag from the whitelist (close or escape it).
- `sanitize(md): string` — proactive pass before ANY rich send: balance fences; escape ALL `<tag>`s **not** in the §2.4 whitelist as `&lt;tag&gt;` (content preserved, visible); normalize tables (pad/trim cells to header column count; cap 20 columns by merging extras into the last cell); strip `<tg-thinking>` outside drafts; orphan footnote refs `[^x]` without definitions → leave as plain text `[^x]` escaped; collapse >16-deep nesting by flattening quotes/lists beyond depth 16; enforce 32,768 chars (split handled by render).
- `repairLadder(md): string[]` — escalating variants for reactive retry after a 400 parse error: `[ sanitize(md), escapeAllHtml(md) /* pure GFM, all tags shown as text */, neutralizeExotics(md) /* LaTeX→```math fence, footnotes→(inline notes), ==mark==→**bold** */, fenceWholeBlocks(md) /* offending paragraphs (found by bisecting halves) wrapped in code fences */ ]`. Caller walks the ladder; **plain-text chunked `sendMessage` is the final fallback and is expected never to trigger** — log loudly if it does.

### 7.3 `render.ts` — final message composition
`renderFinal({thinkingLog, answerMd, i18n}): InputRichMessage[]`:
1. Build thinking section if `thinkingLog` non-empty: `<details><summary>🧠 {t('thinking-summary', {steps, tools})}</summary>\n\n{thinkingLog (keep the LAST ~8000 chars, '…'-prefixed when truncated)}\n\n</details>\n\n`.
2. Answer: `sanitize(answerMd)`. If `answerMd.length > 3500 chars`: cut at the last paragraph/block boundary (never inside a fence/table — scan with the same block parser as the chunker) before the threshold; visible head + `\n\n<details><summary>{t('show-more')}</summary>\n\n{tail}\n\n</details>`.
3. If combined doc > 32,768 chars: split into multiple `InputRichMessage`s at top-level block boundaries (each part re-runs step 2's Show-more logic only for the last part; code fences re-opened with same language across parts).
4. Send each part via `sendRich`; on `isRichParseError` walk `repairLadder`; record the final `tg_message_id`(s).

### 7.4 `draftStreamer.ts`
One instance per in-flight response. State: `draftId` (allocated once: `(Date.now() & 0x7fffffff) || 1`), `lastSentAt`, `lastPayloadHash`, timer.
- `update({thinkingMd, answerMd})` — called by the run loop on every shaper change; coalesces: send at most every `DRAFT_UPDATE_MS`; skip if payload unchanged.
- Keepalive: while a tool call runs (no content changes), re-send the last payload every 20 s (drafts expire ~30 s).
- Frame payload (full rich markdown in drafts):
  ```
  <tg-thinking>{tail(thinkingMd, 3000)}</tg-thinking>

  {closeOpenStructures(answerMd)}
  ```
  The `<tg-thinking>` block is included when `thinkingMd` is non-empty OR the answer is still empty (initial frame = localized "Thinking…" line); once answer text streams and the thinking log is empty, frames carry the answer only. If a draft frame 400s: retry once with `repairLadder[1]` applied to the answer part; otherwise drop the frame (next tick supersedes; drafts are best-effort).
- `stop()` — clear timers; final `sendRichMessage` simply supersedes the preview.
- Stream-OFF mode replaces the streamer with a `sendChatAction('typing', {message_thread_id})` loop every 5 s.

### 7.5 `sentences.ts`
`class SentenceAssembler { push(delta: string): void; completed: string[]; remainder: string }`
- A "sentence" ends at `. ! ? …` followed by whitespace/EOL, or at a blank line (paragraph break), or at a closed code fence.
- Never split inside an open ``` fence (the whole fence is one sentence; fence close = boundary). Never split inside `$$…$$`.
- Guard common false positives: digit-dot-digit (`3.14`), single-letter initials, `e.g.`, `i.e.`, `т.д.`, `т.п.`, URLs.
- Markdown-aware enough only for fences/blank lines; no full parse.

## 8. AI layer

### 8.1 `provider.ts`
Export `embed(texts: string[]): Promise<Float32Array[]>` — direct `fetch` to OpenRouter `/api/v1/embeddings`, batched ≤96 inputs, retry 429/5xx ×3 with backoff. OpenRouter is not used for chat, image captioning, or compaction.

**Context size** — `getContextBudget(): Promise<number>` resolution order:
fixed Codex default `128000`.
All token budgeting (§9.1) calls this instead of reading config directly.

### 8.2 `shaper.ts` — the 2-sentence delay state machine (pure; the spec's core)
```ts
type ThinkingItem = {kind: 'reasoning'|'demoted'|'tool'|'tool-result', text: string};
class StreamShaper {
  thinking: ThinkingItem[] = [];
  private seg = new SentenceAssembler();        // current text segment (since last tool boundary)
  onReasoningDelta(t) { /* append/merge into last 'reasoning' item */ }
  onTextDelta(t)      { this.seg.push(t); }
  onToolCall(name, args) {
    const txt = this.seg.completed.join('') + this.seg.remainder;
    if (txt.trim()) this.thinking.push({kind: 'demoted', text: txt});   // ALL segment text → thinking
    this.thinking.push({kind: 'tool', text: `${name}(${compactJson(args, 120)})`});
    this.seg = new SentenceAssembler();
  }
  onToolResult(name, summary) { this.thinking.push({kind: 'tool-result', text: summary}); }
  visibleAnswer(): string {     // streamed answer = all but the LAST 2 completed sentences
    const s = this.seg.completed;
    let out = s.slice(0, Math.max(0, s.length - 2)).join('');
    if (insideOpenFence(this.seg.remainder)) out += this.seg.remainder; // show long code live; frame auto-closes it
    return out;
  }
  finalAnswer(): string { return this.seg.completed.join('') + this.seg.remainder; } // entire last segment
  thinkingMd(): string {  // 🧠 reasoning · ❝demoted❞ as blockquote · 🔧 tool lines · ✓ result lines
    /* reasoning plain; demoted wrapped in '>' quotes; tool: `🔧 name(args)`; result: `✓ …` */ }
}
```
Spec rules → behavior mapping: (a) draft answer lags 2 sentences (`visibleAnswer`); (b) any text generated before a tool call — even >2 sentences already shown — moves wholesale into thinking (`onToolCall` demotion; the next draft frame visibly relocates it); (c) reasoning deltas and tool activity always render inside thinking; (d) at `finish`, the whole last segment becomes the answer — so a ≤2-sentence final reply IS shown as the result.

### 8.3 `run.ts` — orchestration
`runTurn({user, thread, userMessage, attachments}): Promise<void>`
1. Persist incoming user message (+files) via repos; index FTS; embed `text_plain` (fire-and-forget batch).
2. `contextBuilder.build()` (§9.1). If over budget → context-limit UX (§9.3) and return.
3. Create `StreamShaper` + `DraftStreamer` (or typing loop). `streamCodexTurn({config, system, messages, tools: buildToolRegistry(ctx), abortSignal: AbortSignal.timeout(300_000)})`.
4. Iterate `fullStream` through `normalizeStreamPart()` → shaper events; after each event call `draft.update({thinkingMd: shaper.thinkingMd(), answerMd: shaper.visibleAnswer()})`.
5. On `finish`: `render.renderFinal({thinkingLog: shaper.thinkingMd(), answerMd: shaper.finalAnswer()})`, send (thread-scoped), persist assistant message `{content_json: finalAnswer, thinking, tokens_est, tg_message_id}`, index + embed.
6. Usage from finish event → log; if provider threw context-length error (APICallError whose body matches `/context|maximum.*tokens|too (many|long)/i`) → limit UX.
7. Errors: localized `error-generic` message with the description in a `<details>`; always `draft.stop()` in `finally`.
- **Concurrency**: per-thread in-memory mutex; if busy, store the message in DB anyway and reply localized `busy` notice (it will be in context next turn); do not queue runs.
- **Image reload flow** (used by `load_message` on image messages): tool results can include Codex `inputImage` content items built from cached bytes or Telegram redownload, so compacted images remain reloadable.

### 8.4 Tools (`ai/tools/*`; each tool has a zod input schema, execute handler, AI SDK helper wrapper for local checks, and Codex dynamic-tool spec conversion)
- `search_thread({query: z.string(), limit: z.number().max(20).default(8)})` → hybrid retrieval (§9.4) over the thread chain's messages + L0 summaries + chunks of files attached in the chain → `[{message_id, role, date_iso, snippet}]`.
- `load_message({message_id: z.number()})` → full `text_plain` (cap 8,000 chars with a note) + metadata; image messages → image-reload flow (§8.3). Validates the message belongs to this user's thread chain.
- `search_in_file({file_id: z.number(), query: z.string(), limit: z.number().max(20).default(8)})` → FTS+embeddings over that file's chunks → `[{chunk_index, heading_path, snippet}]`.
- `read_file_section({file_id: z.number(), chunk_index: z.number(), count: z.number().max(8).default(1)})` → concatenated chunk content; `chunk_index:-1` → outline (headings + chunk map).
- `web_search({query: z.string(), max_results: z.number().max(10).default(5)})` → `@tavily/core` `tavily({apiKey}).search(query, {maxResults, searchDepth:'basic', includeAnswer:false})` → `[{title, url, snippet, published_date?}]`; errors → `{error}` string result (model can react).

### 8.5 `prompt.ts` + `system_prompt.md`
Root file, hot-loaded each turn (fs.readFile, no restart needed), placeholders `{{user_name}} {{language}} {{timedate}} {{timezone}} {{thread_title}} {{files_overview}}` replaced via simple `.replaceAll`. `{{timedate}}` = `YYYY-MM-DD HH:mm` computed from `tz_offset_min` or UTC when missing; `{{timezone}}` = `UTC±HH:MM` from `tz_offset_min` or `UTC+00:00` when missing; `{{files_overview}}` = bullet list of this thread's files `(#id name type · inline|searchable · summary-first-line)`.
Starter content (write it): assistant persona; ALWAYS answer in `{{language}}`; output GitHub-flavored Markdown only (headings/tables/lists/fences/footnotes/LaTeX allowed; no raw HTML); use `search_thread`/`load_message` before claiming something wasn't discussed; use `search_in_file` for large files instead of guessing; use `web_search` for current events; keep answers concise unless asked.

## 9. Memory

### 9.1 `contextBuilder.build({user, thread, newUserParts})` → `{system, messages, tokensEst}` 
Assembly order:
1. `system` = rendered system_prompt.md.
2. Meta summaries: walk the fork chain root→current; for each thread with a `meta_summary`, append a system-role context block `«Conversation memory (compacted): {meta_summary}\n\nSection index: {one line per L0 summary: [msgs X–Y] first sentence}»`.
3. Auto-RAG: embed the new user text; hybrid-retrieve top 6 snippets from compacted-range messages/summaries/file chunks (skip if the chain was never compacted and all files are inline); append system block `«Recalled context (verify with load_message): - [msg #id, date] snippet …»`.
4. Verbatim window: the chain's messages (ancestors capped at their `fork_point_message_id`) with `id > compacted_upto_message_id`; **if never compacted, ALL chain messages are included** (`RECENT_WINDOW_MESSAGES` is only the tail that compaction PRESERVES, not a standing window). Oldest-first, proper ModelMessages from `content_json`. Image messages: include actual image parts (read file from disk → base64) only if not compacted; compacted images appear inside summaries as short descriptions.
5. New user message: text + inline file blocks (§10) + image parts.
Token estimate: js-tiktoken `o200k_base` over text + 1,100/image; if `> (await getContextBudget() − 10000) × CONTEXT_WARN_RATIO` → signal over-budget (caller shows limit UX; the message is already persisted, so post-compaction auto-retry needs no extra state — see §9.2).

### 9.2 Context-limit UX
Localized message `ctx-limit` + inline keyboard `[🗜 {t('btn-compact')}]`, callback_data `ctx:compact`. The message should also say that a clean thread can be started by creating a new Telegram topic.
- `ctx:compact` (and `/compact`) → status message `compacting…` → run compactor → edit to `compacted` summary stats → **auto-retry rule**: if the thread's latest non-image user message has no assistant reply after it, run that turn now (no extra state needed — it was persisted before the limit hit).

### 9.3 `compactor.compact(thread)` — hierarchical rolling summarization
1. Range = the thread chain's messages (message ids are globally ordered, so ancestors-up-to-fork-point and own messages form one ordered list) with `id > compacted_upto_message_id`, excluding the newest `RECENT_WINDOW_MESSAGES`. No-op if < 10 messages. (For forks this naturally summarizes inherited parent context into the fork's own memory; `compacted_upto_message_id` may point at an ancestor's message id.)
2. Split range into ~3,500-token groups at message boundaries. For each group → LLM call (same chat model, `reasoning effort: none`, temp 0): structured summary prompt: *"Summarize this conversation segment. Keep: decisions, facts, names, numbers, file references (#file-id), open questions. For images keep lines like [image #msg-id: short description]. Cite source message ids like [#123]. ≤300 words."* → insert `summaries(level=0, from,to,content)` + FTS-index + embed.
3. Meta: LLM merge of previous `meta_summary` + new L0 summaries → *"Merge into a single rolling conversation memory, ≤400 words, most-recent-relevant first"* → update `threads.meta_summary`. (No embedding for the meta summary — it is always present in context; only L0 summaries are embedded/searchable.)
4. Images in range get one short description during compaction, stored in `files.summary` and preserved by the L0 prompt; the context builder stops attaching image bytes once compacted.
5. Set `compacted_upto_message_id` = end of range. Original messages remain in DB/FTS/embeddings — `search_thread`/`load_message` still reach them (this is the post-compaction search guarantee).

### 9.4 `retrieval.ts`
`hybridSearch({scope, query, k})`: (1) embed query (1 call); cosine over candidate embeddings of scope (load vectors for scope ids — keep an in-process LRU of Float32Arrays); (2) `TextSearch.search*` BM25/ts_rank; (3) merge by RRF `score = Σ 1/(60+rank)`; return top-k with snippets (FTS snippet if available else first 200 chars). Scope helpers: `threadChainIds(thread)` walks `parent_thread_id` up to fork points (messages of ancestors limited to `id ≤ fork_point_message_id`).

## 10. Files pipeline (`files/`)

Accept matrix (else localized `file-unsupported`; >20 MB → `file-too-big`, Telegram bot download cap):
- documents by extension/mime: `.txt`, `.csv`, `.pdf`, `.docx` (explicitly refuse legacy `.doc` — docling does not support it; message says "re-save as .docx")
- photos (Telegram `photo`) and image documents: jpg/jpeg/png/webp.

Pipeline (`ingest.ts`): `getFile` → download `https://api.telegram.org/file/bot<token>/<file_path>` → `data/files/<uuid>.<ext>` → branch:
- **txt**: read utf-8 (strip BOM) → `content_md` = raw text.
- **csv**: `csv-parse` (relax_quotes) → header row, row/col count; `content_md` = raw CSV; schema line = `columns: a, b, c · 1,234 rows`.
- **pdf/docx**: `docling.ts` → `POST {DOCLING_URL}/v1/convert/source` `{sources:[{kind:'base64', value, filename}], options:{to_formats:['md'], table_mode:'accurate'}}`, `DOCLING_TIMEOUT_MS` timeout → markdown. Boot healthcheck `GET /docs` (warn-only); per-file failure → localized `docling-down` with compose hint. First-call notice `processing-file` status message (edited to ✅/❌).
- **image**: store only; do not send an image-processed status and do not call vision at upload time. Persist a `kind='image'` user message so the image bytes are available in live context. When that message is later compacted, make one short vision description and store it in `files.summary`.
Size policy for text-bearing files (tokens of `content_md`):
- ≤ `FILE_INLINE_TOKENS`: `is_inline=1`; the user message gets a fenced block: ` ```{type} name=<name>\n<content>\n``` ` (CSV keeps the schema line above the fence).
- bigger: `is_inline=0`; `chunker.ts` — split by markdown headings (build `heading_path` like `H1 > H2`), then recursively split oversized sections to ~450 tokens with 15% overlap; CSV: schema + first 20 rows as the "head" chunk, then row-range chunks `rows 21–520` etc.; insert `file_chunks`, FTS-index + embed each; generate outline (`outline_json` = heading tree with chunk indexes) + ≤150-token auto-summary (LLM) → the user message gets a **file card** instead of content: `📎 name (type, size, N chunks) · summary · «Use search_in_file(file_id=…) / read_file_section» · outline (top 2 levels)`.
Caption text on the file message is kept as the user's text part. Image-only media groups are stored as context and still run an assistant turn; mixed media groups process the non-image files and include images as context.

## 11. Bot UX — commands, flows, routing

### 11.1 Router (`bot/router.ts`)
Only `chat.type === 'private'` (others: one-time localized notice + `leaveChat` for groups). Resolve `(user.tg_id, msg.message_thread_id ?? null)` → active (non-archived) `threads` row, lazy-create (`title` = topic name or "General"). Handlers: text → `runTurn`; non-image documents → ingest then `runTurn` (caption as text); photos/image documents → store as image context then run an assistant turn without upload-time vision processing; edited messages ignored; unsupported media → notice. Global `bot.catch` logs GrammyError/HttpError. `bot.api.config.use(autoRetry())`. Conversations plugin registered for the flows below; callbacks in `callbacks.ts` (`lang:*`, `ctx:*`, `inv:revoke:*`) always `answerCallbackQuery`.

### 11.2 Onboarding & invites (single admin = `TELEGRAM_ADMIN_ID`)
- `auth.ts` middleware: admin → ensure user row exists (auto-provision, lang from `language_code`). Known user → attach to ctx. Unknown user → only the invite flow is reachable.
- `/start <code>` (deep link): validate code: exists, `revoked=0`, `expires_at` null/future, `used_count < max_uses` → create user `{lang: language_code?.startsWith('ru') ? 'ru' : 'en', invited_with: code}`, `used_count++` → welcome flow. Invalid → `invite-invalid` (reason-specific: expired/exhausted/unknown) + prompt to send a code as text.
- `/start` (no payload, unknown): `invite-ask` — the next plain-text message from that tg_id is treated as a code attempt (in-memory `Map<tg_id, 'awaiting_code'>`; the user row doesn't exist yet so no DB state — worst case after a restart they resend the code).
- Welcome flow (new or returning `/start`): message 1 `start-welcome` (lists `/lang /timezone /stream /fork /compact /help`; notes current stream mode and that `/timezone` improves time answers); message 2 `lang-pick` with inline `[Русский](lang:ru) [English](lang:en)`; auto-preselected from `language_code` (ru→ru else en) — the message says which was auto-picked.
- `/invite` (admin only; conversations flow): Q1 code? (`auto` → `nanoid(8)` from alphabet `A-Za-z0-9_-`; custom validated `^[A-Za-z0-9_-]{1,32}$`, unique) → Q2 max uses? (int ≥1, default 1) → Q3 expiry? (`YYYY-MM-DD` parsed with date-fns at 23:59 local, or `never`; default +30 days) → insert → reply with a **forward-ready invite message**: short pitch + `https://t.me/{bot.botInfo.username}?start={code}` + params recap.
- `/invites` (admin): list `code · used/max · expires · status` with `[Revoke]` buttons (`inv:revoke:<code>` → set revoked=1, edit message).
- Non-admin calling admin commands → silent ignore (or `unknown-command` help).

### 11.3 Settings commands
- `/lang` → `lang-pick` keyboard; callback updates `users.lang`, confirms `lang-set`, re-runs `setMyCommands` for that user scope (chat-scoped commands localized).
- `/stream` → toggle `users.stream_mode`, confirm `stream-on`/`stream-off`.
- `/timezone` (conversations): ask `tz-ask` ("What time is it for you right now? e.g. `14:30` or `2:30 PM`"); parse `^(\d{1,2}):(\d{2})\s*(am|pm)?$` case-insensitive (12h: 12 AM→0, 12 PM→12; reject hour>23/minute>59 → `tz-bad-format`, re-ask up to 3×); `offset = round((userMinutes − utcNowMinutes)/15)*15` normalized to (−720, 840]; store `tz_offset_min`; confirm `tz-set` echoing `UTC±HH:MM` and their computed current time.
- `/compact` → §9.2. `/help` → command reference. On boot: `setMyCommands` (default en + `language_code:'ru'` scope ru).

### 11.4 Topics & `/fork`
- `/fork`: requires cached `getMe().has_topics_enabled`; if false → `fork-need-topics` (BotFather → Bot Settings → Topics ON; user may also need `allows_users_to_create_topics` to see UI). Else: source thread = current; `createForumTopic(chat_id, name: "Fork: " + (source.title | date))` → new `threads` row `{topic_id: forumTopic.message_thread_id, parent_thread_id: source.id, fork_point_message_id: max(message.id in source)}` → `sendRich` intro into the new topic (`fork-created`, mentions context carried). Context/retrieval walk the parent chain (§9.4). All outbound sends for a thread pass `message_thread_id: thread.topic_id ?? undefined`; on 400 thread-not-found (§2.8 regression): retry once without thread id and prefix the text with the thread title — log a warning (degraded but functional).

## 12. i18n (`@grammyjs/i18n`, Fluent)
`locales/en.ftl` + `ru.ftl`; locale negotiation: `users.lang` → `from.language_code` ru? → en. Key inventory (create all in both files): `start-welcome, lang-pick, lang-auto-note, lang-set, invite-ask, invite-invalid-unknown, invite-invalid-expired, invite-invalid-exhausted, invite-created, tz-ask, tz-bad-format, tz-set, stream-on, stream-off, thinking-placeholder, thinking-summary, show-more, ctx-limit, btn-compact, compacting, compacted, busy, error-generic, file-unsupported, file-too-big, file-doc-legacy, processing-file, docling-down, fork-created, fork-need-topics, help, private-only, unknown-command`.

## 13. Implementation order (phases with acceptance criteria)

1. **Scaffold**: package/tsconfig/env/config/logger; Drizzle setup + migration 0001 (both dialects); `npm run migrate` works on sqlite AND on `docker compose --profile pg up` postgres. ✓: boot logs "migrated, polling started" with a dummy token failing gracefully.
2. **Onboarding**: auth middleware, invites (create/redeem/list/revoke), `/start` deep link, i18n en/ru, `/lang`, `/help`, setMyCommands. ✓: non-invited user blocked; deep link onboards; language switch persists.
3. **AI core (non-streamed)**: provider, system_prompt.md + prompt.ts, contextBuilder (recent-only), run.ts without draft (typing loop), richApi + mdRepair + render (thinking details omitted when empty, Show-more, 32k split, repair ladder). ✓: chat works; long answer arrives as rich message with collapsed "Show more"; markdown torture prompt renders.
4. **Streaming**: sentences.ts, shaper (TDD against §8.2 mapping), draftStreamer, `/stream` toggle, stream-part normalizer (+ `dev:streamdump` script run once to pin part names). ✓: live tg-thinking draft visible; 2-sentence lag; demotion on tool call (use a stub tool); ≤2-sentence answer appears directly as result.
5. **Memory & tools**: search abstraction (both dialects), embeddings client + storage, search_thread/load_message/web_search, auto-RAG injection, token budgeting, limit UX, compactor, `/compact`, unanswered-turn auto-retry after compaction. ✓: oversized context shows compact button; compact → old content findable via search_thread, answer cites loaded message.
6. **Files**: ingest, docling client + compose service, chunker, file card, search_in_file/read_file_section, image context storage + compaction-time descriptions + post-compaction reload. ✓: each accepted type round-trips; big PDF answered via in-file search; image recalled after compaction via load_message.
7. **Topics/fork + timezone**: §11.4, `/timezone`. ✓: fork inherits context (ask "what did we discuss?" in fork); parallel topics isolated; timezone reflected in `{{timedate}}`/`{{timezone}}` answers.
8. **Hardening**: vitest suites green; README (setup: BotFather topics ON, compose, .env, npm run dev); final E2E checklist pass.

## 14. Verification

- **Unit (vitest)**: sentences (fences, `3.14`, `e.g.`, `т.д.`, blank-line breaks); shaper — (a) 1-sentence answer → finalAnswer intact, thinking empty; (b) 5 sentences then tool-call → all 5 demoted, visibleAnswer empty after reset; (c) reasoning+2 tools ordering in thinkingMd; (d) promotion lag exactly 2; (e) text→tool→3-sentence final → final = last segment only; mdRepair — unclosed fence, unknown tag escaped-not-dropped, ragged table normalized, ladder order, 16-deep nesting flattened; render — show-more boundary not inside fence/table, 32k split, summary counts; timezone parser (24h/12h/AM-PM edges/wrap); invite validation (expired/exhausted/revoked/charset); chunker (heading paths, overlap, CSV row ranges); RRF merge determinism.
- **Integration**: scripted fake fullStream (fixture part sequences incl. tool calls) through run loop with a mock Api recording calls → assert exact draft frame sequence (payloads, ≥DRAFT_UPDATE_MS spacing logic via fake timers, keepalive frame) and final message markdown; repos round-trip on sqlite; compactor with stubbed LLM; tavily tool with mocked client.
- **Manual E2E checklist** (real token; topics enabled; `docker compose up -d docling`; sqlite first, then once with `--profile pg` + pg `DB_URL`): invite → deep-link start → lang picker (auto-ru note) → `/timezone` 12h and 24h → streamed reply (tg-thinking visible, answer lags, final has collapsed 🧠 Thinking) → web-search prompt ("what happened in tech news today?") showing 🔧 lines + demotion → `/stream` off mode → markdown torture prompt → long answer "Show more" → txt/csv/docx/pdf small+large (search_in_file used) → `.doc` refused with hint → image upload stores context and answers → `/compact` → "what was in the image?" (short description) → "show me the image details again" (load_message reload) → oversized context limit buttons both paths → `/fork` context carry-over + isolation → `search_thread` finds pre-compaction facts → kill docling mid-file → friendly error.

## 15. Risks & notes for the implementer

- All deps are installed `@latest` (§3). If the installed grammY still lacks Bot API 10.1 types, all rich calls live behind `richApi.ts` via `api.raw`; if it has them, use native methods. `sendMessageDraft` is typed since types 3.27 (unused — we use rich drafts everywhere).
- Codex app-server event shapes may drift — pin exact names once via `dev:streamdump`, keep `normalizeStreamPart()` as the only place that knows them.
- Codex may not emit reasoning deltas for every model; the thinking block still fills with tool lines + demoted text.
- `CODEX_COMPACTION_MODEL` must support image input for compaction-time image descriptions. If compaction cannot describe an image, the summary falls back to the file name and logs a warning.
- Draft cadence: 1.5 s + autoRetry handles flood control; drafts expire ~30 s → 20 s keepalive during long tool runs; a failed draft frame is non-fatal by design.
- Private-chat `message_thread_id` 10.0 regression report → defensive retry path in §11.4; verify live early in phase 7.
- Docling cold start downloads models on first convert → status message + `DOCLING_TIMEOUT_MS` timeout; document `docker compose up -d docling` prominently in README.
- pg specifics: int8 parser at boot; `websearch_to_tsquery('simple', …)` keeps ru/en symmetric with the FTS5 behavior; no pgvector dependency (JS cosine).
- Never let `<tg-thinking>` reach a final message; never let unknown HTML reach Telegram unescaped (mdRepair owns both invariants).
