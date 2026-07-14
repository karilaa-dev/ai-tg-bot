# Pi-first architecture

Pi 0.80.6 is the sole agent backbone. Telegram threads own persistent Pi `AgentSession`s; helper work uses isolated in-memory sessions. Pi owns the tool loop, session JSONL, branching, cancellation, retry behavior, and built-in compaction.

## Inference

- Internal models: `telegram-auto/main` and `telegram-auto/helper`.
- Primary: Pi `openai-codex` with OAuth.
- Fallback/always-on without Codex: Pi `openai-completions` through OpenRouter.
- Shared circuit: main, helper, and image calls.
- Fallback is allowed only before visible output and only for retryable provider/auth/network failures.

## Tools and retrieval

Pi host filesystem tools are disabled. Project-scoped Pi tools expose just-bash, Telegram file creation, Tavily search/extract, explicit conversation/file retrieval, and image generation. Message/file-chunk embeddings plus FTS remain available only behind retrieval tools. There is no rolling summary store, summary embedding, context builder, token estimator, or automatic RAG injection.

## Images

The project-owned `generate_image` Pi extension supports one image, generate/edit/auto mode, PNG/JPEG/WebP output, caption, and up to five current-thread Telegram references. Codex uses hosted Responses image generation; OpenRouter uses its image API. Image bytes are transient and never enter Pi JSONL or persistent disk storage.

## Persistence and migration

Pi JSONL is conversation-authoritative. Database messages retain Telegram/search/attachment metadata and Pi entry mappings. The idempotent `pi_cutover_v2` migration preserves users, invites, and just-bash workspaces while deleting the legacy conversation graph, summary schema, embeddings, search rows, and managed files.

## Acceptance checks

- Provider routing/circuit behavior, including missing Codex, quota fallback, non-fallback errors, aborts, and partial output.
- Session persistence/reopen, context sizing, compaction, entry mapping, branching, cancellation, and tool continuation.
- Telegram-backed image references, Codex/OpenRouter parity, fallback, delivery/reuse, and no persisted bytes.
- Message/chunk vector and lexical retrieval with fork scoping and no summary/auto-RAG path.
- SQLite cutover idempotency, optional PostgreSQL cutover integration, and preservation/cleanup guarantees.
- Typecheck, unit/integration suite, build, and optional live provider/Telegram smoke checks.
