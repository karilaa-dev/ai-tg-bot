# Codebase simplification at 2.0.5

Baseline: `af793e2` (`Improve agent runtime and file delivery`). This continues the same PR at 2.0.5. Dependencies, configuration, database schema, prompt, approved skills, and sandbox image inputs are unchanged. The released `ai-tg-bot-tools:v2.0.5` image remains applicable.

## Ownership and interfaces

- `files/outgoingFiles.ts` owns each turn's attachments, capacity checks, replacement slots, partial repair, export reservations, ingestion, and cleanup. Workspace exports keep E2B recovery sources; browser downloads and generated images keep temporary spools until delivery. Attachment types now belong to `files/`.
- `ai/responseDelivery.ts` owns final persistence, text delivery, ordered attachment preparation, and delivery outcomes. One batching algorithm and byte loader serve all attachment origins, including generated images. Two preparation workers share the existing 40 MiB budget with uploads.
- `pi/threadBridge.ts` owns turn context and attachments; `pi/runtime.ts` manages sessions. `TurnFinalizer` uses explicit phases, including confirmed sends whose database write needs retry. The unused pending-file path and historical runner barrel are removed.
- `ThreadE2BSandboxRuntimeManager` owns sandbox lifecycle and serialization directly. The old pool is removed; command execution, file materialization, and website publication are internal operations without forwarding classes. Browser session ownership and its user lock remain together, with page inspection/rendering extracted.
- Visibility uses scoped message/file ID projections with the existing fork cutoffs. Current-turn attachments and live source-availability checks remain in place. Unused types, exports, and the vector-cache reset hook are removed.

## Size and database work

| Measure | Baseline | After |
| --- | ---: | ---: |
| Nonblank production TypeScript lines | 18,737 | 18,144 |
| Top-level production exports | 383 | 359 |
| Emitted JavaScript bytes | 515,039 | 504,734 |
| Production source files | 111 | 115 |
| Visibility queries, six-level fork fixture | 13 | 7 |
| Returned visibility data, JSON bytes | 168,078 | 1,994 |
| Queries returning message bodies for visibility | 6 | 0 |

The reduction is 593 nonblank production lines and 10,305 emitted JavaScript bytes. Four additional files expose ownership boundaries. Emitted size uses esbuild with TypeScript removal and whitespace minification only, so source formatting and moving code do not account for the reduction. Counts cover `src/**/*.ts`; tests, scripts, and documentation are excluded.

The visibility fixture contains six nested threads, 20 messages per thread, two files per thread, and a cutoff after each thread's eleventh message. Returned scopes are exactly equal. Reproduce it with `node --import tsx scripts/benchmark-visibility.ts [checkout-path]`. New SQLite/PostgreSQL tests also assert that a two-level fork takes three queries and returns no message or file bodies when building visibility.

## Behavioral validation

Typecheck, build, and all **437 tests across 55 files passed**, with PostgreSQL 18 enabled and no skipped tests. Validation ran after unused-code removal, file/delivery consolidation, runtime cleanup, and query changes.

The 42 existing CAD/delivery/buffer scenarios passed against the baseline and their updated interfaces. Their deterministic traces retain:

- Four Pi cycles: skill read → preview build/inspection → final build/inspection → `finish_response`; one STL and the exact final photo.
- Preparation while final text is blocked, followed by text before attachments.
- A document upload overlapping preparation of the next two photos, then the photo album before the last document. No repeated downloads.
- Two workers, the 40 MiB budget, and blocked prefetch when an active upload consumes the available budget.
- Replacement order, partial repairs, captions, album rejection fallback, cancellation, ambiguous acknowledgments, and persistence retry after confirmed sends.

Additional tests cover repair across `finish_response` and `create_file`, cleanup after cancellation, and ID projections across forks and queued messages. Existing coverage retains queue/restart recovery, context isolation, sandbox restoration, browser ownership, retrieval, and document checks.

Rendered English prompts, including `Model: GPT-6 Astra`, are byte-identical: 3,621 characters without browsing and 4,133 with browsing. Registered bot-tool descriptions, schemas, and execution modes also match the baseline. The image extension schema, models, and low reasoning are unchanged.

Both existing live smoke checks passed using disposable resources: E2B pause/resume, workspace and immutable export persistence, toolbox/Office rendering and website publication; Browser Use Office rendering, explicit stop, cookie restoration, and reopen. Telegram-mediated recovery is covered by automated tests; the live sandbox smoke did not perform real Telegram transfers.

## Live CAD observations

One isolated cold/warm pair ran on each provider for each version, with real inference and E2B and mocked Telegram delivery. Warm runs retain the sandbox but clear artifacts and start a new Pi session. Providers ran concurrently; versions ran sequentially within each provider. Current runs also overlapped isolated sandbox/browser smoke checks.

| Backend | Temperature | Baseline | After |
| --- | --- | ---: | ---: |
| Codex | Cold | 59.961 s | 81.473 s |
| Codex | Warm | 57.458 s | 60.313 s |
| OpenRouter | Cold | 54.321 s | 53.811 s |
| OpenRouter | Warm | 47.941 s | 50.015 s |

All eight runs completed four cycles, both inspections, ordered text/STL/photo delivery, zero file reloads, and reservations within 40 MiB. The slower Codex cold run spent 35.466 seconds in its first `bash` call versus 15.480 seconds before; total model time was similar (27.670 versus 27.300 seconds). The logs do not isolate the cause of that command delay. These single pairs do **not** establish live latency parity or a speedup. Deterministic delivery work and overlap are unchanged; model-generated scripts, caching, and remote execution timing vary. Mocked delivery excludes Telegram network latency.

[Raw measurements and scenario results](benchmarks/simplification-2.0.5.json) include per-cycle timings, cache usage, peak context, buffer reservations, visibility scopes, and contract hashes. Live checks use [benchmark-harness.ts](../scripts/benchmark-harness.ts) with `--runs 1`; its `--repo` option supports the baseline checkout.
