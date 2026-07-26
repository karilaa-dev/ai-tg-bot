# Pi-first architecture

Pi 0.80.6 is the sole agent backbone. Telegram threads own persistent Pi `AgentSession`s; helper work uses isolated in-memory sessions. Pi owns the tool loop, session JSONL, branching, cancellation, retry behavior, and built-in compaction.

## Inference

- Internal models: `telegram-auto/main` and `telegram-auto/helper`.
- Primary: Pi `openai-codex` with OAuth.
- Fallback/always-on without Codex: Pi `openai-completions` through OpenRouter.
- Shared circuit: main, helper, and image calls.
- Fallback is allowed only before visible output and only for retryable provider/auth/network failures.
- Newly observed implicit Telegram topics are titled once in a background, tool-free helper session from the bounded opening exchange; explicit, forked, and General titles remain authoritative.

## Tools and retrieval

Pi host filesystem tools are disabled. Project-scoped Pi tools expose just-bash, Telegram file creation, Tavily search/extract, explicit conversation/file retrieval, and image generation. Prior messages use FTS-only retrieval; chunked large documents add vector retrieval behind the explicit search tools. Query embeddings are skipped unless current-model chunk vectors exist. There is no rolling summary store, summary embedding, context builder, token estimator, or automatic RAG injection.

## Images

The project-owned `generate_image` Pi extension supports one image, generate/edit/auto mode, PNG/JPEG/WebP output, caption, and up to five current-thread Telegram references. Codex uses hosted Responses image generation; OpenRouter uses its image API. Generated originals are persisted in managed file storage and delivered immediately; Pi JSONL and database rows retain metadata and references, not raw bytes or base64.

## Persistence

Pi JSONL is conversation-authoritative. Database messages retain Telegram/search/attachment metadata and Pi entry mappings. Thread rows retain title source, attempt count, and Telegram synchronization state. Startup initializes the current schema in an empty SQLite database or PostgreSQL schema; no cross-release data conversion is provided. Telegram is the access-control boundary.

## Acceptance checks

- Provider routing/circuit behavior, including missing Codex, quota fallback, non-fallback errors, aborts, and partial output.
- Session persistence/reopen, context sizing, compaction, entry mapping, branching, cancellation, and tool continuation.
- Telegram-backed image references, Codex/OpenRouter parity, fallback, delivery/reuse, durable generated originals, and no raw image bytes in Pi JSONL or database rows.
- FTS-only message retrieval plus hybrid file-chunk retrieval with fork scoping and no summary/auto-RAG path.
- SQLite schema idempotency and optional PostgreSQL schema initialization.
- Typecheck, unit/integration suite, build, and optional live provider/Telegram smoke checks.
