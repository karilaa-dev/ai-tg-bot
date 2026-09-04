# Harness changes in 2.0.5

The approved changes are implemented with GPT-6 Astra and low reasoning unchanged. The core prompt supplies only the selected model's full display name (`Model: GPT-6 Astra`), following the identity clarification. Provider selection remains in diagnostic logs.

## Findings from the supplied trace

The supplied turn took 62.936 seconds across eight model cycles and seven tool calls. Approximately 36.9 seconds were spent in model cycles and 22.7 seconds in tools. Two separate inspection calls and two separate file-export calls required extra model round trips. Sandbox creation and toolbox validation accounted for about 1.8 seconds.

The reported 64,700 tokens were cumulative across all eight requests; the peak request context was 9,757 tokens. Cache reads accounted for 82.7% of input. The empty final text was intentional: the PNG caption carried the explanation. No tool error occurred in this trace.

## Prompt and runtime

| Browsing | Core, 2.0.4 → 2.0.5 | Core plus bot adapter schemas, 2.0.4 → 2.0.5 |
| --- | ---: | ---: |
| Disabled | 7,297 → 3,621 characters | 16,441 → 13,433 characters |
| Enabled | 9,110 → 4,133 characters | 25,676 → 21,367 characters |

The current core measurements include model identity. The unchanged skill catalog, approved `read` definition, and image-generation definition are excluded from both sides of the schema comparison. Tests cap the core at 4,500 characters with browsing enabled and disabled and check retained behavior. Identity is added to a cloned context at each provider request boundary, including fallback and helper requests; it never accumulates in persistent history.

`bash.inspect_images` returns successful command output and up to four inspected workspace images together. Inspection failures preserve command results and direct the agent to retry inspection alone. `finish_response` reserves queue capacity before two preparation workers start, retains successful files after partial failures, and commits attachments in requested order. A successful call persists final text and terminates Pi inference. A mixed terminal tool batch is blocked before any tool runs. Saved assistant responses reference the terminal result entry so forks retain a complete exchange.

The outgoing cache, export reservations, prefetch, and uploads share a 40 MiB budget per turn. Exports retain immutable E2B sources; browser and generated images can spill to private temporary files until delivery. Final text precedes ordered attachments. Only adjacent compatible files form albums, within [Telegram's media-group limits](https://core.telegram.org/bots/api#sendmediagroup). Preparation overlaps text delivery and the previous upload. Ambiguous outcomes are recorded without an extra retry at the delivery layer.

Accepted-message visibility is reused across prompt, retrieval, and context preparation while source recoverability remains current. Failures are recognized from status, exit code, timeout, and error fields. Ordinary snapshot scans are throttled to once per minute, exports retain forced checks, duplicate timeout updates are removed, and stdout/stderr reads run concurrently. Logs include model-cycle latency, cache usage, peak context, preparation latency, and delivery milestones.

## Live benchmark

Each version was tested with three cold and three warm CAD runs on each provider: 24 runs total. Every run used the supplied tube-adapter request, GPT-6 Astra, low reasoning, real inference, and real E2B execution. Telegram calls were mocked. All runs used isolated databases, sessions, and sandbox namespaces; existing bot mappings were untouched.

A cold run starts a new sandbox. Its paired warm run keeps that sandbox but clears the workspace and starts a fresh Pi session with no visible message or file history. Provider cache state cannot be reset. The two providers ran concurrently, with baseline and current versions measured sequentially within each provider. The first baseline cold run overlapped the image build; one current cold run overlapped a live release check. These activities were in separate sandboxes. Raw results and all per-cycle timings are in [the benchmark data](benchmarks/harness-2.0.5.json); the reproducible driver is [benchmark-harness.ts](../scripts/benchmark-harness.ts).

| Provider | Sandbox | Baseline median | Current median | Reduction |
| --- | --- | ---: | ---: | ---: |
| Codex | cold | 79.5s | 66.1s | 16.9% |
| Codex | warm | 64.9s | 62.7s | 3.3% |
| OpenRouter | cold | 60.4s | 54.5s | 9.7% |
| OpenRouter | warm | 58.8s | 48.5s | 17.5% |

Across all six samples per provider, median total time fell from 73.3s to 64.4s on Codex (12.1%) and from 59.6s to 49.3s on OpenRouter (17.4%). Every baseline run used eight model cycles; every current run used four. All 24 runs completed both visual inspections and delivered one STL plus the final photo. All 12 current runs reused the exported bytes with zero file reloads during delivery, and all stayed within the outgoing buffer budget.

| Provider | Median cumulative model time | Median peak request context |
| --- | ---: | ---: |
| Codex | 39.9s → 31.9s | 9,679 → 8,369 |
| OpenRouter | 27.8s → 20.9s | 9,858 → 8,422 |

These are small samples with variable inference latency and model-selected mesh detail, so the timings are observations rather than a speed guarantee. STL sizes varied from 4.2 to 16.5 MB. Mocked Telegram delivery excludes real upload latency. The deterministic improvements are the four-cycle workflow, smaller prompt, ordered overlap, and removal of duplicate file reloads.

## Validation and release

- Typecheck and build passed.
- Full suite: 432 tests passed; one existing test skipped.
- Regression coverage includes fallback/helper/custom model identity, prompt limits, four real Pi model cycles with mocked inference, both vision results, terminal persistence and forks, capacity reservation, replacement and repair ordering, two-worker overlap, memory limits, albums, cancellation, ambiguous outcomes, visibility isolation, failure budgets, retrieval, and document checks.
- `npm run e2b:release` built and validated `ai-tg-bot-tools:v2.0.5`, including the live E2B/Office smoke. A final run reused the immutable tag and passed the smoke again. Build ID: `85e6fa7e-576c-47bd-86fe-75964500481c`.
- Both package files were bumped once to `2.0.5`; current version examples and assertions were updated.
